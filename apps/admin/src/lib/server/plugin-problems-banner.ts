// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — the editor preview says so when an active plugin does not run.
 *
 * A plugin that failed to load on this server stays active (its Owner's
 * decision), and the preview keeps rendering — editors keep working — but
 * the page then lacks that plugin's contribution (localized links, consent
 * banner, …). A preview that silently looks "fine" would be exactly the
 * hidden fallback CLAUDE.md §2 rules out, so the preview document carries a
 * banner naming each such plugin and the way out. Publish live refuses the
 * same state (admin-core deploy gate). Preview documents only — published
 * output never gets it.
 */

import type { PluginNotRunning } from "@caelo-cms/plugin-host";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The banner markup for `problems`, or "" when every active plugin runs. */
export function pluginProblemsBanner(problems: ReadonlyArray<PluginNotRunning>): string {
  if (problems.length === 0) return "";
  const items = problems
    .map((p) => `<li><strong>${escapeHtml(p.slug)}</strong>: ${escapeHtml(p.reason)}</li>`)
    .join("");
  return (
    `<div data-caelo-plugin-problems role="alert" style="position:sticky;top:0;z-index:2147483647;` +
    `margin:0;padding:10px 14px;background:#7f1d1d;color:#fff;font:14px/1.4 system-ui,sans-serif">` +
    `<p style="margin:0 0 4px;font-weight:600">This preview is missing ${problems.length === 1 ? "a plugin" : `${problems.length} plugins`}: ` +
    `${problems.length === 1 ? "it is" : "they are"} active but could not be loaded on this server, so the page is shown without ${problems.length === 1 ? "it" : "them"}. ` +
    `Publish live is blocked until ${problems.length === 1 ? "it runs" : "they run"}.</p>` +
    `<ul style="margin:0 0 4px 18px;padding:0">${items}</ul>` +
    `<p style="margin:0">Settings → Plugins shows the error and has “Reload on all servers”.</p></div>`
  );
}

/** `html` with the banner right after `<body …>` (or prepended without one). */
export function withPluginProblemsBanner(
  html: string,
  problems: ReadonlyArray<PluginNotRunning>,
): string {
  const banner = pluginProblemsBanner(problems);
  if (banner === "") return html;
  const body = /<body\b[^>]*>/i.exec(html);
  if (!body) return banner + html;
  const at = body.index + body[0].length;
  return html.slice(0, at) + banner + html.slice(at);
}
