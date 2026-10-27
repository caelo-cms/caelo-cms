# Tool schemas: what the model sees vs what dispatch validates

Every AI tool has two schemas with different jobs:

- **The Zod `schema`** validates every call at dispatch. It is the only strict authority: what it rejects is rejected, with an AI-actionable error (`formatToolArgError` in `packages/admin-core/src/ai/tools/dispatch.ts`).
- **The provider-facing `inputSchema`** is what the model reads (chat runner and Power-MCP alike). `ToolRegistry.register` resolves it once: the hand-written `inputSchema` if the tool has one, otherwise `generateInputSchema(tool.schema)` (Zod v4 `z.toJSONSchema`). Both then go through `compactInputSchema` (`compact-input-schema.ts`).

## Why compact

The raw Zod export is heavy: a `z.discriminatedUnion` copies its shared fields into every `oneOf` branch, every `format: uuid` carries a ~60-token regex, every `.int()` carries `maximum: 9007199254740991`. That structure was about half of the catalogue's tokens, sent on every turn, and large `oneOf` trees also slow constrained decoding.

## The contract

`compactInputSchema` only ever **widens**: a call valid under the raw schema stays valid under the compact one. A constraint the compact shape can no longer express (a per-variant enum, pattern, bound or required field) moves into the property's `description`, so the model still learns what the Zod parse will enforce. The rewrites:

| Raw shape | Compact shape |
|---|---|
| `oneOf`/`anyOf` of objects with a shared `const` discriminator | one object: discriminator `enum`, each property once, "Required when `kind`: `a`." / "For `kind`: `a`." notes, widest bounds |
| `allOf` of objects | one merged object (left alone when two parts disagree on a property) |
| `anyOf` of plain strings (enum / const / anchored pattern) | one string with one combined anchored pattern |
| `anyOf [X, {type: "null"}]` | X with `type: [t, "null"]` (an enum gains `null`) |
| `maximum: 9007199254740991`, integer `exclusiveMinimum: 0` | dropped / `minimum: 1` |
| `pattern` next to `format` `uuid`, `date-time`, `date`, `email` or `uri`, `$schema`, `propertyNames: {type: "string"}`, `additionalProperties: {}` | dropped |
| a property named `ext` (plugin-namespaced extras) | `{ "type": "object" }` |

The walker descends only into schema positions, so a tool property named `pattern`, `format` or `$ref` stays a property.

## Providers

- **Anthropic** and **OpenAI** take the compact schema as is (OpenAI function tools run non-strict).
- **Google** gets it through `googleToolSchema` (`providers/google-tool-schema.ts`), which turns each type list into an `anyOf` with a bare `{type: "null"}` branch and writes non-string enums into the description.

## Checks

- `__tests__/compact-input-schema.test.ts`: one test per rule, including properties named like keywords.
- `__tests__/compact-input-schema.registry.test.ts`: over the real catalogue, random arguments valid under each raw schema must stay valid under the compact one (ajv, seeded); every property name, allowed value and domain pattern must survive; no schema may grow. A tool the generator cannot sample needs hand-written cases there.
- `ai/__tests__/compact-schema-providers.test.ts`: the whole catalogue through the real Anthropic, OpenAI and Google SDK request builders.

When you change a tool's Zod schema, nothing extra is needed: the compaction runs at registration. If the registry test reports a lost fact or a rejected call, fix the compaction, not the test.
