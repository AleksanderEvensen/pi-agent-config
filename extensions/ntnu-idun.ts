import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "ntnu-idun";
const BASE_URL = "https://llm.hpc.ntnu.no/v1";

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 32768;

interface ModelsResponse {
  data?: unknown;
}

function isModelsResponse(value: unknown): value is ModelsResponse {
  return typeof value === "object" && value !== null && "data" in value;
}

// SIMPLIFIED: heuristic vision detection — IDUN's /v1/models exposes no capability
// metadata, so multimodal support is inferred from the model ID. Covers explicit
// vision naming (Vision, -VL, VLM, 4V, omni) and the GLM-5.x line, which is
// vision-capable despite its name (see docs.z.ai/guides/vlm/glm-5.3-flash).
// Upgrade path: curated list or capability probe if IDUN exposes metadata.
const VISION_PATTERN = /vision|-vl|vlm|4v|omni|glm-5/i;

function supportsVision(id: string): boolean {
  return VISION_PATTERN.test(id);
}

function modelFromId(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,

    reasoning: true,
    input: supportsVision(id) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  };
}

async function fetchIdunModels(
  apiKey: string,
  signal: AbortSignal,
): Promise<readonly Model<"openai-completions">[]> {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal,
  });
  if (!response.ok)
    throw new Error(`IDUN model request failed: HTTP ${response.status} ${await response.text()}`);

  const payload: unknown = await response.json();
  if (!isModelsResponse(payload) || !Array.isArray(payload.data)) {
    throw new Error("IDUN returned an invalid model list");
  }

  return payload.data.flatMap((entry): Model<"openai-completions">[] => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string"
    )
      return [];
    // Embedding models are exposed by /models but cannot be used for chat completions.
    return entry.id.toLowerCase().includes("embedding") ? [] : [modelFromId(entry.id)];
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "NTNU IDUN HPC",
      baseUrl: BASE_URL,
      auth: {
        apiKey: {
          name: "IDUN API token",
          async login(interaction) {
            const key = (
              await interaction.prompt({
                type: "secret",
                message: "Paste your IDUN API token",
                placeholder: "sk-...",
              })
            ).trim();
            if (!key) throw new Error("No API token entered");
            await fetchIdunModels(key, interaction.signal);
            return { type: "api_key", key };
          },
          check: async ({ credential }) =>
            credential?.key ? { type: "api_key", source: "stored IDUN API token" } : undefined,
          resolve: async ({ credential }) =>
            credential?.key
              ? { auth: { apiKey: credential.key }, source: "stored IDUN API token" }
              : undefined,
        },
      },
      // The catalog is supplied by IDUN's authenticated /v1/models endpoint.
      models: [],
      fetchModels: async ({ credential, signal }) => {
        if (credential?.type !== "api_key" || !credential.key) return [];
        return fetchIdunModels(credential.key, signal);
      },
      api: openAICompletionsApi(),
    }),
  );
}
