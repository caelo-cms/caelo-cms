# The propose/execute pattern

CLAUDE.md §11.A specifies this pattern: AI proposes a hard-to-revert
operation, the operator clicks Approve. This document explains how
it's wired across 13 domains in the Caelo codebase, and how to add a
new gated domain when the surface grows.

## Why

The operator's mandate is "AI should be able to do all operations
(no human-only tasks); important tasks need a 'Go' from the operator
through a button click."

The naive way to implement this is per-domain: each gated op grows a
"requires confirmation" flag. That fragments fast. The propose/execute
pattern abstracts the gate as TWO ops per gated action:

- `<domain>.propose_<action>(input)` — AI-callable. Computes a
  preview, persists a row in `<domain>_pending_actions` with
  `status='pending'`. Returns `{proposalId, preview}`.
- `<domain>.execute_proposal({proposalId})` — human-only. Reads the
  pending row, dispatches the underlying op (`<domain>.<action>`)
  with the queued payload, flips status to `applied`.

The operator approves at `/security/<domain>/pending`. AI cannot
bypass — `execute_proposal`'s `actorScope` is `["human", "system"]`.

## Domains using the pattern

13 domains shipped (v0.2.19 → v0.2.30):

| Domain | Propose ops | Permission to approve |
|---|---|---|
| `deploy` | `propose_promote`, `propose_rollback` | `deploy.trigger` |
| `layouts` | `propose_create`, `propose_update`, `propose_delete`, `propose_set_blocks` | `roles.manage` |
| `users` | `propose_create`, `propose_set_roles`, `propose_delete` | `roles.manage` |
| `roles` | `propose_create`, `propose_update_permissions`, `propose_delete` | `roles.manage` |
| `snapshots.revert_*` | `propose_revert_site`, `_page`, `_template`, `_module` | `roles.manage` |
| `experiments` | `propose_activate`, `propose_complete` | `settings.write` |
| `email_config` | `propose_set` | `settings.write` |
| `ai_providers` | `propose_set`, `propose_clear_key` | `settings.write` |
| `mcp_tokens` | `propose_create`, `propose_revoke` | `settings.write` |
| `templates` | `propose_update`, `propose_delete` | `content.write` |
| `domains` | `propose_add`, `propose_remove` | `settings.write` |
| `locales` | `propose_create`, `_delete`, `_set_default`, `_update_strategy` | `settings.write` |
| `gateway` | `propose_rate_limit` | `settings.write` |

Plus three older proposal flows that share the spirit but predate
the unified shape: `site_memory_proposals`, `skill_proposals`,
`media_alt_proposals`.

## Per-domain table shape

Every gated domain has a `<domain>_pending_actions` table with:

```
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
kind            text NOT NULL CHECK (kind IN (...))   -- discriminator
proposed_by     uuid NOT NULL REFERENCES actors(id)
<entity>_id     uuid NULL REFERENCES <entity>(id) ON DELETE CASCADE  -- null for create
payload         jsonb NOT NULL                         -- AI-supplied input
preview         jsonb NOT NULL                         -- computed at propose time
status          text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled'))
created_at      timestamptz NOT NULL DEFAULT now()
decided_at      timestamptz NULL
decided_by      uuid NULL REFERENCES actors(id)
decision_reason text NULL
applied_<entity>_id uuid NULL REFERENCES <entity>(id) ON DELETE SET NULL  -- post-apply backref

-- v0.2.35 additions
chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL
payload_hash    text NULL  -- SHA-256 of canonicalized payload

-- Partial unique index for DB-level dedup
CREATE UNIQUE INDEX <table>_payload_hash_pending_uniq
  ON <table> (payload_hash) WHERE status = 'pending' AND payload_hash IS NOT NULL;

-- FORCE RLS with authenticated_scope policy
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
CREATE POLICY <table>_authenticated_scope ON <table>
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
```

## Per-domain op shape

Each domain has 5 ops + 1 AI tool wrapper per propose kind:

- `propose_<action>(input)` — `actorScope: ["human", "ai", "system"]`
- `execute_proposal({proposalId})` — `actorScope: ["human", "system"]`
- `reject_proposal({proposalId, reason?})` — `actorScope: ["human", "system"]`
- `list_pending({limit?})` — `actorScope: ["human", "ai", "system"]`

Plus the AI tool catalogue (registered in `ai/tools/index.ts`) has
one `propose_<action>` tool per action that wraps the op.

## Cross-cutting infrastructure

- **Cross-domain inbox** (`/security/pending`, v0.2.36) consumes
  `pending_proposals.list` (one UNION ALL across all 15 pending
  tables) and renders a unified queue.
- **Bell badge** (`notifications.aggregate`) sums pending across
  every table; click drops onto `/security/pending`.
- **AI context block** — chat-runner emits a `## Pending proposals`
  system-prompt section listing the AI's own pending rows so it
  doesn't re-propose what's queued (v0.2.32 + v0.2.38).
- **GC worker** (v0.2.37) sweeps `pending` rows older than 30 days
  to `superseded`. Bootstrapped from `apps/admin/src/hooks.server.ts`.
- **Cancel** — AI can withdraw its own pending row via
  `pending_proposals.cancel` / `cancel_proposal` tool (v0.2.37).
  Restricted to AI's own rows by `proposed_by` check.
- **Dedup** — partial unique index on `(payload_hash)` blocks
  duplicate proposals from racing past the soft `## Pending
  proposals` block (v0.2.35).
- **Chat origin** — `chat_session_id` on each row lets the unified
  inbox render "from chat: <title>" so the operator can trace which
  AI session generated a proposal.

## Adding a new gated domain

1. **Migration**: create `<domain>_pending_actions` matching the
   shape above. Add the partial unique index + FORCE RLS policy.

2. **Op file** (`packages/admin-core/src/ops/<domain>_pending.ts`):
   define propose / execute / reject / list_pending ops. Use the
   shared helpers in `_propose-helpers.ts`:
   - `hashProposalPayload(input)` — payload_hash for dedup.
   - `resolveChatSessionId(tx, ctx.chatBranchId)` — chat origin.
   - `isDuplicatePendingError(e)` — duplicate-pending detection.
   - `parsePayload<T>(row.payload)` — bun-postgres jsonb parse.
   - `DUPLICATE_PROPOSAL_MESSAGE` — standard error string.

3. **Register** in `register.ts` alongside the existing entries.

4. **Owner UI route**: `apps/admin/src/routes/(authed)/security/<domain>/pending/`
   with `+page.server.ts` (load + approve/reject actions) and
   `+page.svelte` (per-row card with the preview + action buttons).
   Map the route in `apps/admin/.../security/pending/+page.svelte`'s
   `queueRouteFor` so the unified inbox links correctly.

5. **Cross-domain plumbing**: add a stanza to
   `pending_proposals.list`'s UNION ALL query + the GC worker's
   `PENDING_TABLES` array. If the new domain uses non-standard
   column names (like `decision_note` instead of `decision_reason`),
   add the dispatch case to the worker.

6. **AI tool**: add a `propose_<action>` entry to
   `ai/tools/propose-tools-batch.ts` via the `makeProposeTool`
   factory. Each tool description must include the TWO-STEP wording
   per CLAUDE.md §11.A.

7. **Test**: add a stanza to
   `__tests__/propose-execute.integration.test.ts` exercising the
   propose → execute_proposal → already-applied + reject + cancel
   invariants.

## Credential-handling shapes

Three sub-patterns for how secrets travel:

- **Server-generated** (`users`, `mcp_tokens`): execute_proposal
  generates the secret server-side at approve time, returns it once
  in the response so the Owner UI can copy it.
- **Owner-supplies-at-approve** (`email_config`, `ai_providers`):
  AI proposes config WITHOUT the secret. The Owner UI's approve
  form takes a password input; the form action calls
  `execute_proposal({proposalId, secret})`. The secret never lands
  in the proposal payload.
- **No secret**: most domains. Plain propose → execute path.

The propose handler's pre-flight should reject payloads that
smuggle a secret-shaped field (e.g. `email_config.propose_set`
rejects `config.apiKey` even though the schema would tolerate it).

## Reference implementations

When in doubt, copy:

- `packages/admin-core/src/ops/user_pending.ts` — server-generated-secret shape.
- `packages/admin-core/src/ops/email_config_pending.ts` — Owner-supplies-secret shape.
- `packages/admin-core/src/ops/template_pending.ts` — no-secret shape with blast-radius preview.
- `packages/admin-core/src/ai/tools/propose-tools-batch.ts` — AI tool factory usage.
