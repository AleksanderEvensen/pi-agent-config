import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexAuth } from "./codex-usage.ts";

type AuthContext = Parameters<typeof resolveCodexAuth>[0];

test("resolves provider auth without trying an unrelated active provider", async () => {
  const requested: string[] = [];
  const context = {
    model: { provider: "anthropic" },
    modelRegistry: {
      async getProviderAuth(provider: string) {
        requested.push(provider);
        return provider === "openai-codex"
          ? { auth: { apiKey: "codex-token", headers: { "ChatGPT-Account-Id": "account" } } }
          : undefined;
      },
    },
  } as unknown as AuthContext;

  assert.deepEqual(await resolveCodexAuth(context), {
    auth: { apiKey: "codex-token", headers: { "ChatGPT-Account-Id": "account" } },
  });
  assert.deepEqual(requested, ["openai-codex"]);
});
