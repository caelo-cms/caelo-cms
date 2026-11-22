# A plugin's public surface

What a visitor can reach of a plugin is declared in its manifest and enforced by the host and by Postgres, never left to the plugin's code (issue #1332, epic #763 decisions E4, E10, E12). Since #1340 (E2-B) it is also *done* by the host: a public operation is a declaration core code runs, and no plugin code ever answers a visitor — the API gateway carries no plugin code at all. The SDK half lives in `packages/plugin-sdk/src/public-surface.ts` and `public-run.ts`; the host half in `packages/plugin-host/src/public-contract.ts` (the contract), `public-run-host.ts` and `public-blocks/` (what runs) and `packages/plugin-sandbox/src/schema.ts` (grants).

## Public operations are contracts

Each entry of `publicOperations` is an object:

| Field | Meaning |
|---|---|
| `name` | The operation's name (`/api/plugin/<slug>/<name>`). Not one of `operations`: a public operation is only its `run`. Anything not listed is refused a visitor call (default deny). |
| `kind` | `read` changes nothing; `write` stores visitor input. A `read` may not declare `writes`. |
| `input` | A Zod schema of the request body. The manifest carries its JSON Schema. |
| `captcha` | `required` (the default) or `none`. |
| `rateLimit` | `{ max, windowSeconds }` per client address. An Owner override still wins; without either the gateway default applies (30 per 60 s). |
| `reads` / `writes` | The tables of `schema` the run touches; they must cover what the run declares. |
| `run` | What the host does (below). |

Before the run, dispatch (`runPluginOperation`, so no entry point can skip it):

1. removes the gateway's proof field `_caelo_captcha` from the body;
2. refuses an operation whose captcha is `required` unless the gateway verified, for this request, a proof-of-work solved for exactly this operation, or the Owner turned the captcha off site-wide (`CaptchaRequired`, 403);
3. parses the body with `input` and refuses it on any mismatch (`InvalidInput`, 400; the logged detail lists paths and Zod's messages, never the values). The run receives the parsed value. On the gateway `input` is compiled from the manifest's JSON Schema, so a transform (`.trim()`) or a refinement does not reach it: say it in the run (`trim: true`, a check) instead.

While it runs, `ctx.query` reaches only the declared `reads` and `writes`.

After it, a refusal and a failure are told apart: a failed check (and a block's own refusal) is a refusal (`Rejected`, 422) and is not recorded as a plugin error; anything else (a database error, a host error) is a failure (`OperationFailed`, 500). No error text reaches a visitor: the gateway answers every error with only `{ kind, requestId }` (#1326) and writes the detail, including a refusal's words and the validation issues, to its log under that id. Inside the host, `visitorSafeResult` also replaces a failure's text with one generic sentence, so no other entry point can leak it either.

A system caller (a seed, a test, a migration) may run a declaration too, its input checked against `input`; no other origin reaches a public operation except as a visitor.

`captcha: "none"` is a reviewed declaration in the signed manifest, not a runtime switch. Use it for reads and for writes a rate limit alone may guard, such as a consent click (`record_consent`) or a logout.

### The proof is bound to the operation

The challenge from `GET /api/captcha/challenge` is solved over `<challenge>|<slug>.<operation>|<nonce>` (`powPreimage` in the gateway, `attachCaptchaProof(slug, operation)` in the component kit). The gateway verifies it against the operation of the request it came with, so work done for one operation pays for no other. A challenge is still redeemable once.

## What a run does (#1340)

| `run.action` | Does | Options |
|---|---|---|
| `insert` | One row into an inbox or visitor-state table of the plugin's `schema`. | `values` (at least one column), `checks`, `honeypot`, `onlyIf`, `drop`, `answer` |
| `list` | Rows of a published or visitor-state table (`of: "schema"`, the default), or the published columns of an admin table (`of: "adminSchema"`, only what `visitorProjection` publishes). | `where`, `orderBy`, `orderDir`, `limit` (≤ 1000), `columns`, `as` (the answer's key) |
| `block` | A core building block, configured by `options`. | see the blocks below |

A value (`values`, `where`) comes `from` one of: `input` (a top-level field or `a.b`; `trim`, `optional` to leave an absent field out, `orElse` for the value an absent field stands for, `distinct` for an array), `visitor` (`key: "id"`, the consented visitor id or null, #677), `const`, `now` (ISO time) or `today` (UTC date).

An insert's extras, in the order the host applies them:

1. `honeypot` — a field bots fill; when it holds anything the visitor gets its `answer` and `store: "nothing"` stores nothing, `"marked"` stores the row with its `values` overriding (a form's `status: "spam"`).
2. `onlyIf` — a `column` of a published (or published-admin) row must equal `equals`, or with `config: "<leaf>"` (#1655) the plugin's released value of a `visitorVisible` config leaf must; otherwise the visitor gets its `answer` and nothing is stored (a switch the Owner sets, such as counting searches or keeping the site assistant's feedback). A config switch is published with the release (`published_plugin_visitor_config`), so it goes live with the Publish live that ships it; where no released value is readable (an admin process), nothing is stored.
3. `drop` — any of its `fields` that looks like personal data (`email`, `phone`, `long-number`: six digits in a row or card/IBAN groups) answers its `answer` and stores nothing (`matchesDropPattern` in the SDK).
4. `checks` — `not-blank`, `equals-row` (the field equals a column of a published row: the current policy version), `all-in` (every element is a value of a published column: known consent categories), `form-fields` (the field fits a field definition stored in a published row). A failed check refuses with its `refusal` words.
5. the insert; `answer` may name `{ from: "inserted-id" }`.

The core building blocks (`PUBLIC_BLOCKS`, contracts in `PUBLIC_BLOCK_CONTRACTS`): the lint checks that the plugin declares each block's tables with their kinds and columns, the indexes the block reads by, the capabilities and the mail templates it needs.

| Block | Does | Plugin declares |
|---|---|---|
| `visitor-auth.signup`, `.verify-email`, `.login`, `.logout`, `.me`, `.request-password-reset`, `.reset-password` | Visitor accounts and sessions (#1334): mandatory e-mail verification, argon2id bounded per process, no account enumeration, single-use tokens, the per-account login throttle, cookie-only sessions. Locked from AI regeneration (CLAUDE.md §2). | `public_users`, `visitor_sessions`, `password_reset_tokens`, `email_verification_tokens`, `login_throttle` (visitor-state), `auth_config` (published), the `email` capability and the `verify_email` / `signup_existing_account` / `password_reset` templates |
| `double-opt-in.subscribe`, `double-opt-in.confirm` | An address stored unconfirmed and a confirmation link mailed (one answer for every address, a still valid link mailed again), then redeemed before it expires (#1337). | `options.table` (visitor-state, with `email`, `email_hash`, `confirm_token`, `confirm_expires_at`, `confirmed_at`, `unsub_token`), `options.template`, `options.hours` |
| `mail.unsubscribe` | The host-signed link of a mail the plugin sent (#1432): sets `options.column` of the row the token names, once. | `options.table`, `options.column` |
| `comment-thread.read` | A page's approved comments from what the admin publishes after moderation. | the `cms_admin` capability |

The manifest lint (`checkPublicRun`) refuses a run that reaches beyond the plugin: a table it does not declare (another plugin's, a core one), a column a table does not declare, a table of a kind the action may not touch, an admin table or column `visitorProjection` does not publish, a block whose tables, indexes, capability or templates are missing, reads and writes that do not cover the run, and a public operation that is also a code operation.

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

Published rows are written by the admin only: by the plugin's own operations in the admin (a form definition) and by its workers. A worker that recomputes published rows from an inbox declares `publicDatabases: "each"`: the host runs it once per public database, each run's `ctx.query` bound to that database alone, so the live result comes from live visitors and the staging result from the staging site's test data (#1333: the ratings averages from the votes). Nothing of either crosses into cms_admin.

## Host requirements

`requires: ["email"]` says the plugin cannot work without a mail transport. `plugins.activate` and "Approve this release" refuse it while none is configured, `email_config.set` refuses to switch the transport off while it runs, and each error names the step (CLAUDE.md §2: no half-working plugin).

## Mail templates

A plugin mails visitors only through `mailTemplates` (#1337): a subject, plain-text paragraphs and at most one link to one of its public write operations, which the visitor confirms on the gateway's confirmation page. A visitor operation queues one with `ctx.email.queue({ template, to, token })`; the admin sends it. The row in the outbox chooses the template, the recipient and a token, never text or a host, and the admin caps the mails per recipient and site (Owner settings, Settings → Email). See [dev/mail-outbox.md](./dev/mail-outbox.md). The templates are part of the public-surface snapshot below.

Mail a plugin sends itself with `ctx.email.send` (an approved campaign) declares its unsubscribe link as `mailUnsubscribe` (#1432): a public write operation that requires `token` and nothing else. The host signs the token per recipient and refuses that operation without one, on every route; a mail client's one-click POST (RFC 8058) reaches it without a proof-of-work on that signature. It is in the snapshot too. See [dev/mail-outbox.md](./dev/mail-outbox.md).

## Approval is bound to the manifest

The Owner's approval of a shipped plugin records the digest of its whole manifest (`plugins.approved_manifest_digest`). A release that changes the manifest, including any of the above, stops the plugin in the admin and the gateway until the Owner clicks "Approve this release" at Settings → Plugins. Publish live refuses while it waits, and Settings → Plugins and Settings → Updates say so. The approval reaches the live and staging gateways with the admin's next publish, without a Publish live (#1587): they already run the new release from their images. A changed public surface is pinned by `packages/plugin-host/src/public-surface.test.ts`, whose snapshot shows every change in review.

## Example

```ts
// SPDX-License-Identifier: MPL-2.0
import { definePlugin, z } from "@caelo-cms/plugin-sdk";

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
      // Stored only while the Owner keeps reviews open; answered alike when closed.
      run: {
        action: "insert",
        table: "reviews",
        values: {
          page_id: { from: "input", field: "pageId" },
          stars: { from: "input", field: "stars" },
          body: { from: "input", field: "body", trim: true },
        },
        onlyIf: {
          source: { table: "review_settings", of: "schema" },
          column: "open",
          equals: true,
          answer: { accepted: true },
        },
        checks: [{ check: "not-blank", field: "body", refusal: "a review needs a text" }],
        answer: { accepted: true, id: { from: "inserted-id" } },
      },
    },
  ],
  // Admin-side code only; nothing here answers a visitor.
  operations: {},
});
```
