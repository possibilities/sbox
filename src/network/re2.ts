import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import runtimeSource from "re2-wasm/build/wasm/re2.js" with { type: "text" };
import wrapperSource from "re2-wasm/build/src/re2.js" with { type: "text" };
import wasmPath from "re2-wasm/build/wasm/re2.wasm" with { type: "file" };
import type { RE2 as RE2Instance } from "re2-wasm";

// The official package loads re2.wasm relative to __dirname. Bun preserves that
// original build-machine path when compiling an executable. Embed its unchanged
// generated sources and WASM instead, using Emscripten's supported Module input.
const runtimeModule: { exports: Record<string, unknown> } = { exports: {} };
const requireBuiltin = createRequire(import.meta.url);
new Function(
  "Module",
  "module",
  "exports",
  "require",
  "__dirname",
  runtimeSource as unknown as string,
)(
  { wasmBinary: readFileSync(wasmPath) },
  runtimeModule,
  runtimeModule.exports,
  requireBuiltin,
  ".",
);
const wrapperModule: { exports: { RE2?: typeof RE2Instance } } = {
  exports: {},
};
new Function(
  "module",
  "exports",
  "require",
  wrapperSource as unknown as string,
)(wrapperModule, wrapperModule.exports, (id: string) => {
  if (id !== "../wasm/re2")
    throw new Error("Unexpected RE2 runtime dependency");
  return runtimeModule.exports;
});
if (!wrapperModule.exports.RE2)
  throw new Error("RE2 runtime did not initialize");
export const RE2 = wrapperModule.exports.RE2;
export type RE2 = RE2Instance;
