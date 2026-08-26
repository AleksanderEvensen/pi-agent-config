import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import {
  boundedOutput,
  decodeJsonlChunks,
  effectiveSubagentAgents,
  rpcFailure,
} from "./process.ts";

test("decodes split UTF-8 and LF-framed JSONL", () => {
  const bytes = Buffer.from('{"text":"🙂"}\n{"ok":true}\n', "utf8");
  const lines = decodeJsonlChunks([bytes.subarray(0, 8), bytes.subarray(8)]);
  assert.deepEqual(lines, ['{"text":"🙂"}', '{"ok":true}']);
});

test("flushes the final JSONL record when the stream ends", () => {
  assert.deepEqual(decodeJsonlChunks([Buffer.from('{"ok":true}', "utf8")]), ['{"ok":true}']);
});

test("recognizes rejected prompts and terminal assistant errors", () => {
  assert.equal(
    rpcFailure({ type: "response", command: "prompt", success: false, error: "No model" }),
    "No model",
  );
  assert.equal(
    rpcFailure({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "Rate limited" },
    }),
    "Rate limited",
  );
  assert.equal(
    rpcFailure({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }),
    undefined,
  );
});

test("nested delegation cannot widen an inherited allowlist", () => {
  assert.deepEqual(effectiveSubagentAgents(["scout", "worker"], "scout,researcher"), ["scout"]);
  assert.deepEqual(effectiveSubagentAgents(["worker"], ""), []);
});

test("bounds large output and preserves the full text in a secure temp file", () => {
  const original = "🙂".repeat(30_000);
  const output = boundedOutput(original);
  assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
  const path = output.match(/Full output saved to: (.+)]$/)?.[1];
  assert.ok(path);
  assert.equal(readFileSync(path, "utf8"), original);
  rmSync(dirname(path), { recursive: true, force: true });
});
