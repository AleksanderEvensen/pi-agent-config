import { NodeServices } from "@effect/platform-node";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

export type AgentConfig = {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly systemPromptMode: "replace" | "append";
  readonly systemPrompt: string;
  readonly autoExit: boolean;
  readonly filePath: string;
};

const AgentFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  tools: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(
    Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  ),
  "system-prompt": Schema.optionalKey(Schema.Literals(["replace", "append"])),
  "auto-exit": Schema.optionalKey(Schema.Boolean),
});

function toolNames(value: string | readonly string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.map((value) => value.trim()).filter(Boolean);
}

const loadAgent = Effect.fn("AgentDiscovery.loadAgent")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs.readFileString(filePath);
  const parsed = yield* Effect.try({
    try: () => parseFrontmatter<Record<string, unknown>>(content),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
  const frontmatter = yield* Schema.decodeUnknownEffect(AgentFrontmatter)(parsed.frontmatter);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: toolNames(frontmatter.tools),
    model: frontmatter.model,
    thinking: frontmatter.thinking,
    systemPromptMode: frontmatter["system-prompt"] ?? "append",
    systemPrompt: parsed.body.trim(),
    autoExit: frontmatter["auto-exit"] ?? false,
    filePath,
  } satisfies AgentConfig;
});

const loadDirectory = Effect.fn("AgentDiscovery.loadDirectory")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])));
  const loaded = yield* Effect.forEach(
    entries.filter((entry) => entry.endsWith(".md")),
    (entry) => Effect.option(loadAgent(path.join(directory, entry))),
    { concurrency: "unbounded" },
  );
  return loaded.filter(Option.isSome).map((agent) => agent.value);
});

const nearestProjectAgentDirectory = Effect.fn("AgentDiscovery.nearestProjectAgentDirectory")(
  function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let directory = cwd;

    while (true) {
      const candidate = path.join(directory, CONFIG_DIR_NAME, "agents");
      const info = yield* Effect.option(fs.stat(candidate));
      if (Option.isSome(info) && info.value.type === "Directory") return Option.some(candidate);

      const parent = path.dirname(directory);
      if (parent === directory) return Option.none<string>();
      directory = parent;
    }
  },
);

export class AgentDiscovery extends Context.Service<
  AgentDiscovery,
  {
    readonly discover: (
      cwd: string,
      includeProjectAgents: boolean,
    ) => Effect.Effect<readonly AgentConfig[]>;
  }
>()("pi/subagents/AgentDiscovery") {}

export const AgentDiscoveryLayer = Layer.effect(
  AgentDiscovery,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const discoverLive = Effect.fn("AgentDiscovery.discoverLive")(function* (
      cwd: string,
      includeProjectAgents: boolean,
    ) {
      const globalAgents = yield* loadDirectory(path.join(getAgentDir(), "agents"));
      const agents = new Map(globalAgents.map((agent) => [agent.name, agent]));

      if (includeProjectAgents) {
        const projectDirectory = yield* nearestProjectAgentDirectory(cwd);
        if (Option.isSome(projectDirectory)) {
          for (const agent of yield* loadDirectory(projectDirectory.value)) {
            agents.set(agent.name, agent);
          }
        }
      }

      return [...agents.values()];
    });

    const discover: AgentDiscovery["Service"]["discover"] = (cwd, includeProjectAgents) =>
      discoverLive(cwd, includeProjectAgents).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    return AgentDiscovery.of({ discover });
  }),
);

export const AgentDiscoveryLive = AgentDiscoveryLayer.pipe(Layer.provide(NodeServices.layer));

export const discoverAgents = Effect.fn("AgentDiscovery.discover")(function* (
  cwd: string,
  includeProjectAgents: boolean,
) {
  const discovery = yield* AgentDiscovery;
  return yield* discovery.discover(cwd, includeProjectAgents);
});
