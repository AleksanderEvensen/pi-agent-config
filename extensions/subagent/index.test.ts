import assert from "node:assert/strict";
import test from "node:test";
import { validateAction } from "./index.ts";

test("validates each action-specific input shape", () => {
  assert.deepEqual(validateAction({ action: "spawn", agent: "worker", task: "Fix it" }), {
    action: "spawn",
    agent: "worker",
    task: "Fix it",
  });
  assert.deepEqual(
    validateAction({ action: "spawn", agent: "worker", task: "Fix it", cwd: "@src" }),
    {
      action: "spawn",
      agent: "worker",
      task: "Fix it",
      cwd: "src",
    },
  );
  assert.deepEqual(validateAction({ action: "wait", id: "worker-1" }), {
    action: "wait",
    id: "worker-1",
  });
  assert.deepEqual(validateAction({ action: "steer", id: "worker-1", message: "Stop" }), {
    action: "steer",
    id: "worker-1",
    message: "Stop",
  });
});

test("rejects missing action-specific fields and an empty normalized cwd", () => {
  assert.throws(() => validateAction({ action: "spawn", task: "Fix it" }), /agent/);
  assert.throws(() => validateAction({ action: "wait" }), /id/);
  assert.throws(() => validateAction({ action: "steer", id: "worker-1" }), /message/);
  assert.throws(
    () => validateAction({ action: "spawn", agent: "worker", task: "Fix it", cwd: "@" }),
    /cwd/,
  );
});
