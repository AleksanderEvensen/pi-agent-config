import { Schema } from "effect";

// .mcp.json is a client configuration convention, not part of the MCP protocol spec.
// Project file format: https://code.claude.com/docs/en/mcp#project-scope
// Pi-specific fields: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md#configure-servers

const Exposure = Schema.Literals(["codemode", "deferred", "direct", "hidden"]);

const Strings = Schema.Record(Schema.String, Schema.String);

const HttpUrl = Schema.String.check(
  Schema.makeFilter((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol)),
);

const Common = {
  exposure: Schema.optional(Exposure),
  toolExposure: Schema.optional(Schema.Record(Schema.String, Exposure)),
  description: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  timeout: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  // Project config must not opt into sending Pi provider credentials.
  auth: Schema.optional(Schema.Never),
};

const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  callbackUrl: Schema.optional(HttpUrl),
  scope: Schema.optional(Schema.String),
  clientName: Schema.optional(Schema.NonEmptyString),
  clientRegistration: Schema.optional(Schema.Literals(["dcr", "cimd"])),
  authServerMetadataUrl: Schema.optional(HttpUrl),
});

// Pi's registry also checks OAuth redirect and credential policy before connecting.
const Server = Schema.Union([
  Schema.Struct({
    ...Common,
    type: Schema.optional(Schema.Literal("stdio")),
    command: Schema.NonEmptyString,
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(Strings),
    cwd: Schema.optional(Schema.String),
    url: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    ...Common,
    type: Schema.optional(Schema.Literals(["http", "streamable-http"])),
    url: HttpUrl,
    headers: Schema.optional(Strings),
    oauth: Schema.optional(OAuth),
    command: Schema.optional(Schema.Never),
  }),
]);

export const Entry = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)),
  config: Server,
});

// Decode entries separately so one invalid server cannot discard valid siblings.
export const McpFile = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
