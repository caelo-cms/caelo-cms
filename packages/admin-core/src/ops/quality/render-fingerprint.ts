// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — what a direct production build would ship that the last
 * quality check did not see.
 *
 * A Stage records the RENDER FINGERPRINT of main at the moment its build
 * starts: one hash per rendering-relevant entity (module code, templates,
 * layouts with their chrome modules, the active theme, active plugins, and
 * each live page's template). A direct production build (Ops "Trigger
 * build", the automatic redeploy) bakes main as it is NOW, so the gate
 * compares the two: any audit-worthy difference — the same rules a chat
 * Stage is classified by (`classifyStageChanges`) — means production would
 * ship unchecked rendering, and the build has to go through a Stage.
 *
 * Main's state is compared, not an operation log: chat writes stay on
 * their branch until they are merged, main writes do not all emit
 * snapshots (`pages.set_status`), and `audit_events` keeps no inputs — but
 * the live rows are exactly what the generator renders.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { classifyStageChanges, type StageChange } from "../../quality/classify.js";
import { uuidList } from "./_shared.js";
import { touchedPageIds } from "./classify_stage.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** `<kind>:<id>` → md5 of what renders. Stored on staging deploy runs. */
export const renderFingerprintSchema = z.record(z.string(), z.string());
export type RenderFingerprint = z.infer<typeof renderFingerprintSchema>;

/** The render fingerprint of main right now (one query). */
export async function computeRenderFingerprint(tx: Tx): Promise<RenderFingerprint> {
  const rows = (await tx.execute(sql`
    SELECT 'module:' || m.id AS k, md5(concat_ws(E'\\x1f', m.html, m.css, m.js)) AS h
    FROM modules m WHERE m.deleted_at IS NULL AND m.chat_branch_id IS NULL
    UNION ALL
    SELECT 'template:' || t.id, md5(concat_ws(E'\\x1f', t.html, t.css, t.layout_id::text,
      (SELECT string_agg(b.name || '@' || b.position, ',' ORDER BY b.position, b.name)
         FROM template_blocks b WHERE b.template_id = t.id)))
    FROM templates t WHERE t.deleted_at IS NULL AND t.chat_branch_id IS NULL
    UNION ALL
    SELECT 'layout:' || l.id, md5(concat_ws(E'\\x1f', l.html, l.css,
      (SELECT string_agg(b.name || '@' || b.position, ',' ORDER BY b.position, b.name)
         FROM layout_blocks b WHERE b.layout_id = l.id),
      (SELECT string_agg(lm.block_name || '@' || lm.position || '=' || lm.module_id, ','
                         ORDER BY lm.block_name, lm.position)
         FROM layout_modules lm WHERE lm.layout_id = l.id)))
    FROM layouts l WHERE l.deleted_at IS NULL AND l.chat_branch_id IS NULL
    UNION ALL
    SELECT 'theme:' || th.id, md5(concat_ws(E'\\x1f', th.tokens::text, th.logo_media_id::text,
      th.logo_dark_media_id::text, th.favicon_media_id::text, th.social_share_media_id::text))
    FROM themes th WHERE th.is_active
    UNION ALL
    SELECT 'plugin:' || pl.id, md5(pl.version)
    FROM plugins pl WHERE pl.status = 'active'
    UNION ALL
    SELECT 'page:' || p.id, md5(p.template_id::text)
    FROM pages p
    WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
  `)) as unknown as { k: string; h: string }[];
  const out: RenderFingerprint = {};
  for (const r of rows) out[r.k] = r.h;
  return out;
}

/** One entity whose rendering differs between two fingerprints. */
interface FingerprintDiff {
  readonly kind: string;
  readonly id: string;
  readonly change: "added" | "changed" | "removed";
}

function diffFingerprints(before: RenderFingerprint, now: RenderFingerprint): FingerprintDiff[] {
  const out: FingerprintDiff[] = [];
  const split = (key: string) => {
    const i = key.indexOf(":");
    return { kind: key.slice(0, i), id: key.slice(i + 1) };
  };
  for (const [key, hash] of Object.entries(now)) {
    const prev = before[key];
    if (prev === undefined) out.push({ ...split(key), change: "added" });
    else if (prev !== hash) out.push({ ...split(key), change: "changed" });
  }
  for (const key of Object.keys(before)) {
    if (!(key in now)) out.push({ ...split(key), change: "removed" });
  }
  return out;
}

async function labels(tx: Tx, diffs: readonly FingerprintDiff[]): Promise<Map<string, string>> {
  const ids = [...new Set(diffs.map((d) => d.id))];
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, display_name AS label FROM modules WHERE id = ANY(${uuidList(ids)})
    UNION ALL SELECT id::text, display_name FROM templates WHERE id = ANY(${uuidList(ids)})
    UNION ALL SELECT id::text, display_name FROM layouts WHERE id = ANY(${uuidList(ids)})
    UNION ALL SELECT id::text, display_name FROM themes WHERE id = ANY(${uuidList(ids)})
    UNION ALL SELECT id::text, slug FROM plugins WHERE id = ANY(${uuidList(ids)})
    UNION ALL SELECT id::text, COALESCE(current_path, title) FROM pages WHERE id = ANY(${uuidList(ids)})
  `)) as unknown as { id: string; label: string }[];
  return new Map(rows.map((r) => [r.id, r.label]));
}

/** Reduce fingerprint differences to the Stage classifier's vocabulary. */
function toStageChanges(
  diffs: readonly FingerprintDiff[],
  names: ReadonlyMap<string, string>,
): StageChange[] {
  const out: StageChange[] = [];
  for (const d of diffs) {
    const label = names.get(d.id) ?? d.id;
    switch (d.kind) {
      case "module":
        out.push({
          entity: "module",
          entityId: d.id,
          label,
          change:
            d.change === "added" ? "created" : d.change === "removed" ? "deleted" : "code_changed",
        });
        break;
      case "template":
      case "layout":
      case "theme":
        // A removed template/layout no longer renders anything; an
        // activated theme shows up as `added` (and the old one `removed`).
        if (d.change !== "removed") out.push({ entity: d.kind, entityId: d.id, label });
        break;
      case "plugin":
        if (d.change !== "removed") {
          out.push({ entity: "pluginConfig", entityId: d.id, label: `plugin ${label}` });
        }
        break;
      case "page":
        out.push({
          entity: "page",
          entityId: d.id,
          label,
          change:
            d.change === "added"
              ? "published"
              : d.change === "removed"
                ? "deleted"
                : "template_changed",
        });
        break;
    }
  }
  return out;
}

export interface UncheckedRendering {
  /** True when main differs from the checked Stage in a way the Stage
   *  rules audit (or there is no checked Stage to compare with). */
  readonly auditNeeded: boolean;
  /** Human-readable reasons, e.g. "module code: Hero". */
  readonly reasons: readonly string[];
  /** Pages those changes render on (audit candidates). */
  readonly pageIds: readonly string[];
}

/**
 * Compare main now with the render fingerprint recorded by a Stage.
 *
 * @param staged - the staging run's recorded fingerprint; null when the
 *   run predates fingerprints, which counts as "never compared" (no
 *   fallback: the caller's next step is a fresh Stage).
 */
export async function uncheckedRenderingSince(
  tx: Tx,
  staged: RenderFingerprint | null,
): Promise<UncheckedRendering> {
  if (staged === null) {
    return {
      auditNeeded: true,
      reasons: ["the last Stage recorded no render fingerprint to compare with"],
      pageIds: [],
    };
  }
  const diffs = diffFingerprints(staged, await computeRenderFingerprint(tx));
  if (diffs.length === 0) return { auditNeeded: false, reasons: [], pageIds: [] };
  const changes = toStageChanges(diffs, await labels(tx, diffs));
  const classification = classifyStageChanges(changes);
  return {
    auditNeeded: classification.auditNeeded,
    reasons: classification.reasons.map((r) => `${r.rule.replace("_", " ")}: ${r.label}`),
    pageIds: await touchedPageIds(tx, changes),
  };
}

/** The fingerprint a staging run recorded, or null (pre-fingerprint run). */
export async function stagedRenderFingerprint(
  tx: Tx,
  deployRunId: string,
): Promise<RenderFingerprint | null> {
  const rows = (await tx.execute(sql`
    SELECT render_fingerprint FROM deploy_runs WHERE id = ${deployRunId}::uuid
  `)) as unknown as { render_fingerprint: unknown }[];
  const raw = rows[0]?.render_fingerprint;
  if (raw === null || raw === undefined) return null;
  return renderFingerprintSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
}
