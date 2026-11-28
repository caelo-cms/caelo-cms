// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: the core kind `redirects`. It writes through
 * `redirects.create_many`, so imported rules are pending changes like every
 * other save (Staged: on staging at once, live with the next Publish live,
 * #1550) and the redirect checks all apply. Release `target`: the redirect
 * store has its own drafts.
 *
 * Only the rules the import saved become its rows. An address that already
 * had a rule is refused unless the call says `mode: "update"`, and a rule
 * equal to the live one is left alone, so an undo never removes a rule the
 * import did not write. An undo removes the saved rules as pending
 * removals; a rule an update replaced is not brought back.
 */

import { execute } from "@caelo-cms/query-api";
import { redirectAddress } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import type { ImportKind, ImportWriteRow } from "./kinds.js";

/** Most rules `redirects.create_many` and `redirects.delete_many` take. */
const BATCH = 500;

export const redirectsImportKind: ImportKind = {
  owner: "core",
  writeBatch: BATCH,
  declaration: {
    kind: "redirects",
    label: "Redirects",
    description:
      "Redirect rules from another system, saved as pending changes (Staged: on staging now, live with the next Publish live).",
    sources:
      "WordPress: Yoast, Rank Math or the Redirection plugin export CSV/JSON; also .htaccess `Redirect`/`RewriteRule` lines and nginx `return 301` maps. Use the old path as sourceKey.",
    release: "target",
    fields: {
      fromPath: {
        type: "path",
        description: "The old address on this site, e.g. /2019/05/hello (strip the domain).",
      },
      toPath: {
        type: "path",
        description:
          "Where it goes on this site. Another domain: propose_external_redirect, one rule at a time.",
      },
      statusCode: {
        type: "enum",
        values: ["301", "302", "307", "308", "410"],
        optional: true,
        description: "301 when empty.",
      },
    },
  },
  write: async (w, _importId, rows) => {
    // Updates of this import's own rules and new rules go separately: an
    // upsert would also replace a rule someone else saved at a new row's
    // address.
    const outcomes = new Map<string, string>();
    for (const group of [rows.filter((r) => !r.update), rows.filter((r) => r.update)]) {
      if (group.length === 0) continue;
      const r = await execute(w.registry, w.adapter, w.ctx, "redirects.create_many", {
        redirects: group.map(redirectOf),
        upsert: group[0]?.update === true,
        goLive: "next_publish",
      });
      if (!r.ok) return { ok: false, message: describeError(r.error) };
      for (const c of (r.value as { changes: { fromPath: string; outcome: string }[] }).changes)
        outcomes.set(redirectAddress(c.fromPath), c.outcome);
    }
    const written = new Map<string, string | null>();
    const refused: { rowId: string; detail: string }[] = [];
    for (const row of rows) {
      const from = String(row.values.fromPath);
      const address = redirectAddress(from);
      const outcome = outcomes.get(address);
      if (outcome === "pending") written.set(row.rowId, address);
      else if (outcome === "unchanged")
        refused.push({ rowId: row.rowId, detail: `${from} already has exactly this rule live` });
      else if (address === redirectAddress(String(row.values.toPath)))
        refused.push({ rowId: row.rowId, detail: `${from} points to itself` });
      else
        refused.push({
          rowId: row.rowId,
          detail: `${from} already has a redirect another import or edit saved; change it in Settings -> Redirects or with bulk_create_redirects`,
        });
    }
    return { ok: true, written, refused };
  },
  remove: async (w, _importId, targetRefs) => {
    const paths = targetRefs.filter((x): x is string => typeof x === "string");
    for (let i = 0; i < paths.length; i += BATCH) {
      const r = await execute(w.registry, w.adapter, w.ctx, "redirects.delete_many", {
        fromPaths: paths.slice(i, i + BATCH),
      });
      if (!r.ok) throw new Error(`redirects.delete_many failed: ${describeError(r.error)}`);
    }
  },
};

function redirectOf(row: ImportWriteRow) {
  return {
    fromPath: String(row.values.fromPath),
    toPath: String(row.values.toPath),
    statusCode: row.values.statusCode === null ? 301 : Number(row.values.statusCode),
  };
}
