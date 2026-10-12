import { describe, expect, test } from "bun:test";
import { snapshotTree } from "../src/server/snapshot-tree.ts";
import { Snapshot } from "../src/index.ts";
import type { SnapshotRecord } from "../src/types.ts";

function snapshot(
  id: string,
  parentId?: string,
  createdAt = 1,
): SnapshotRecord {
  return {
    snapshotId: id,
    nativeId: id,
    sandboxId: "sandbox",
    name: "test",
    createdAt,
    expiresAt: null,
    parentId,
    config: {},
  };
}
const records = [
  snapshot("root"),
  snapshot("child-a", "root", 2),
  snapshot("child-b", "root", 3),
  snapshot("leaf-a", "child-a", 4),
  snapshot("leaf-b", "child-b", 5),
  snapshot("unrelated"),
];

describe("snapshot ancestry", () => {
  test("ancestors follow parent identity and expose sibling branches", () => {
    const tree = snapshotTree(records, { snapshotId: "leaf-a" });
    expect(tree.anchor.snapshot.snapshotId).toBe("leaf-a");
    expect(tree.items.map((node) => node.snapshot.snapshotId)).toEqual([
      "child-a",
      "root",
    ]);
    expect(tree.items[0]?.siblings.map((s) => s.snapshotId)).toEqual([
      "child-b",
    ]);
    expect(tree.items[0]?.count).toBe("2");
    expect(tree.items[1]?.siblings).toEqual([]);
  });

  test("descendants visit every branch and paginate without the unrelated root", () => {
    const first = snapshotTree(records, {
      snapshotId: "root",
      sortOrder: "asc",
      limit: 2,
    });
    expect(first.items.map((node) => node.snapshot.snapshotId)).toEqual([
      "child-a",
      "child-b",
    ]);
    const second = snapshotTree(records, {
      snapshotId: "root",
      sortOrder: "asc",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((node) => node.snapshot.snapshotId)).toEqual([
      "leaf-a",
      "leaf-b",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(() =>
      snapshotTree(records, {
        snapshotId: "child-a",
        sortOrder: "asc",
        cursor: first.nextCursor!,
      }),
    ).toThrow("Invalid snapshot tree cursor");
  });

  test("deleted ancestors stop traversal, missing anchors and cycles fail", () => {
    expect(
      snapshotTree([snapshot("leaf", "expired")], { snapshotId: "leaf" }).items,
    ).toEqual([]);
    expect(() => snapshotTree(records, { snapshotId: "missing" })).toThrow(
      "not found",
    );
    expect(() =>
      snapshotTree([snapshot("a", "b"), snapshot("b", "a")], {
        snapshotId: "a",
      }),
    ).toThrow("cycle");
    expect(() =>
      snapshotTree(records, { snapshotId: "root", limit: 0 }),
    ).toThrow("limit");
  });

  test("SDK tree preserves anchor and automatically visits descendant pages", async () => {
    const fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = (await new Request(input, init).json()) as {
        method: string;
        params: Parameters<typeof snapshotTree>[1];
      };
      expect(body.method).toBe("snapshot.tree");
      return Response.json({ result: snapshotTree(records, body.params) });
    }) as typeof globalThis.fetch;
    const tree = await Snapshot.tree({
      fetch,
      snapshotId: "root",
      sortOrder: "asc",
      limit: 1,
    });
    expect(tree.anchor.snapshot.snapshotId).toBe("root");
    expect(
      (await tree.toArray()).map((node) => node.snapshot.snapshotId),
    ).toEqual(["child-a", "child-b", "leaf-a", "leaf-b"]);
  });
});
