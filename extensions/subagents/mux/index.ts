import { Layer, Option } from "effect";
import { makeHerdrLayer } from "./herdr.ts";
import { Mux } from "./service.ts";

export { Mux, MuxError, type SpawnRequest, type SpawnResult } from "./service.ts";

/** Return the implementation for the mux hosting this Pi process. */
export function detectMux(): Option.Option<Layer.Layer<Mux>> {
  if (process.env.HERDR_ENV === "1" && process.env.HERDR_SOCKET_PATH && process.env.HERDR_PANE_ID) {
    return Option.some(makeHerdrLayer());
  }

  return Option.none();
}
