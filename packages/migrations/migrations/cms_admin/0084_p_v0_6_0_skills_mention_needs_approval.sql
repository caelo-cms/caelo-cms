-- SPDX-License-Identifier: MPL-2.0

-- v0.6.0 alpha.3 — teach the AI that some tools queue for approval
-- via the v0.6.0 needsApproval predicate (separate from the existing
-- propose/* tools). Without this, the AI may be surprised when
-- delete_pages_many at 5+ pages returns "Queued proposal …" and stop
-- mid-flow instead of telling the user "queued — click Approve".
--
-- Touches the two skills most likely to encounter the gate:
--  - compose-page (may dispatch delete_pages_many during cleanup)
--  - brand-voice-guard (no direct gated tools today, but bulk content
--    edits could route through it)
--
-- The wording avoids naming specific tools so the migration doesn't
-- have to be re-run as more tools opt into needsApproval — the AI
-- just needs to know the canonical "Queued proposal <uuid>:" shape
-- means "wait for Owner approval before claiming success".

UPDATE skills
SET
  body = body || '

When a tool returns "Queued proposal <uuid>: <tool-name> — needs Owner approval (...)" the action is NOT applied yet. The chat panel renders an inline Approve / Reject card; tell the user one sentence about what was queued and what will happen on Approve. Do NOT continue as if the action succeeded — the next tool call should assume the gated action has NOT taken effect.'
WHERE slug = 'compose-page'
  AND body NOT LIKE '%needs Owner approval%';

-- Same nudge on bootstrap-site so the AI handles future gated
-- bootstrap-related tools (none exist today; safe-by-default).
UPDATE skills
SET
  body = body || '

If any tool returns "Queued proposal <uuid>: ... needs Owner approval" during bootstrap (today: layouts.propose_create via STAGE 0; future: any tool added with needsApproval), tell the user the queue URL and wait for their click before continuing with the next stage.'
WHERE slug = 'bootstrap-site'
  AND body NOT LIKE '%needs Owner approval%';
