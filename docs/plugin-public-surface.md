# A plugin's public surface

What a visitor can reach of a plugin is declared in its manifest and enforced by the host and by Postgres, never left to the plugin's code (issue #1332, epic #763 decisions E4, E10, E12). The SDK half lives in `packages/plugin-sdk/src/public-surface.ts`; the host half in `packages/plugin-host/src/public-contract.ts` (dispatch) and `packages/plugin-sandbox/src/schema.ts` (grants).

## Public operations are contracts

Each entry of `publicOperations` is an object:

| Field | Meaning |
|---|---|
| `name` | An operation in `operations`. Anything not listed is refused a visitor call (default deny). |
| `kind` | `read` changes nothing; `write` stores visitor input. A `read` may not declare `writes`. |
| `input` | A Zod schema of the request body. The manifest carries its JSON Schema. |
| `captcha` | `required` (the default) or `none`. |
| `rateLimit` | `{ max, windowSeconds }` per client address. An Owner override still wins; without either the gateway default applies (30 per 60 s). |
| `reads` / `writes` | The tables of `schema` the handler touches with `ctx.query`. |

Before the handler runs, dispatch (`runPluginOperation`, so no entry point can skip it):

1. removes the gateway's proof field `_caelo_captcha` from the body;
2. refuses an operation whose captcha is `required` unless the gateway verified, for this request, a proof-of-work solved for exactly this operation, or the Owner turned the captcha off site-wide (`CaptchaRequired`, 403);
3. parses the body with `input` and refuses it on any mismatch (`InvalidInput`, 400; the logged detail lists paths and Zod's messages, never the values). The handler receives the parsed value.

While it runs, `ctx.query` reaches only the declared `reads` and `writes`.

After it, a refusal and a failure are told apart: a `PublicOperationError` is a refusal (`Rejected`, 422) and is not recorded as a plugin error; anything else (a TypeError, a database error, a host error) is a failure (`OperationFailed`, 500). No error text reaches a visitor: the gateway answers every error with only `{ kind, requestId }` (#1326) and writes the detail, including a refusal's words and the validation issues, to its log under that id. Inside the host, `visitorSafeResult` also replaces a failure's text with one generic sentence, so no other entry point can leak it either.

`captcha: "none"` is a reviewed declaration in the signed manifest, not a runtime switch. Use it for reads and for writes a rate limit alone may guard, such as a consent click (`record_consent`) or a logout.

### The proof is bound to the operation

The challenge from `GET /api/captcha/challenge` is solved over `<challenge>|<slug>.<operation>|<nonce>` (`powPreimage` in the gateway, `attachCaptchaProof(slug, operation)` in the component kit). The gateway verifies it against the operation of the request it came with, so work done for one operation pays for no other. A challenge is still redeemable once.

## Every table has a kind

`tableKinds` gives each table of `schema` one kind. The visitor role's grants are generated from it (`publicTableGrants`) on every load, after revoking what the role held, so a kind that narrows takes effect at once:

| Kind | Holds | Visitor role | Admin role |
|---|---|---|---|
| `published` | What the admin decided visitors see (form definitions, settings, rating averages) | SELECT | all four |
| `inbox` | What visitors send in (submissions, comments, consent records) | INSERT | all four |
| `visitor-state` | A visitor's own state (accounts, sessions, their earlier vote, opt-in tokens) | SELECT, INSERT, UPDATE, DELETE | all four |
| `private` | Internal plugin data | nothing | all four |

Postgres enforces this because the public side is assumed compromised ([dev/public-admin-boundary.md](./dev/public-admin-boundary.md)). Inserts into a plugin table choose the row id in the host and do not read it back, because an inbox grants no SELECT.

The generator takes its target as a parameter (`PublicGrantTarget`: database, visitor role, admin role), so the staging database (#1329) gets the same grants from the same declaration.

The manifest lint (`checkPublicSurface`) refuses: a table without a kind, a kind for an undeclared table, a public operation reading an inbox or private table, writing a published or private one, or a `read` that writes.

Known exception: the ratings worker still writes `rating_aggregates` (published) directly with the admin role; #1333 moves the recompute to the projection.

## Host requirements

`requires: ["email"]` says the plugin cannot work without a mail transport. `plugins.activate` refuses it while none is configured, and the error names the setup step (CLAUDE.md §2: no half-working plugin).

## Approval is bound to the manifest

The Owner's approval of a shipped plugin records the digest of its whole manifest (`plugins.approved_manifest_digest`). A release that changes the manifest, including any of the above, stops the plugin in the admin and the gateway until the Owner clicks "Approve this release" at Settings → Plugins. Publish live refuses while it waits, and Settings → Plugins and Settings → Updates say so. A changed public surface is pinned by `packages/plugin-host/src/public-surface.test.ts`, whose snapshot shows every change in review.

## Example

```ts
// SPDX-License-Identifier: MPL-2.0
import { definePlugin, PublicOperationError, z } from "@caelo-cms/plugin-sdk";

const submitInput = z
  .object({ pageId: z.string().uuid(), stars: z.number().int().min(1).max(5), body: z.string().max(2000) })
  .strict();

export default definePlugin({
  slug: "reviews",
  version: "1.0.0",
  tier: 2,
  schema: {
    reviews: { page_id: "uuid", stars: "int", body: "text", created_at: "timestamp" },
    review_settings: { open: "bool" },
  },
  tableKinds: { reviews: "inbox", review_settings: "published" },
  publicOperations: [
    {
      name: "submit",
      kind: "write",
      input: submitInput,
      rateLimit: { max: 5, windowSeconds: 60 },
      reads: ["review_settings"],
      writes: ["reviews"],
    },
  ],
  operations: {
    submit: async (ctx, args) => {
      const input = args as z.infer<typeof submitInput>;
      const [settings] = await ctx.query.list<"review_settings", { open: boolean }>("review_settings", { limit: 1 });
      if (!settings?.open) throw new PublicOperationError("reviews are closed");
      await ctx.query.insert("reviews", { page_id: input.pageId, stars: input.stars, body: input.body });
      return { accepted: true };
    },
  },
});
```
