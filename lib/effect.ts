import { NodeFileSystem, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";

/** Live Node.js services used by extensions that access the local filesystem. */
export const NodeFileSystemLayer = NodeFileSystem.layer;
export const NodeServicesLayer = NodeServices.layer;

/** Run an effect with the standard Node.js filesystem and path services. */
export const runWithNodeServices = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServicesLayer)));

/** Parse and validate JSON at an Effect boundary. */
export const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  raw: string,
): Effect.Effect<S["Type"], Error | Schema.SchemaError, S["DecodingServices"]> =>
  Effect.try({
    try: () => JSON.parse(raw),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
