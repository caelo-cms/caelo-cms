// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #849 — the core `links` check: every same-site URL a page of the
 * staged build references must be served by that build (#727 rollout D;
 * maintainer decision: link integrity is a core check like Lighthouse and
 * `structure`, not a plugin add-on).
 *
 * The staged build is the ground truth. The DB-level scan
 * (ops/content/link-integrity.ts) reads stored values and misses layouts,
 * field defaults and plugin output (#724, #846); here the
 * question is only "does a visitor following this URL get a 404?".
 *
 * Rules:
 * - `links/broken-internal` (error): a link to a page (`a`, `area`,
 *   canonical / hreflang `link`) that nothing in the build serves —
 *   directly or at the end of its redirects.
 * - `links/broken-asset` (error): an image, stylesheet, script, media or
 *   other file reference the build does not contain.
 * - `links/redirect-loop` (error): the URL runs into a redirect cycle.
 * - `links/redirect-chain` (warning): the URL works only through the
 *   redirect table — link the final URL directly.
 * - `links/orphan-page` (warning): no other page links to this one, the
 *   navigation included.
 * - `links/limit-reached` (info): the bounds below cut the check short;
 *   says what was not verified, never silently.
 *
 * How a URL is resolved (links-analysis.ts): pages of the build first (a
 * live page beats a redirect, #575), then the redirect table, then a probe
 * of the staged origin for everything else (assets, media, generated
 * files). `/api/*` belongs to the gateway and is never checked.
 */

import { truncateKeepingIds } from "@caelo-cms/shared";
import type { SiteCheck, StagedBuild, StagedPage } from "./check.js";
import type { Finding } from "./findings.js";
import {
  extractLinks,
  followRedirects,
  indexRedirects,
  type LinkKind,
  pathKey,
  type RedirectHop,
  type RedirectRow,
  resolveLink,
  type SameSiteUrl,
  siteHostsOf,
} from "./links-analysis.js";
import {
  describeOrigin,
  fixFor,
  type LinkLayout,
  type LinkModule,
  type OriginContext,
} from "./links-fix.js";
import { MAX_FINDINGS_PER_CALL } from "./runner.js";

export const LINKS_CHECK_ID = "links";

/** One call may probe this long: hundreds of asset URLs over the network. */
export const LINKS_CHECK_TIMEOUT_MS = 240_000;
/** Most distinct same-site paths probed on the staged origin per audit. */
export const MAX_PROBES = 5_000;
/** Probes in flight at once. */
export const PROBE_CONCURRENCY = 8;

/** Where the check reads what the build was rendered from (main = staged). */
export interface LinkSources {
  modules(): Promise<readonly LinkModule[]>;
  layouts(): Promise<readonly LinkLayout[]>;
  redirects(): Promise<readonly RedirectRow[]>;
  /** The site base URL and the public domains: absolute links there are same-site. */
  siteUrls(): Promise<readonly string[]>;
  /**
   * #724 (rollout F) — the stored links to unpublished pages the
   * `references` check reports (a draft target blocks Publish live there).
   * A rendered link this check can trace to one of them is skipped, so one
   * defect is one finding; every other link to a draft page — plugin
   * output, a literal whose redirects end at a draft — stays
   * `links/broken-internal`, because nothing else blocks on it.
   */
  reportedDraftLinks(): Promise<readonly ReportedDraftLink[]>;
}

/** One stored link to a draft page, as the `references` check reports it. */
export interface ReportedDraftLink {
  /** The draft page's path. */
  readonly targetPath: string;
  /** Pages the link renders on; empty = every page (site-wide chrome). */
  readonly pageIds: readonly string[];
  /** What renders it, matched against the rendered link's module / plugin stamp. */
  readonly origin: ReportedDraftLinkOrigin;
}

export type ReportedDraftLinkOrigin =
  /** A module's HTML, field value or field default. */
  | { readonly kind: "module"; readonly moduleId: string }
  /** Plugin data named through the link-locations hook. */
  | { readonly kind: "plugin"; readonly pluginSlug: string }
  /** Layout or template markup: outside every module. */
  | { readonly kind: "chrome" }
  /**
   * Shared list entries, list type sources or page properties (epic
   * #1107): data any module on the page may render, so inside some module.
   */
  | { readonly kind: "list-data" };

/** What one same-site URL resolved to. */
type Resolution =
  | { readonly kind: "page"; readonly pageId: string; readonly hops: readonly RedirectHop[] }
  | { readonly kind: "file"; readonly hops: readonly RedirectHop[] }
  | { readonly kind: "off-site"; readonly hops: readonly RedirectHop[] }
  | {
      readonly kind: "missing";
      readonly path: string;
      readonly gone: boolean;
      readonly hops: readonly RedirectHop[];
    }
  | { readonly kind: "loop"; readonly hops: readonly RedirectHop[] }
  | { readonly kind: "unverified" };

interface Occurrence {
  readonly page: StagedPage;
  readonly raw: string;
  readonly where: string;
  readonly kind: LinkKind;
  readonly navigational: boolean;
  readonly moduleId: string | null;
  readonly pluginSlug: string | null;
  readonly listItem: string | null;
  readonly target: SameSiteUrl;
}

/** Build the core links check over the given sources. */
export function createLinksCheck(sources: LinkSources): SiteCheck {
  return {
    id: LINKS_CHECK_ID,
    title: "Links",
    scope: "site",
    timeoutMs: LINKS_CHECK_TIMEOUT_MS,
    async run({ pages, build }) {
      const [modules, layouts, redirects, siteUrls, reportedDraftLinks] = await Promise.all([
        sources.modules(),
        sources.layouts(),
        sources.redirects(),
        sources.siteUrls(),
        sources.reportedDraftLinks(),
      ]);
      return linkFindings(pages, build, {
        modules,
        layouts,
        redirects,
        siteUrls,
        reportedDraftLinks,
      });
    },
  };
}

/** The findings of one staged build. Exported for tests. */
export async function linkFindings(
  pages: readonly StagedPage[],
  build: StagedBuild,
  input: {
    readonly modules: readonly LinkModule[];
    readonly layouts: readonly LinkLayout[];
    readonly redirects: readonly RedirectRow[];
    readonly siteUrls: readonly string[];
    readonly reportedDraftLinks: readonly ReportedDraftLink[];
  },
): Promise<Finding[]> {
  const hosts = siteHostsOf([build.baseUrl, build.displayBaseUrl, ...input.siteUrls]);
  const pageByKey = new Map(pages.map((p) => [pathKey(new URL(p.url).pathname), p]));
  const redirects = indexRedirects(input.redirects);
  const limits: string[] = [];

  const occurrences: Occurrence[] = [];
  for (const page of pages) {
    const extracted = extractLinks(page.html);
    if (extracted.truncated) limits.push(`${page.path} has more URLs than the check reads`);
    const base = documentBase(page.url, extracted.baseHref);
    for (const link of extracted.links) {
      const target = resolveLink(link.raw, base, hosts);
      if (target.kind === "skip") continue;
      occurrences.push({ ...link, page, target });
    }
  }

  const resolutions = await resolveAll(
    occurrences.map((o) => o.target),
    { pageByKey, redirects, base: build.baseUrl, hosts },
    build,
  );
  const unverified = [...resolutions.values()].filter((r) => r.kind === "unverified").length;
  if (unverified > 0) {
    limits.push(`${unverified} same-site URL(s) beyond the first ${MAX_PROBES} were not probed`);
  }

  const ctx: OriginContext = {
    modules: new Map(input.modules.map((m) => [m.id, m])),
    layouts: input.layouts,
  };
  const findings = [
    ...linkProblems(occurrences, resolutions, ctx, input.reportedDraftLinks),
    ...orphanPages(pages, occurrences, resolutions),
  ];
  if (limits.length > 0) {
    findings.push({
      ruleId: "links/limit-reached",
      severity: "info",
      message: clip(
        `Links not fully checked: ${limits.join("; ")}. Those URLs were not verified on this Stage.`,
      ),
    });
  }
  return capped(findings);
}

function documentBase(pageUrl: string, baseHref: string | null): string {
  if (baseHref === null) return pageUrl;
  try {
    return new URL(baseHref, pageUrl).href;
  } catch {
    return pageUrl;
  }
}

interface ResolveCtx {
  readonly pageByKey: ReadonlyMap<string, StagedPage>;
  readonly redirects: ReadonlyMap<string, RedirectRow>;
  readonly base: string;
  readonly hosts: ReadonlySet<string>;
}

/** Resolve every distinct request path; probes run bounded and in parallel. */
async function resolveAll(
  targets: readonly SameSiteUrl[],
  ctx: ResolveCtx,
  build: StagedBuild,
): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  // request path → the path to probe and the hops that led there.
  const toProbe = new Map<string, { path: string; hops: readonly RedirectHop[] }>();
  const isPage = (key: string) => ctx.pageByKey.has(key);
  for (const t of targets) {
    if (out.has(t.requestPath) || toProbe.has(t.requestPath)) continue;
    const page = ctx.pageByKey.get(t.key);
    if (page) {
      out.set(t.requestPath, { kind: "page", pageId: page.pageId, hops: [] });
      continue;
    }
    const r = followRedirects(t.key, ctx.redirects, isPage, ctx.base, ctx.hosts);
    if (r.kind === "none") {
      toProbe.set(t.requestPath, { path: t.requestPath, hops: [] });
    } else if (r.kind === "loop") {
      out.set(t.requestPath, { kind: "loop", hops: r.hops });
    } else if (r.end.kind === "gone") {
      out.set(t.requestPath, { kind: "missing", path: t.requestPath, gone: true, hops: r.hops });
    } else if (r.end.kind === "off-site") {
      out.set(t.requestPath, { kind: "off-site", hops: r.hops });
    } else {
      const end = ctx.pageByKey.get(r.end.key);
      if (end) out.set(t.requestPath, { kind: "page", pageId: end.pageId, hops: r.hops });
      else toProbe.set(t.requestPath, { path: r.end.requestPath, hops: r.hops });
    }
  }

  const entries = [...toProbe];
  const probed = new Map<string, boolean>();
  const paths = [...new Set(entries.map(([, v]) => v.path))];
  const budget = paths.slice(0, MAX_PROBES);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const path = budget[next++];
      if (path === undefined) return;
      probed.set(path, (await build.probe(path)).found);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, budget.length) }, () => worker()),
  );
  for (const [requestPath, { path, hops }] of entries) {
    const found = probed.get(path);
    if (found === undefined) out.set(requestPath, { kind: "unverified" });
    else if (found) out.set(requestPath, { kind: "file", hops });
    else out.set(requestPath, { kind: "missing", path, gone: false, hops });
  }
  return out;
}

/** One finding per page, rule and URL; repeats on the page are counted. */
function linkProblems(
  occurrences: readonly Occurrence[],
  resolutions: ReadonlyMap<string, Resolution>,
  ctx: OriginContext,
  reported: readonly ReportedDraftLink[],
): Finding[] {
  const reportedByPath = new Map<string, ReportedDraftLink[]>();
  for (const d of reported) {
    const key = pathKey(d.targetPath);
    reportedByPath.set(key, [...(reportedByPath.get(key) ?? []), d]);
  }
  const groups = new Map<string, { first: Occurrence; ruleId: string; count: number }>();
  for (const o of occurrences) {
    const r = resolutions.get(o.target.requestPath);
    const ruleId = r ? ruleOf(o.kind, r) : null;
    if (!ruleId) continue;
    // A stored link to a draft page is the `references` check's finding
    // (#724 F) — but only that one: anything else ending at a draft page
    // ships a 404 that only this finding blocks.
    if (
      ruleId === "links/broken-internal" &&
      r?.kind === "missing" &&
      (reportedByPath.get(pathKey(r.path)) ?? []).some((d) => reportedHere(d, o))
    ) {
      continue;
    }
    const key = `${o.page.pageId}\u0000${ruleId}\u0000${o.target.requestPath}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { first: o, ruleId, count: 1 });
  }
  const findings: Finding[] = [];
  for (const { first: o, ruleId, count } of groups.values()) {
    const r = resolutions.get(o.target.requestPath) as Resolution;
    const ref = `${o.where} "${o.raw}" ${describeOrigin(o, ctx)}${count > 1 ? ` (${count}× on this page)` : ""}`;
    findings.push({
      ruleId,
      severity: ruleId === "links/redirect-chain" ? "warning" : "error",
      pageId: o.page.pageId,
      message: clip(messageOf(ruleId, ref, r)),
      fix: fixFor(ruleId, o, ctx, finalTarget(r)),
    });
  }
  return findings;
}

/** True when the rendered link `o` is the stored draft link `d` renders. */
function reportedHere(d: ReportedDraftLink, o: Occurrence): boolean {
  if (d.pageIds.length > 0 && !d.pageIds.includes(o.page.pageId)) return false;
  switch (d.origin.kind) {
    case "plugin":
      return o.pluginSlug === d.origin.pluginSlug;
    case "module":
      return o.pluginSlug === null && o.moduleId === d.origin.moduleId;
    case "chrome":
      return o.pluginSlug === null && o.moduleId === null;
    case "list-data":
      return o.pluginSlug === null && o.moduleId !== null;
  }
}

function ruleOf(kind: LinkKind, r: Resolution): string | null {
  switch (r.kind) {
    case "missing":
      return kind === "page" ? "links/broken-internal" : "links/broken-asset";
    case "loop":
      return "links/redirect-loop";
    case "page":
    case "file":
    case "off-site":
      return r.hops.length > 0 ? "links/redirect-chain" : null;
    case "unverified":
      return null;
  }
}

function chain(hops: readonly RedirectHop[]): string {
  if (hops.length === 0) return "";
  const first = hops[0] as RedirectHop;
  return [first.from, ...hops.map((h) => `${h.to} (${h.status})`)].join(" → ");
}

function finalTarget(r: Resolution): string | null {
  const last = "hops" in r ? r.hops[r.hops.length - 1] : undefined;
  return r.kind === "missing" || r.kind === "loop" ? null : (last?.to ?? null);
}

function messageOf(ruleId: string, ref: string, r: Resolution): string {
  const hops = "hops" in r ? r.hops : [];
  if (r.kind === "loop") {
    return `Redirect loop: ${ref} runs into the redirect cycle ${chain(hops)} → … — visitors get "too many redirects".`;
  }
  if (r.kind === "missing") {
    const label = ruleId === "links/broken-asset" ? "Missing file" : "Broken link";
    const via = hops.length > 0 ? ` It redirects ${chain(hops)}, and` : "";
    const what = r.gone
      ? `the redirect table answers 410 Gone for ${r.path}`
      : `nothing is served at ${r.path} on the staged build (no published page, file or redirect)`;
    return `${label}: ${ref} leads to a 404.${via} ${what}.`;
  }
  const label = hops.length > 1 ? "Link through a redirect chain" : "Link through a redirect";
  return `${label}: ${ref} goes ${chain(hops)}. Link the final URL directly — every hop costs visitors a round-trip and crawlers link equity.`;
}

/** Pages no other page links to (homepage and 404 page excepted). */
function orphanPages(
  pages: readonly StagedPage[],
  occurrences: readonly Occurrence[],
  resolutions: ReadonlyMap<string, Resolution>,
): Finding[] {
  const linked = new Set<string>();
  for (const o of occurrences) {
    if (!o.navigational) continue;
    const r = resolutions.get(o.target.requestPath);
    if (r?.kind === "page" && r.pageId !== o.page.pageId) linked.add(r.pageId);
  }
  return pages
    .filter((p) => !p.notFoundPage && pathKey(p.path) !== "/" && !linked.has(p.pageId))
    .map((p) => ({
      ruleId: "links/orphan-page",
      severity: "warning" as const,
      pageId: p.pageId,
      message:
        "Orphan page: no other page of the staged build links here (navigation included), so visitors cannot reach it and crawlers find it only through the sitemap.",
      fix: {
        tool: "set_page_module_content",
        hint: "link the page from a menu list or from a related page's content (set_page_module_content); a page meant to stay unlinked (an ad landing page) can keep this warning",
      },
    }));
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/** Errors first; past the runner's limit, the rest is summarised, not dropped silently. */
function capped(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  if (sorted.length <= MAX_FINDINGS_PER_CALL) return sorted;
  const kept = sorted.slice(0, MAX_FINDINGS_PER_CALL - 1);
  const rest = sorted.length - kept.length;
  kept.push({
    ruleId: "links/limit-reached",
    severity: "info",
    message: `More link findings: ${rest} further finding(s) are not listed on this Stage. Fix the listed ones (a shared link is often one fix for many pages) and Stage again to see the rest.`,
  });
  return kept;
}

function clip(message: string): string {
  return truncateKeepingIds(message, 1000);
}
