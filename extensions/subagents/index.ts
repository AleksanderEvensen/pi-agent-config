import { NodeFileSystem } from "@effect/platform-node";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { AgentDiscoveryLive, discoverAgents, type AgentConfig } from "./agents.ts";
import { SubagentResult } from "./agent-extension/index.ts";
import { detectMux, Mux } from "./mux/index.ts";

export const CHILD_EXTENSION_PATH = fileURLToPath(
  new URL("./agent-extension/index.ts", import.meta.url),
);

const SubagentParameters = Type.Object({
  name: Type.String({ description: "Display name for the spawned agent pane" }),
  agent: Type.String({ description: "Agent name from an agent Markdown file" }),
  task: Type.String({ description: "Self-contained task to assign to the agent" }),
});

function piInvocation(args: readonly string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args: [...args] }
    : { command: process.execPath, args: [...args] };
}

export function agentArguments(agent: AgentConfig, name: string, task: string): string[] {
  const args = ["--name", name, "--no-session"];
  if (agent.autoExit) args.push("--extension", CHILD_EXTENSION_PATH);
  if (agent.model) args.push("--model", agent.model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  if (agent.systemPrompt) {
    args.push(
      agent.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      agent.systemPrompt,
    );
  }
  args.push("--", task);
  return args;
}

export const watchSubagentResult = Effect.fn("Subagents.watchResult")(function* (
  resultPath: string,
  signal: AbortSignal,
) {
  const fs = yield* FileSystem.FileSystem;
  while (!signal.aborted) {
    if (yield* fs.exists(resultPath)) {
      const result = yield* Schema.decodeUnknownEffect(SubagentResult)(
        JSON.parse(yield* fs.readFileString(resultPath)),
      );
      yield* fs.remove(resultPath).pipe(Effect.ignore);
      return result;
    }
    yield* Effect.sleep("250 millis");
  }
  return yield* Effect.fail(new Error("Subagent result watcher was cancelled"));
});

function registerSubagentTool(
  pi: ExtensionAPI,
  muxLayer: Layer.Layer<Mux>,
  agents: readonly AgentConfig[],
  watchers: Set<AbortController>,
): void {
  const agentHints = agents.map(({ name, description }) => `${name}: ${description}`).join("; ");

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Spawn a named specialist agent in a new split pane. The call returns after the pane and agent process start; work continues independently.",
      agentHints ? `Available agents: ${agentHints}` : "No agents are currently configured.",
    ].join(" "),
    parameters: SubagentParameters,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();

      const currentAgents = await Effect.runPromise(
        discoverAgents(ctx.cwd, ctx.isProjectTrusted()).pipe(Effect.provide(AgentDiscoveryLive)),
      );
      const agent = currentAgents.find((candidate) => candidate.name === params.agent);
      if (!agent) {
        const available = currentAgents
          .map(({ name, description }) => `${name}: ${description}`)
          .join("; ");
        throw new Error(
          `Unknown agent ${JSON.stringify(params.agent)}. Available agents: ${available || "none"}`,
        );
      }

      const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
      const missingTools = agent.tools.filter((tool) => !availableTools.has(tool));
      if (missingTools.length > 0) {
        throw new Error(
          `Agent ${JSON.stringify(agent.name)} requests unavailable tools: ${missingTools.join(", ")}`,
        );
      }

      const invocation = piInvocation(agentArguments(agent, params.name, params.task));
      const resultPath = join(tmpdir(), `pi-subagent-result-${randomUUID()}.json`);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const mux = yield* Mux;
          return yield* mux.spawn({
            name: params.name,
            cwd: ctx.cwd,
            command: invocation.command,
            args: invocation.args,
            environment: { PI_SUBAGENT_RESULT_PATH: resultPath },
            closeOnExit: agent.autoExit,
          });
        }).pipe(Effect.provide(muxLayer)),
      );

      const watcher = new AbortController();
      watchers.add(watcher);
      void Effect.runPromise(
        watchSubagentResult(resultPath, watcher.signal).pipe(Effect.provide(NodeFileSystem.layer)),
      )
        .then((childResult) => {
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: `Subagent ${JSON.stringify(params.name)} ${childResult.isError ? "failed" : "finished"}:\n\n${childResult.text}`,
              display: true,
              details: {
                paneId: result.paneId,
                agent: agent.name,
                name: params.name,
                isError: childResult.isError,
              },
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        })
        .catch((error: unknown) => {
          if (watcher.signal.aborted) return;
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: `Could not read the result from subagent ${JSON.stringify(params.name)}: ${error instanceof Error ? error.message : String(error)}`,
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        })
        .finally(() => watchers.delete(watcher));

      return {
        content: [
          {
            type: "text",
            text: `Spawned ${params.name} (${agent.name}) in ${result.paneId}. Its result will be delivered automatically.`,
          },
        ],
        details: {
          paneId: result.paneId,
          mux: "herdr",
          agent: agent.name,
          name: params.name,
          autoExit: agent.autoExit,
        },
      };
    },
  });
}

export default function subagents(pi: ExtensionAPI): void {
  const muxLayer = Option.getOrUndefined(detectMux());
  if (!muxLayer) return;

  let subagentRegistered = false;
  const watchers = new Set<AbortController>();

  pi.on("session_shutdown", () => {
    for (const watcher of watchers) watcher.abort();
    watchers.clear();
  });

  pi.registerTool({
    name: "list_subagents",
    label: "List Subagents",
    description: "Discover available specialist agents and enable the subagent spawning tool.",
    promptSnippet: "Discover available specialist agents before delegating work",
    promptGuidelines: [
      "Call list_subagents before delegating work, then use the enabled subagent tool with an available agent name.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const agents = await Effect.runPromise(
        discoverAgents(ctx.cwd, ctx.isProjectTrusted()).pipe(Effect.provide(AgentDiscoveryLive)),
      );

      if (!subagentRegistered) {
        registerSubagentTool(pi, muxLayer, agents, watchers);
        subagentRegistered = true;
      }
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "subagent"])]);

      const text =
        agents.length > 0
          ? agents.map(({ name, description }) => `- ${name}: ${description}`).join("\n")
          : "No subagents are configured.";

      return {
        content: [{ type: "text", text }],
        details: {
          agents: agents.map(({ name, description, filePath }) => ({
            name,
            description,
            filePath,
          })),
          subagentEnabled: true,
        },
      };
    },
  });
}
