import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents } from "./agents.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "subagent-test-"));
  temporaryDirectories.push(value);
  return value;
}

function agentFile(directoryPath: string, name: string, prompt: string, extra = ""): void {
  writeFileSync(
    join(directoryPath, `${name}.md`),
    `---\nname: ${name}\ndescription: test\ntools: [read, grep]\n${extra}---\n${prompt}\n`,
  );
}

describe("discoverAgents", () => {
  it("parses YAML frontmatter and finds the nearest project directory", () => {
    const root = directory();
    const nested = join(root, "one", "two");
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = join(root, ".pi", "agent");
    mkdirSync(join(root, ".pi", "agent", "agents"), { recursive: true });
    agentFile(join(root, ".pi", "agent", "agents"), "same", "global");
    agentFile(join(root, ".pi", "agents"), "same", "project", "subagent_agents: [helper]\n");

    const agents = discoverAgents(nested);
    assert.deepEqual(
      agents.map(({ name, source, prompt, subagentAgents }) => ({
        name,
        source,
        prompt,
        subagentAgents,
      })),
      [{ name: "same", source: "project", prompt: "project", subagentAgents: ["helper"] }],
    );
  });

  it("ignores malformed and unreadable agent files", () => {
    const root = directory();
    const agents = join(root, "agents");
    mkdirSync(agents, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = root;
    writeFileSync(join(agents, "bad.md"), "---\nname: [broken\n---\nnope");
    writeFileSync(join(agents, "empty.md"), "---\nname: empty\n---\n");
    assert.deepEqual(discoverAgents(root), []);
    assert.doesNotThrow(() => discoverAgents(join(root, "missing")));
  });

  it("can exclude project agents", () => {
    const root = directory();
    const project = join(root, ".pi", "agents");
    mkdirSync(project, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = join(root, ".pi", "agent");
    mkdirSync(join(root, ".pi", "agent", "agents"), { recursive: true });
    agentFile(join(root, ".pi", "agent", "agents"), "global", "user");
    agentFile(project, "project", "project");

    assert.deepEqual(
      discoverAgents(root, { includeProject: false }).map((agent) => agent.name),
      ["global"],
    );
  });
});
