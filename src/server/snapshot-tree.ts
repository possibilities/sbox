import { invariant } from "../errors.ts";
import type {
  SnapshotRecord,
  SnapshotTreeNode,
  SnapshotTreePage,
} from "../types.ts";

/** Traversal is computed from retained records; deleted ancestors end a branch. */
export function snapshotTree(
  records: SnapshotRecord[],
  options: {
    snapshotId: string;
    sortOrder?: "asc" | "desc";
    limit?: number;
    cursor?: string;
  },
): SnapshotTreePage {
  const limit = options.limit ?? 100;
  invariant(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000,
    "INVALID_ARGUMENT",
    "limit must be an integer between 1 and 1000",
  );
  invariant(
    options.sortOrder === undefined ||
      options.sortOrder === "asc" ||
      options.sortOrder === "desc",
    "INVALID_ARGUMENT",
    "sortOrder must be asc or desc",
  );
  const byId = new Map(records.map((record) => [record.snapshotId, record]));
  const anchor = byId.get(options.snapshotId);
  invariant(
    anchor,
    "NOT_FOUND",
    `Snapshot ${options.snapshotId} not found`,
    404,
  );
  const children = new Map<string, SnapshotRecord[]>();
  for (const record of records)
    if (record.parentId) {
      const siblings = children.get(record.parentId) ?? [];
      siblings.push(record);
      children.set(record.parentId, siblings);
    }
  for (const siblings of children.values())
    siblings.sort(
      (a, b) =>
        a.createdAt - b.createdAt || a.snapshotId.localeCompare(b.snapshotId),
    );
  const node = (record: SnapshotRecord): SnapshotTreeNode => {
    const siblings = record.parentId
      ? (children.get(record.parentId) ?? [record])
      : [record];
    return {
      snapshot: record,
      siblings: siblings.filter(
        (other) => other.snapshotId !== record.snapshotId,
      ),
      count: String(siblings.length),
    };
  };
  const ordered: SnapshotRecord[] = [];
  const seen = new Set([anchor.snapshotId]);
  if (options.sortOrder === "asc") {
    const queue = [...(children.get(anchor.snapshotId) ?? [])];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      invariant(
        !seen.has(current.snapshotId),
        "INVALID_SNAPSHOT_GRAPH",
        "Snapshot ancestry contains a cycle",
        500,
      );
      seen.add(current.snapshotId);
      ordered.push(current);
      queue.push(...(children.get(current.snapshotId) ?? []));
    }
  } else {
    let parent = anchor.parentId;
    while (parent) {
      invariant(
        !seen.has(parent),
        "INVALID_SNAPSHOT_GRAPH",
        "Snapshot ancestry contains a cycle",
        500,
      );
      seen.add(parent);
      const current = byId.get(parent);
      if (!current) break;
      ordered.push(current);
      parent = current.parentId;
    }
  }
  let offset = 0;
  if (options.cursor) {
    try {
      const cursor = JSON.parse(
        Buffer.from(options.cursor, "base64url").toString(),
      );
      invariant(
        cursor.anchor === anchor.snapshotId &&
          cursor.direction === (options.sortOrder ?? "desc"),
        "INVALID_CURSOR",
        "Cursor belongs to a different tree traversal",
      );
      offset = cursor.offset;
    } catch {
      invariant(false, "INVALID_CURSOR", "Invalid snapshot tree cursor");
    }
    invariant(
      Number.isSafeInteger(offset) && offset >= 0,
      "INVALID_CURSOR",
      "Invalid snapshot tree cursor offset",
    );
  }
  const next = offset + limit;
  return {
    anchor: node(anchor),
    items: ordered.slice(offset, next).map(node),
    nextCursor:
      next < ordered.length
        ? Buffer.from(
            JSON.stringify({
              anchor: anchor.snapshotId,
              direction: options.sortOrder ?? "desc",
              offset: next,
            }),
          ).toString("base64url")
        : null,
  };
}
