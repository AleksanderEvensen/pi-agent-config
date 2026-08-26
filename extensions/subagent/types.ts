import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const actionSchema = Type.Object({
  action: StringEnum(["spawn", "wait", "steer"], {
    description: "Action to perform",
  }),
  agent: Type.Optional(
    Type.String({ description: "Agent name from the available agent definitions" }),
  ),
  task: Type.Optional(Type.String({ description: "Complete, self-contained task for the agent" })),
  cwd: Type.Optional(
    Type.String({ description: "Working directory; defaults to the master's cwd" }),
  ),
  id: Type.Optional(Type.String({ description: "Human-readable agent id returned by spawn" })),
  message: Type.Optional(Type.String({ description: "New direction for the running agent" })),
});

export type Action = Static<typeof actionSchema>;
export type AgentStatus = "running" | "completed" | "failed";
export type ToolStatus = "running" | "done" | "failed";

export type AgentDefinition = {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinking?: string;
  /** Agent names this child may delegate to. Presence enables the subagent tool. */
  subagentAgents?: string[];
  prompt: string;
  source: "user" | "project";
};

export type ToolActivity = {
  tool: string;
  args: string;
  toolCallId?: string;
  status: ToolStatus;
};

export type AgentUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
};

export type AgentSnapshot = {
  id: string;
  agent: string;
  status: AgentStatus;
  transcript: string[];
  toolCount: number;
  durationMs: number;
  usage: AgentUsage;
  lastMessage?: string;
  output?: string;
  error?: string;
};

export type AgentUpdate = (snapshot: AgentSnapshot) => void;

export type WaitOutcome =
  | { kind: "finished"; output: string }
  | { kind: "released"; reason: "pending_message" | "aborted" }
  | { kind: "failed"; error: unknown };

export type RunningAgent = {
  id: string;
  definition: AgentDefinition;
  process: ChildProcessWithoutNullStreams;
  output: string;
  error?: string;
  status: AgentStatus;
  transcript: ToolActivity[];
  listeners: Set<AgentUpdate>;
  toolCount: number;
  startedAt: number;
  lastMessage?: string;
  usage: AgentUsage;
  waiting: boolean;
  notified: boolean;
  collected: boolean;
  reattachmentQueued: boolean;
  done: Promise<string>;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
};
