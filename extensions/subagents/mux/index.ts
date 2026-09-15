import { Context, Effect, Layer, Option, Schema } from "effect";
import { makeHerdrLayer } from "./herdr.ts";

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

export class MuxError extends Schema.TaggedError<MuxError>()("MuxError", {
  mux: Schema.String,
  message: Schema.String,
}) {}

export class Mux extends Context.Service<
  Mux,
  {
    readonly id: string;
    readonly spawn: (request: SpawnRequest) => Effect.Effect<SpawnResult, MuxError>;
  }
>()("pi/subagents/mux/Mux") {}

/** Return the implementation for the mux hosting this Pi process. */
export function detectMux(): Option.Option<Layer.Layer<Mux>> {
  if (process.env.HERDR_ENV === "1" && process.env.HERDR_SOCKET_PATH && process.env.HERDR_PANE_ID) {
    return Option.some(makeHerdrLayer());
  }

  return Option.none();
}
