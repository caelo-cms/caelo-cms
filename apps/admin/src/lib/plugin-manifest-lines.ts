// SPDX-License-Identifier: MPL-2.0

/**
 * The one-line summaries Settings → Plugins shows under a plugin: what it
 * asks visitors to consent to, the admin pages it adds and its live-editor
 * toolbar items, so the Owner sees what an activation adds before approving.
 *
 * Each line carries the entry's identity from the manifest as `key` (purpose
 * key, panel slug, toolbar item id — the manifest schema refuses duplicates
 * of each), never the display text: two entries may share a title and
 * permission, and a keyed `{#each}` over text would throw a duplicate-key
 * error and take the whole settings page down.
 */

/** One summary line, keyed by the manifest entry it describes. */
export interface ManifestLine {
  readonly key: string;
  readonly text: string;
}

/** The array at `field` of a stored manifest, or [] when absent or malformed. */
function entriesOf(manifestJson: unknown, field: string): Record<string, unknown>[] {
  if (manifestJson === null || typeof manifestJson !== "object") return [];
  const raw = (manifestJson as Record<string, unknown>)[field];
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is Record<string, unknown> => e !== null && typeof e === "object");
}

/** What the manifest asks visitors to consent to, one line per purpose. */
export function consentPurposeLines(manifestJson: unknown): ManifestLine[] {
  return entriesOf(manifestJson, "consentPurposes").map((p) => {
    const cookies = Array.isArray(p.cookies)
      ? p.cookies.map((c: { name?: unknown }) => String(c?.name ?? "")).join(", ")
      : "";
    return {
      key: String(p.key),
      text: `${String(p.key)} — ${String(p.category)}${cookies ? ` (${cookies})` : ""}`,
    };
  });
}

/** The admin pages the manifest declares and who may open them. */
export function adminPanelLines(manifestJson: unknown): ManifestLine[] {
  return entriesOf(manifestJson, "adminPanels").map((p) => ({
    key: String(p.slug),
    text: `${String(p.title)} (needs ${String(p.permission)})`,
  }));
}

/** The live-editor toolbar items the manifest declares and who sees them. */
export function toolbarItemLines(manifestJson: unknown): ManifestLine[] {
  return entriesOf(manifestJson, "editorToolbar").map((p) => ({
    key: String(p.id),
    text: `${String(p.title)} (needs ${String(p.permission)})`,
  }));
}
