import {
  createProvider,
  type Api,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

const PROVIDER_ID = "ntnu-idun";

const BASE_URL = "https://llm.hpc.ntnu.no/v1";

const DEFAULT_CONTEXT_WINDOW = 30000;

const DEFAULT_MAX_TOKENS = 32768;

const ModelsResponseSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      max_input_tokens: Schema.optional(Schema.Number),
      max_output_tokens: Schema.optional(Schema.Number),
    }),
  ),
});

// SIMPLIFIED: heuristic vision detection — IDUN's /v1/models exposes no capability
// metadata, so multimodal support is inferred from the model ID. Covers explicit
// vision naming (Vision, -VL, VLM, 4V, omni) and the GLM-5.x line, which is
// vision-capable despite its name (see docs.z.ai/guides/vlm/glm-5.3-flash).
// Upgrade path: curated list or capability probe if IDUN exposes metadata.
const VISION_PATTERN = /vision|-vl|vlm|4v|omni|glm-5/i;

const GLM_PATTERN = /(?:^|[/_-])glm(?:[/_.-]|$)/i;

function supportsVision(id: string): boolean {
  return VISION_PATTERN.test(id);
}

const ProviderPayloadSchema = Schema.Struct({
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
});

type ProviderPayload = Parameters<NonNullable<StreamOptions["onPayload"]>>[0];

/**
 * IDUN's LiteLLM endpoint rejects `tools: []`. Newer pi-ai versions include
 * that field when replaying a conversation with tool history but no active
 * tools, so remove it before the request is sent.
 */
function withoutEmptyTools<T extends StreamOptions>(options: T | undefined): T | undefined {
  if (!options) return options;

  return {
    ...options,
    onPayload: async (payload: ProviderPayload, model: Model<Api>) => {
      const transformed = await options.onPayload?.(payload, model);
      const candidate = transformed ?? payload;

      if (
        !Schema.is(ProviderPayloadSchema)(candidate) ||
        !candidate.tools ||
        candidate.tools.length > 0
      ) {
        return transformed;
      }

      const sanitized = { ...candidate };
      delete sanitized.tools;

      return sanitized;
    },
  };
}

function idunApi(pi: ExtensionAPI): ProviderStreams {
  const api = openAICompletionsApi();

  const restoreTools = (context: Context): Context => {
    if (context.tools?.length || pi.getActiveTools().length === 0) return context;

    const activeTools = new Set(pi.getActiveTools());
    context.tools = pi
      .getAllTools()
      .filter((tool) => activeTools.has(tool.name))
      .map(({ name, description, parameters }): Tool => ({ name, description, parameters }));

    return context;
  };

  return {
    ...api,
    stream(model, context, options) {
      return api.stream(model, restoreTools(context), withoutEmptyTools(options));
    },
    streamSimple(model, context, options: SimpleStreamOptions) {
      const sanitizedOptions = withoutEmptyTools(options);

      return api.streamSimple(model, restoreTools(context), {
        ...sanitizedOptions,
        toolChoice: context.tools?.length
          ? (sanitizedOptions?.toolChoice ?? "auto")
          : sanitizedOptions?.toolChoice,
      });
    },
  };
}

function modelFromId(
  id: string,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  maxTokens = DEFAULT_MAX_TOKENS,
): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,

    reasoning: true,
    input: supportsVision(id) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingFormat: GLM_PATTERN.test(id) ? "zai" : undefined,
      zaiToolStream: GLM_PATTERN.test(id),
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

  const payload = Schema.decodeUnknownSync(ModelsResponseSchema)(await response.json());

  return payload.data.flatMap((entry): Model<"openai-completions">[] => {
    // Embedding models are exposed by /models but cannot be used for chat completions.
    if (entry.id.toLowerCase().includes("embedding")) return [];

    const contextWindow =
      typeof entry.max_input_tokens === "number" &&
      Number.isFinite(entry.max_input_tokens) &&
      entry.max_input_tokens > 0
        ? entry.max_input_tokens
        : DEFAULT_CONTEXT_WINDOW;
    const maxTokens =
      typeof entry.max_output_tokens === "number" &&
      Number.isFinite(entry.max_output_tokens) &&
      entry.max_output_tokens > 0
        ? entry.max_output_tokens
        : DEFAULT_MAX_TOKENS;

    return [modelFromId(entry.id, contextWindow, maxTokens)];
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
      api: idunApi(pi),
    }),
  );
}
