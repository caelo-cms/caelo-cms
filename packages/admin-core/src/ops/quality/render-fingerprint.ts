// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — what a direct production build would ship that the last
 * quality check did not see.
 *
 * A Stage records the RENDER FINGERPRINT of main at the moment its build
 * starts: one hash per rendering-relevant entity (module code, templates,
 * layouts with their chrome modules, the active theme, active plugins, the
 * site settings that render into pages, and each live page's template). A
 * direct production build (Ops "Trigger build", Owner-initiated) bakes main
 * as it is NOW, so the gate
 * compares the two: any audit-worthy difference — the same rules a chat
 * Stage is classified by (`classifyStageChanges`) — means production would
 * ship unchecked rendering, and the build has to go through a Stage.
 *
 * Main's state is compared, not an operation log: chat writes stay on
 * their branch until they are merged, main writes do not all emit
 * snapshots (`pages.set_status`), and `audit_events` keeps no inputs — but
 * the live rows are exactly what the generator renders.
 */

import { type defineOperation, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { classifyStageChanges, type StageChange } from "../../quality/classify.js";
import { touchedPageIds } from "./classify_stage.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** `<kind>:<id>` → md5 of what renders. Stored on staging deploy runs. */
export const renderFingerprintSchema = z.record(z.string(), z.string());
export type RenderFingerprint = z.infer<typeof renderFingerprintSchema>;

/**
 * The `site_defaults` columns that reach a page or a build file, by the
 * classification in docs/dev/redirects-and-settings-sync.md. Everything
 * else on the row is authoring state (site name, purpose, design brief,
 * default layout), which renders nothing and must not force a Stage. The
 * usage threshold only counts while the CDN copy is on. A pending home or
 * 404 page is not here: it changes nothing on main until its page merges,
 * and that merge moves it to the pointer.
 */
const RENDERED_SITE_SETTINGS = {
  site_base_url: { label: "site base URL", value: sql`sd.site_base_url` },
  sitemap_enabled: { label: "sitemap", value: sql`sd.sitemap_enabled::text` },
  organization_json: { label: "Organization JSON-LD", value: sql`sd.organization_json::text` },
  site_language: { label: "site language", value: sql`sd.site_language` },
  media_cdn_copy_enabled: {
    label: "media CDN copy",
    value: sql`sd.media_cdn_copy_enabled::text`,
  },
  media_cdn_usage_threshold: {
    label: "media CDN threshold",
    value: sql`CASE WHEN sd.media_cdn_copy_enabled THEN sd.media_cdn_usage_threshold::text END`,
  },
  home_page_id: { label: "home page", value: sql`sd.home_page_id::text` },
  not_found_page_id: { label: "404 page", value: sql`sd.not_found_page_id::text` },
} as const;

type RenderedSiteSetting = keyof typeof RENDERED_SITE_SETTINGS;

function isRenderedSiteSetting(id: string): id is RenderedSiteSetting {
  return Object.hasOwn(RENDERED_SITE_SETTINGS, id);
}

/** One `setting:<column>` row per rendered setting. */
function renderedSettingRows() {
  return sql.join(
    Object.entries(RENDERED_SITE_SETTINGS).map(
      ([column, setting]) =>
        sql`SELECT ${`setting:${column}`} AS k, md5(COALESCE(${setting.value}, '')) AS h FROM site_defaults sd WHERE sd.id = 1`,
    ),
    sql` UNION ALL `,
  );
}

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
    UNION ALL
    ${renderedSettingRows()}
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
  // A setting's id is its column name, labelled by RENDERED_SITE_SETTINGS.
  const ids = [...new Set(diffs.filter((d) => d.kind !== "setting").map((d) => d.id))];
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, display_name AS label FROM modules WHERE id = ANY(${uuidArray(ids)})
    UNION ALL SELECT id::text, display_name FROM templates WHERE id = ANY(${uuidArray(ids)})
    UNION ALL SELECT id::text, display_name FROM layouts WHERE id = ANY(${uuidArray(ids)})
    UNION ALL SELECT id::text, display_name FROM themes WHERE id = ANY(${uuidArray(ids)})
    UNION ALL SELECT id::text, slug FROM plugins WHERE id = ANY(${uuidArray(ids)})
    UNION ALL SELECT id::text, COALESCE(current_path, title) FROM pages WHERE id = ANY(${uuidArray(ids)})
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
      case "setting":
        if (isRenderedSiteSetting(d.id)) {
          out.push({
            entity: "siteSetting",
            entityId: d.id,
            label: RENDERED_SITE_SETTINGS[d.id].label,
          });
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

/** Why a Stage from before the settings fingerprint refuses once. */
const SETTINGS_NOT_RECORDED =
  "the last Stage was made before this Caelo version recorded site settings, so it cannot show they were checked. Nothing is wrong with the site, and Publish live is not affected: one new Stage records them";

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
  const allDiffs = diffFingerprints(staged, await computeRenderFingerprint(tx));
  // A Stage made before settings were recorded has none of their keys. They
  // would all read as "added" although nobody changed them, so say what is
  // really true: that Stage cannot vouch for them, and one Stage fixes it.
  const predatesSettings = !Object.keys(staged).some((k) => k.startsWith("setting:"));
  const diffs = predatesSettings ? allDiffs.filter((d) => d.kind !== "setting") : allDiffs;
  if (diffs.length === 0 && !predatesSettings) {
    return { auditNeeded: false, reasons: [], pageIds: [] };
  }
  const changes = toStageChanges(diffs, await labels(tx, diffs));
  const classification = classifyStageChanges(changes);
  const reasons = classification.reasons.map((r) => `${r.rule.replace("_", " ")}: ${r.label}`);
  return {
    auditNeeded: predatesSettings || classification.auditNeeded,
    reasons: predatesSettings ? [SETTINGS_NOT_RECORDED, ...reasons] : reasons,
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
  return renderFingerprintSchema.parse(raw);
}
