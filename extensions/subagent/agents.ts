import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./types.ts";

type Frontmatter = Record<string, unknown>;

function stringValue(values: Frontmatter, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  return typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function readAgents(directory: string, source: AgentDefinition["source"]): AgentDefinition[] {
  let files: string[];
  try {
    files = readdirSync(directory)
      .filter((file) => file.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    try {
      const { frontmatter, body } = parseFrontmatter(readFileSync(join(directory, file), "utf8"));
      const values = frontmatter as Frontmatter;
      const name = stringValue(values, "name");
      if (!name || !body.trim()) return [];
      return [
        {
          name,
          description: stringValue(values, "description") ?? "",
          tools: splitList(values.tools),
          model: stringValue(values, "model"),
          thinking: stringValue(values, "thinking"),
          subagentAgents: splitList(values.subagent_agents),
          prompt: body.trim(),
          source,
        },
      ];
    } catch {
      return [];
    }
  });
}

function findProjectAgentsDirectory(cwd: string): string | undefined {
  let directory = cwd;
  while (true) {
    try {
      const candidate = join(directory, CONFIG_DIR_NAME, "agents");
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Missing and unreadable directories are not discovery errors.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export type DiscoverAgentsOptions = {
  includeProject?: boolean;
};

export function discoverAgents(
  cwd: string,
  options: DiscoverAgentsOptions = {},
): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const agent of readAgents(join(getAgentDir(), "agents"), "user"))
    byName.set(agent.name, agent);
  if (options.includeProject !== false) {
    const projectDirectory = findProjectAgentsDirectory(cwd);
    if (projectDirectory)
      for (const agent of readAgents(projectDirectory, "project")) byName.set(agent.name, agent);
  }
  return [...byName.values()];
}
