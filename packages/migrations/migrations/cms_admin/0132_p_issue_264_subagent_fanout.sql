-- SPDX-License-Identifier: MPL-2.0
--
-- 0132 — site-migrate: rebuilds fan out to SUBAGENTS (issue #264,
-- first slice of the orchestrator/task-subagent architecture).
--
-- Run #7 proved a single chat session cannot carry a real migration:
-- rebuilding every page inline dragged the full transcript through
-- every provider call (1.2M-token turns, #261) until the session died
-- mid-run. spawn_subagent has existed since P10.5; this amendment
-- makes the skill actually use it: the operator's chat becomes the
-- ORCHESTRATOR (plans, dispatches, relays summaries, tracks progress)
-- and each cluster/batch rebuild runs in a fresh-context subagent on
-- the SAME preview branch (chat-runner chatBranchIdOverride, PR for
-- #264). The orchestrator's context grows by compact `rebuild`-shape
-- summaries only.
--
-- Guarded + idempotent like 0130/0131: matches a stable substring of
-- the 0130 rebuild-contract text (present whether or not 0131 ran)
-- and no-ops once the fan-out text is in place.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  'the working unit is the CLUSTER: rebuild ONE representative page per cluster as clean Caelo modules, verify it (screenshot vs the stored source screenshot), then apply the same module pattern to the cluster''s remaining pages with each page''s own content.',
  'the working unit is the CLUSTER, and the rebuild work is DELEGATED: you are the ORCHESTRATOR. You NEVER rebuild page bodies inline in this chat — inline rebuilds drag the whole site through your context until the session hits the token ceiling and dies mid-run. Subagents start fresh per cluster; your context grows by their compact summaries only.

   REBUILD FAN-OUT (A and B):
   - Chrome first: spawn ONE subagent (role "rebuild:chrome") to rebuild the imported header/footer via the layout tools per the contract below. Then work cluster by cluster: `spawn_subagent` with role "rebuild:<cluster>", ONE subagent per cluster; split clusters larger than ~5 pages into batches of ~5, one subagent per batch. Spawn SEQUENTIALLY — finish and relay one before starting the next — so progress stays readable and no two subagents touch the same shared module.
   - Spawn parameters: expectedReturnShape "rebuild", timeoutMs 600000, maxCostMicrocents 100000000. The subagent works on THIS chat''s preview branch — its edits appear in this chat''s preview and publish.
   - THE TASK BRIEF IS ALL THE SUBAGENT KNOWS. It starts with a FRESH context — no memory of this chat, the crawl, or the operator''s answers. Every task must be self-contained, in this order: (1) open with "REBUILD TASK — do the rebuild yourself with the page and module tools; do not delegate, do not ask the operator anything"; (2) the import run id and the route (A keep-design or B light-refresh) with one sentence on what that means for this site; (3) every page in the batch: page id, slug, and import page id; which page is the cluster''s REPRESENTATIVE (rebuild + verify it first, then apply its module pattern to the rest with each page''s own content); (4) the decisive sampled design tokens (palette, font families, radii) pasted in, NOT a pointer; (5) the instruction to fetch ground truth itself: `get_import_page_screenshot` for each source page before rebuilding it, `get_import_run_report({runId})` if it needs the content inventory; (6) THE REBUILD CONTRACT bullets below, copied VERBATIM; (7) this return instruction verbatim: Return JSON: {pages: [{pageId, slug, status: "rebuilt"|"skipped"|"failed", notes}], contentNotes: [...], skipped: [{item, reason}], summary: "..."}.
   - RELAY HONESTLY, TRACK PROGRESS: after each subagent returns, report to the operator in 1-2 sentences — "cluster n of m done: x pages rebuilt" — and relay every skipped item and content note VERBATIM. Never smooth over a reported failure; never claim a page rebuilt that the summary does not list as rebuilt. Then record the batch''s per-page notes in ONE batched `add_import_page_notes` call from the summary. A timed-out or errored subagent: re-spawn ONCE with a smaller batch; if it fails again, tell the operator what failed and move on.
   - KEEP YOUR OWN TURNS SHORT: do not re-read rebuilt pages yourself; spot-check at most ONE page every few clusters (screenshot_page vs the stored source screenshot).
   - IF YOUR OWN SEED MESSAGE STARTS WITH "REBUILD TASK": you ARE a rebuild subagent. Do the work directly with the page/module tools per the brief, and end with ONLY the Return JSON object — no delegation, no operator questions.

   The cluster principle stays: rebuild the representative page first, verify it (screenshot vs the stored source screenshot), then the same module pattern carries the cluster''s remaining pages with each page''s own content — the subagent does this inside its batch.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%the working unit is the CLUSTER: rebuild ONE representative page per cluster%'
  AND body NOT LIKE '%REBUILD FAN-OUT%';

COMMIT;
