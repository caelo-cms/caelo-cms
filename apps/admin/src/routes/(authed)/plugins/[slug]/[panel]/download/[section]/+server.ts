// SPDX-License-Identifier: MPL-2.0

/**
 * The CSV download of a plugin panel's table (`download` in its
 * declaration), with the filters the table shows. Same gate as the panel:
 * 404 while the plugin is not active, the panel's permission otherwise.
 * The plugin's operation produces the CSV (quoting, formula guards); the
 * host only serves it as an attachment, never as a page.
 */

import { error } from "@sveltejs/kit";
import { valueAt } from "#lib/plugin-panels.js";
import { findSection, panelCaller, requirePanel, tableArgs } from "#lib/server/plugin-panels.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const panel = requirePanel(locals, params.slug, params.panel);
  const section = findSection(panel, params.section, "table");
  const download = section.download;
  if (!download) throw error(404, "This table has no download.");
  // The filters, not the page: a download is the whole filtered view.
  const { filterArgs } = tableArgs(section, url);
  const r = await panelCaller(locals, params.slug)(download.operation, {
    ...filterArgs,
    ...section.args,
    ...download.args,
  });
  if (!r.ok) throw error(502, `The plugin could not export this table: ${r.message}`);
  const csv = valueAt(r.value, download.csvKey);
  if (typeof csv !== "string") {
    throw error(
      502,
      `The plugin's ${download.operation} answer has no CSV at "${download.csvKey}".`,
    );
  }
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${download.filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
};
