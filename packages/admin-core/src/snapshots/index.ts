// SPDX-License-Identifier: MPL-2.0

export {
  emitSnapshot,
  type SnapshotEntity,
  type SnapshotOpKind,
} from "./emit.js";
export {
  loadContentInstanceState,
  loadContentInstanceStateWithBranchOverlay,
  loadModuleState,
  loadModuleStateWithBranchOverlay,
  loadPageLayoutState,
  loadPageLayoutStateWithBranchOverlay,
  loadPageState,
  loadPageStateWithBranchOverlay,
  loadTemplateState,
} from "./load.js";

/**
 * JSONB columns come back from bun-sql as strings under drizzle's
 * BunSQLDatabase — parse defensively so revert ops can splat the state
 * back into the live row. Use `parseAndUpgrade*State` from
 * `./state-schemas.js` when you want runtime validation against the
 * versioned shape (which every revert op now does — closes CLAUDE.md §4
 * "Zod at every boundary" for the snapshot ↔ live-row hop).
 */
export function parseSnapshotState<T>(raw: unknown): T {
  if (typeof raw === "string") return JSON.parse(raw) as T;
  return raw as T;
}

export { classifySeverity, defaultTemplateBlockIsHeader } from "./severity.js";
export {
  parseAndUpgradeModuleState,
  parseAndUpgradePageLayoutState,
  parseAndUpgradePageState,
  parseAndUpgradeTemplateState,
  SnapshotSchemaError,
} from "./state-schemas.js";
