import { Context, Effect, Schema } from "effect";

export type SpawnRequest = {
  readonly name: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly closeOnExit: boolean;
};

export type SpawnResult = {
  readonly paneId: string;
};

export type ExitResult = {
  readonly paneId: string;
  readonly reason: "process-exited" | "pane-closed";
};

export class MuxError extends Schema.TaggedError<MuxError>()("MuxError", {
  mux: Schema.String,
  message: Schema.String,
  code: Schema.optional(Schema.String),
}) {}

export class Mux extends Context.Service<
  Mux,
  {
    readonly id: string;
    readonly spawn: (request: SpawnRequest) => Effect.Effect<SpawnResult, MuxError>;
    readonly waitForExit: (
      paneId: string,
      signal: AbortSignal,
    ) => Effect.Effect<ExitResult, MuxError>;
    readonly sendInput: (paneId: string, text: string) => Effect.Effect<void, MuxError>;
  }
>()("pi/subagents/mux/Mux") {}
