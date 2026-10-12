import type { NetworkPolicy } from "./network/policy.ts";
export type {
  NetworkPolicy,
  NetworkPolicyRule,
  NetworkPolicyMatcher,
} from "./network/policy.ts";
export type SandboxStatus =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";
export interface Resources {
  vcpus?: number;
  memoryMb?: number;
  diskMb?: number;
}
export interface Mount {
  driveId: string;
  mode?: "read-write" | "snapshot";
  readOnly?: boolean;
  overlay?: boolean;
  overlaySizeBytes?: number;
}
export interface CredentialPolicy {
  source: { env: string };
  inject: Array<{ hosts: string[]; as: { header: string; format: string } }>;
}
export type CredentialPolicies = Record<string, CredentialPolicy>;
export type Source =
  | {
      type: "git";
      url: string;
      revision?: string;
      depth?: number;
      username?: string;
      password?: string;
    }
  | { type: "tarball"; url: string }
  | { type: "snapshot"; snapshotId: string };
export interface CreateOptions {
  name?: string;
  image?: string;
  runtime?: string;
  resources?: Resources;
  timeout?: number;
  ports?: number[];
  persistent?: boolean;
  networkPolicy?: NetworkPolicy;
  env?: Record<string, string>;
  credentials?: CredentialPolicies;
  credentialSecrets?: Record<string, string>;
  tags?: Record<string, string>;
  source?: Source;
  mounts?: Record<string, Mount>;
  snapshotExpiration?: number;
  keepLastSnapshots?: {
    count: number;
    expiration?: number;
    deleteEvicted?: boolean;
  } | null;
}
export interface SandboxRecord {
  sandboxId: string;
  name: string;
  status: SandboxStatus;
  instanceId?: string;
  sessionId?: string;
  sessionConfig?: {
    resources: Required<Resources>;
    mounts: Record<string, Mount>;
    env: Record<string, string>;
  };
  image: string;
  runtime?: string;
  resources: Required<Resources>;
  timeout: number;
  persistent: boolean;
  networkPolicy: NetworkPolicy;
  env: Record<string, string>;
  credentials?: CredentialPolicies;
  tags: Record<string, string>;
  ports: number[];
  routes: Array<{ port: number; url: string }>;
  mounts: Record<string, Mount>;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  stoppedAt?: number;
  deadline?: number;
  snapshotId?: string;
  snapshotPending?: boolean;
  pendingSnapshotId?: string;
  error?: string;
  snapshotExpiration: number;
  keepLastSnapshots: {
    count: number;
    expiration?: number;
    deleteEvicted?: boolean;
  } | null;
}
export interface SessionRecord {
  sessionId: string;
  sandboxId: string;
  status: SandboxStatus;
  startedAt: number;
  stoppedAt?: number;
  timeout: number;
  resources?: Required<Resources>;
}
export interface ExecOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  user?: string;
  detached?: boolean;
  stdin?: boolean;
  timeoutMs?: number;
}
export interface CommandRecord {
  commandId: string;
  sandboxId: string;
  sessionId: string;
  cmd: string;
  args: string[];
  cwd: string;
  status: "running" | "exited" | "failed";
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  error?: { code: string; message: string };
  truncated?: boolean;
}
export interface LogRecord {
  sequence: number;
  stream: "stdout" | "stderr";
  data: string;
  timestamp: number;
}
export interface SnapshotRecord {
  snapshotId: string;
  nativeId: string;
  sandboxId: string;
  name: string;
  createdAt: number;
  expiresAt: number | null;
  expiration?: number;
  sizeBytes?: number;
  parentId?: string;
  config: CreateOptions;
  status?: "creating" | "ready" | "failed";
  sourceInstanceId?: string;
  sourceSessionId?: string;
  updatedAt?: number;
  error?: string;
}
export interface DriveRecord {
  driveId: string;
  nativeId: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt?: number;
  parentDriveId?: string;
  rootDriveId?: string;
  currentSessionId?: string;
  currentSandboxName?: string;
  immutable?: boolean;
  sourceDriveId?: string;
  reservationSandboxId?: string;
  status?: "creating" | "ready" | "failed";
  error?: string;
}
export interface SnapshotTreeNode {
  snapshot: SnapshotRecord;
  siblings: SnapshotRecord[];
  count: string;
}
export interface SnapshotTreePage extends Page<SnapshotTreeNode> {
  anchor: SnapshotTreeNode;
}
export interface ListOptions {
  limit?: number;
  cursor?: string;
  namePrefix?: string;
  name?: string;
  sortOrder?: "asc" | "desc";
  sortBy?: "createdAt" | "updatedAt" | "statusUpdatedAt" | "name";
  tags?: Record<string, string>;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface Capabilities {
  backend: "hypeman" | "test";
  snapshots: boolean;
  volumes: boolean;
  terminal: boolean;
  networkPolicies: Array<"allow-all" | "deny-all">;
  liveNetworkPolicy: boolean;
  credentialBrokering: boolean;
  [key: string]: unknown;
}
