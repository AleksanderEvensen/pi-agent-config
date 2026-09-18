import { Schema } from "effect";
import { readFile, rename, writeFile } from "node:fs/promises";

export const SubagentLiveStatus = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Union([
    Schema.Literal("starting"),
    Schema.Literal("active"),
    Schema.Literal("waiting"),
    Schema.Literal("finished"),
    Schema.Literal("failed"),
  ]),
  stage: Schema.String,
  updatedAt: Schema.String,
});

export type SubagentLiveStatus = Schema.Schema.Type<typeof SubagentLiveStatus>;

export type SubagentLiveState = SubagentLiveStatus["state"];

export async function writeSubagentStatus(
  path: string,
  state: SubagentLiveState,
  stage: string,
): Promise<void> {
  const temporaryPath = `${path}.tmp`;

  const status: SubagentLiveStatus = {
    version: 1,
    state,
    stage,
    updatedAt: new Date().toISOString(),
  };

  await writeFile(temporaryPath, JSON.stringify(status), { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function readSubagentStatus(path: string): Promise<SubagentLiveStatus | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));

    return Schema.is(SubagentLiveStatus)(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
