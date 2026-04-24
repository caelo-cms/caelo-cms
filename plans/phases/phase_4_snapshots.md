# Phase 4 — Snapshot versioning + revert

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P3.
**Unblocks:** P5 (AI edits must emit snapshots).

## Goal (from master plan)
Add `site_snapshots`, `page_snapshots`, `module_snapshots` tables with appropriate indexes. Every write through the Query API emits a snapshot for affected entities. **UX simplifications (UX-2, UX-9, UX-10):** (a) *Undo/Redo stack keyed to chat messages* is the primary surface — one backwards/forwards control scoped to the current editing session. (b) *Task-grouped timeline* collapses consecutive AI actions inside the same chat task into one expandable entry; per-action snapshots still emitted for revert fidelity. (c) *Visual impact preview* renders thumbnails with before/after diffs grouped by severity; raw lists hidden behind "Show all affected pages". Per-site and per-module revert surfaced in an Advanced History drawer. Deliverable: edit module → visual impact preview with grouped severity → confirm → chat Undo reverts atomically; Advanced History drawer exposes per-site and per-module revert for power users.

## End-to-end verification
Edit module → **visual impact preview grouped by severity** → confirm → **chat-keyed Undo** restores prior state incl. module; Advanced History drawer exposes per-site / per-module revert.

## To be detailed before execution
- Snapshot schema: `site_snapshots` (timestamp, actor, description, **chat_task_id** for UX-10 grouping), `page_snapshots` and `module_snapshots` (FK to site_snapshot, entity state JSON).
- **Task-grouping:** consecutive snapshots sharing a `chat_task_id` collapse into a single timeline row; expansion reveals per-action snapshots.
- **Chat-keyed Undo/Redo stack:** tracks the highest snapshot id before the current chat task; Undo reverts the whole task atomically (all snapshots with that `chat_task_id`).
- Write path hook: Query API emits snapshot in same transaction as write — never split.
- Indexing: `(entity_id, site_snapshot_id)`, `(chat_task_id)`, `(site_snapshot_id)`.
- **Impact severity heuristic:** module usage count + placement (hero vs footer) + cross-template presence → low/medium/high; heuristic unit-tested with fixtures.
- **Visual impact preview:** thumbnails rendered via a small helper that replays the new state against the generator for each affected page; before/after grouped by severity.
- Impact preview query: given module_id, list pages referencing it via page_modules.
- Per-module revert: restore a single `module_snapshot` without rolling back other entities at that site snapshot.
- Linear history enforcement: no branching — reverting forward from a snapshot discards later snapshots (with confirmation).
- **Module A/B variant support:** variants are sibling `module_snapshots` tagged with `experiment_id` + `variant_label`; no new versioning primitive. Winner promotion = standard per-module revert to the chosen snapshot. Traffic split configured per deploy (edge layer performs the split; static generator emits all variants). Experiments are Owner-configurable; AI can propose variants but cannot start/stop experiments.
- **Ephemeral chat branches** (wired in P5 but reserved here): snapshots additionally carry an optional `chat_branch_id`; a chat's snapshots are invisible to other chats until merged into main at publish time. Merge = re-applying the chat-branch snapshots in order against the latest main state, producing a new merged snapshot.
