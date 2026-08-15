import assert from "node:assert/strict";
import test from "node:test";
import { isAnswered } from "./index.ts";

test("a question unlocks review only with a selected or non-empty custom answer", () => {
  assert.equal(isAnswered(undefined), false);
  assert.equal(isAnswered({ selected: new Set(), custom: "  " }), false);
  assert.equal(isAnswered({ selected: new Set([0]) }), true);
  assert.equal(isAnswered({ selected: new Set(), custom: "More context" }), true);
});
