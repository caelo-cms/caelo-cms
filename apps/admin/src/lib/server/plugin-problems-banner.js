// SPDX-License-Identifier: MPL-2.0
/** Both kinds in one list, for the banner. */
export function previewPluginProblems(notRunning, renderFailures) {
    return [
        ...notRunning.map((p) => ({ ...p, kind: "not-running" })),
        ...(renderFailures ?? []).map((p) => ({ ...p, kind: "render-failed" })),
    ];
}
function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
function describeProblem(p) {
    const what = p.kind === "render-failed"
        ? "runs on this server but failed while rendering this page"
        : "is active but could not be loaded on this server";
    return `<li><strong>${escapeHtml(p.slug)}</strong> ${what}: ${escapeHtml(p.reason)}</li>`;
}
/** The banner markup for `problems`, or "" when every active plugin runs. */
export function pluginProblemsBanner(problems) {
    if (problems.length === 0)
        return "";
    const items = problems.map(describeProblem).join("");
    const plural = new Set(problems.map((p) => p.slug)).size > 1;
    return (`<div data-caelo-plugin-problems role="alert" style="position:sticky;top:0;z-index:2147483647;` +
        `margin:0;padding:10px 14px;background:#7f1d1d;color:#fff;font:14px/1.4 system-ui,sans-serif">` +
        `<p style="margin:0 0 4px;font-weight:600">This preview is missing ${plural ? "plugins" : "a plugin"}, ` +
        `so the page is shown without ${plural ? "their contributions" : "its contribution"}. ` +
        `Publish live is blocked until ${plural ? "they work" : "it works"}.</p>` +
        `<ul style="margin:0 0 4px 18px;padding:0">${items}</ul>` +
        `<p style="margin:0">Settings → Plugins shows the error and has “Reload on all servers”.</p></div>`);
}
/** `html` with the banner right after `<body …>` (or prepended without one). */
export function withPluginProblemsBanner(html, problems) {
    const banner = pluginProblemsBanner(problems);
    if (banner === "")
        return html;
    const body = /<body\b[^>]*>/i.exec(html);
    if (!body)
        return banner + html;
    const at = body.index + body[0].length;
    return html.slice(0, at) + banner + html.slice(at);
}
