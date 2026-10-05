import assert from "node:assert/strict";
import test from "node:test";
import { Effect, FileSystem, PlatformError } from "effect";
import { loadMcpConfig } from "./index.ts";

const load = (raw: string) =>
  Effect.runPromise(
    loadMcpConfig("/project/.mcp.json").pipe(
      Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(raw) })),
    ),
  );

test("loads and preserves stdio and HTTP settings", async () => {
  const mcpServers = {
    filesystem: { command: "npx", args: ["-y", "filesystem"], env: { KEY: "${KEY}" }, cwd: "." },
    docs: {
      type: "streamable-http",
      url: "https://example.test/mcp",
      exposure: "direct",
      headers: { X: "value" },
      oauth: { clientId: "id", callbackPort: 8765 },
      toolExposure: { search: "hidden" },
      timeout: 30,
      enabled: false,
    },
  };

  const result = await load(JSON.stringify({ mcpServers }));

  assert.deepEqual(
    result.servers,
    Object.entries(mcpServers).map(([name, config]) => ({ name, config })),
  );
  assert.deepEqual(result.skipped, []);
});

test("schema rejects malformed entries without dropping valid siblings", async () => {
  const invalid = {
    missingTransport: {},
    nullEntry: null,
    arrayEntry: [],
    badArgs: { command: "server", args: [1] },
    badEnv: { command: "server", env: { KEY: 1 } },
    badTimeout: { command: "server", timeout: -1 },
    badType: { type: "sse", url: "https://example.test" },
    badUrl: { url: "file:///tmp/test" },
    badHeaders: { url: "https://example.test", headers: { X: false } },
    badOAuth: { url: "https://example.test", oauth: { callbackPort: 65536 } },
    badExposure: { command: "server", toolExposure: { tool: "invalid" } },
    credentials: { url: "https://example.test", auth: { provider: "openai" } },
    ambiguous: { command: "server", url: "https://example.test" },
    "invalid name": { command: "server" },
    emptyCommand: { command: "" },
  };

  const result = await load(
    JSON.stringify({ mcpServers: { valid: { command: "server" }, ...invalid } }),
  );

  assert.deepEqual(
    result.servers.map(({ name }) => name),
    ["valid"],
  );
  assert.deepEqual(
    result.skipped.map(({ name }) => name),
    Object.keys(invalid),
  );
  assert.ok(result.skipped.every(({ reason }) => reason.length > 0));
});

test("rejects malformed JSON and invalid file shapes", async () => {
  for (const raw of ["{", "null", "[]", "{}", '{"mcpServers":[]}']) {
    await assert.rejects(load(raw));
  }
});

test("ignores missing files but preserves other filesystem errors", async () => {
  for (const tag of ["NotFound", "PermissionDenied"] as const) {
    const error = PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "readFileString",
    });

    const result = Effect.runPromise(
      loadMcpConfig("/project/.mcp.json").pipe(
        Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.fail(error) })),
      ),
    );

    if (tag === "NotFound") assert.deepEqual(await result, { servers: [], skipped: [] });
    else await assert.rejects(result, /PermissionDenied/);
  }
});
