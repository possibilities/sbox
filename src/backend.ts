import type {
  Capabilities,
  CredentialPolicies,
  NetworkPolicy,
  Resources,
} from "./types.ts";

export interface Instance {
  id: string;
  state: string;
  ip?: string;
}
export interface BackendCreate {
  name: string;
  image: string;
  resources: Required<Resources>;
  env: Record<string, string>;
  credentials?: CredentialPolicies;
  credentialSecrets?: Record<string, string>;
  networkPolicy: NetworkPolicy;
  mounts: Array<{
    volumeId: string;
    path: string;
    readOnly: boolean;
    overlay?: boolean;
    overlaySizeBytes?: number;
  }>;
  /** Absolute deadline provides a provider-side safety net if the control plane exits. */
  deadline: number;
}
export interface BackendExec {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  user: string;
  stdin?: boolean;
  timeoutMs?: number;
  tty?: boolean;
  cols?: number;
  rows?: number;
}
export interface Execution {
  output: AsyncIterable<{ stream: "stdout" | "stderr"; data: Uint8Array }>;
  exited: Promise<{ exitCode: number }>;
  write(data: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  kill(signal?: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
}
export interface Backend {
  capabilities(): Promise<Capabilities>;
  create(options: BackendCreate): Promise<Instance>;
  get(id: string): Promise<Instance>;
  start(id: string, deadline?: number): Promise<Instance>;
  stop(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  setDeadline(id: string, deadline: number): Promise<void>;
  rotateCredentials?(
    id: string,
    secrets: Record<string, string>,
  ): Promise<void>;
  exec(id: string, options: BackendExec): Promise<Execution>;
  /** Filesystem-only snapshot; leaves the source stopped. */
  snapshot(
    id: string,
    name: string,
  ): Promise<{ id: string; sizeBytes?: number }>;
  /** Recover an uncertain snapshot POST by its exact source and unique name. */
  findSnapshot?(
    sourceId: string,
    name: string,
  ): Promise<{ id: string; sizeBytes?: number } | null>;
  restore(snapshotId: string, options: BackendCreate): Promise<Instance>;
  deleteSnapshot(id: string): Promise<void>;
  createVolume(name: string, sizeBytes: number): Promise<{ id: string }>;
  cloneVolume?(
    sourceId: string,
    name: string,
    sizeBytes: number,
  ): Promise<{ id: string }>;
  deleteVolume(id: string): Promise<void>;
  /** URL creation is optional; server otherwise provides an authenticated preview proxy. */
  expose?(
    id: string,
    port: number,
    hostname: string,
  ): Promise<{ id: string; url: string }>;
  removeIngress?(id: string): Promise<void>;
}
