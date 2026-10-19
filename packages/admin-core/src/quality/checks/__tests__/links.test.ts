// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #849 — the core links check. The fixture is a small staged build:
 * a homepage with navigation, a few pages, media files, a redirect table,
 * and the false-positive shapes of #846 (image paths that exist, text that
 * merely looks like a path).
 */

import { describe, expect, it } from "bun:test";
import type { StagedBuild, StagedPage } from "../check.js";
import { findingSchema } from "../findings.js";
import { createLinksCheck, LINKS_CHECK_ID, linkFindings, MAX_PROBES } from "../links.js";
import {
  extractLinks,
  followRedirects,
  indexRedirects,
  pathKey,
  type RedirectRow,
  resolveLink,
  siteHostsOf,
  srcsetUrls,
} from "../links-analysis.js";
import type { LinkLayout, LinkModule } from "../links-fix.js";
import { MAX_FINDINGS_PER_CALL, runFindingChecks } from "../runner.js";
import { stagedBuildAt } from "../staged-build.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BASE = "http://127.0.0.1:4100";

const NAV: LinkModule = {
  id: id(201),
  slug: "nav-menu-main",
  displayName: "Main menu",
  html: '<nav class="menu">{{#items}}<a href="{{href}}">{{label}}</a>{{/items}}</nav>',
};
const CTA: LinkModule = {
  id: id(202),
  slug: "cta",
  displayName: "Call to action",
  html: '<section class="cta"><a href="/contact-us">Talk to us</a><p>{{lead}}</p></section>',
};
const TEXT: LinkModule = {
  id: id(203),
  slug: "text",
  displayName: "Text",
  html: '<section class="prose"><div class="body">{{body}}</div></section>',
};
const LAYOUT: LinkLayout = {
  id: id(301),
  displayName: "Main layout",
  html: '<footer><a href="/imprint-old">Imprint</a></footer><caelo-slot name="content"></caelo-slot>',
};

function mod(m: LinkModule, inner: string): string {
  return `<section data-caelo-module-id="${m.id}">${inner}</section>`;
}

function page(n: number, path: string, body: string, opts: { head?: string } = {}): StagedPage {
  const url = path === "/" ? `${BASE}/` : `${BASE}${path}/`;
  return {
    pageId: id(n),
    path,
    url,
    html: `<!doctype html><html><head>${opts.head ?? ""}</head><body>${mod(
      NAV,
      '<a href="/">Home</a><a href="/about/">About</a>',
    )}<main>${body}</main></body></html>`,
  };
}

/** A staged build whose files are exactly `files` (paths as requested). */
function buildWith(files: readonly string[]): StagedBuild & { probed: string[] } {
  const served = new Set(files);
  const probed: string[] = [];
  return {
    baseUrl: BASE,
    displayBaseUrl: "https://staging.example.com",
    probed,
    async probe(path) {
      probed.push(path);
      return served.has(path) ? { found: true, status: 200 } : { found: false, status: 404 };
    },
  };
}

const INPUT = {
  modules: [NAV, CTA, TEXT],
  layouts: [LAYOUT],
  redirects: [] as RedirectRow[],
  siteUrls: ["https://example.com", "www.example.com"],
};

const HOME = page(1, "/", mod(TEXT, '<a href="/team">Team</a>'));
const ABOUT = page(2, "/about", mod(TEXT, "<p>About us.</p>"));
const TEAM = page(3, "/team", mod(TEXT, "<p>The team.</p>"));

async function findingsOf(
  pages: readonly StagedPage[],
  opts: { files?: string[]; redirects?: RedirectRow[] } = {},
) {
  const build = buildWith(opts.files ?? []);
  const findings = await linkFindings(pages, build, {
    ...INPUT,
    redirects: opts.redirects ?? [],
  });
  for (const f of findings) expect(findingSchema.safeParse(f).success).toBe(true);
  return { findings, probed: build.probed };
}

const rules = (fs: { ruleId: string; pageId?: string }[], pageId?: string) =>
  fs.filter((f) => pageId === undefined || f.pageId === pageId).map((f) => f.ruleId);

describe("links/broken-internal", () => {
  it("a link to a path nothing serves is an error naming the page, the href and the fix", async () => {
    const about = page(2, "/about", mod(TEXT, '<p>See <a href="/pricng">pricing</a>.</p>'));
    const { findings } = await findingsOf([HOME, about, TEAM]);
    const broken = findings.filter((f) => f.ruleId === "links/broken-internal");
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ severity: "error", pageId: about.pageId });
    expect(broken[0]?.message).toStartWith("Broken link: ");
    expect(broken[0]?.message).toContain('a[href] "/pricng"');
    expect(broken[0]?.message).toContain('content value of module "Text"');
    expect(broken[0]?.message).toContain("nothing is served at /pricng");
    expect(broken[0]?.fix?.tool).toBe("set_page_module_content");
    expect(broken[0]?.fix?.hint).toContain("bulk_create_redirects");
  });

  it("pages answer to every form: trailing slash, index.html, query, fragment, relative", async () => {
    const home = page(
      1,
      "/",
      mod(
        TEXT,
        [
          '<a href="/about">a</a>',
          '<a href="/about/">b</a>',
          '<a href="/about/index.html">c</a>',
          '<a href="/about?ref=home#team">d</a>',
          '<a href="team">e</a>',
          '<a href="./team/">f</a>',
          '<a href="https://example.com/team">g</a>',
          '<a href="https://www.example.com/about/">h</a>',
          '<a href="https://staging.example.com/team/">i</a>',
          `<a href="${BASE}/about/">j</a>`,
        ].join(""),
      ),
    );
    const { findings, probed } = await findingsOf([home, ABOUT, TEAM]);
    expect(rules(findings, home.pageId)).toEqual([]);
    expect(probed).toEqual([]);
  });

  it("the same broken href twice on a page is one finding with a count", async () => {
    const about = page(2, "/about", mod(TEXT, '<a href="/gone">x</a><a href="/gone">y</a>'));
    const { findings } = await findingsOf([HOME, about, TEAM]);
    const broken = findings.filter((f) => f.ruleId === "links/broken-internal");
    expect(broken).toHaveLength(1);
    expect(broken[0]?.message).toContain("(2× on this page)");
  });

  it("a canonical or hreflang link to a missing page is a broken internal link", async () => {
    const about = page(2, "/about", "", {
      head: '<link rel="canonical" href="https://example.com/about-us/"><link rel="alternate" hreflang="de" href="/de/ueber-uns/">',
    });
    const { findings } = await findingsOf([HOME, about, TEAM]);
    expect(rules(findings, about.pageId).sort()).toEqual([
      "links/broken-internal",
      "links/broken-internal",
    ]);
  });
});

describe("links/broken-asset and #846 regressions", () => {
  it("existing image paths (src, srcset, picture, og:image) are never flagged", async () => {
    const about = page(
      2,
      "/about",
      mod(
        TEXT,
        '<picture><source srcset="/media/hero-800.webp 800w, /media/hero-1600.webp 1600w" type="image/webp"><img src="/media/hero.jpg" srcset="/media/hero-800.jpg 1x, /media/hero-1600.jpg 2x" alt=""></picture>',
      ),
      {
        head: '<link rel="stylesheet" href="/_assets/site.3f2a.css"><meta property="og:image" content="https://example.com/media/hero.jpg"><script src="/_assets/app.js" defer></script>',
      },
    );
    const files = [
      "/media/hero-800.webp",
      "/media/hero-1600.webp",
      "/media/hero.jpg",
      "/media/hero-800.jpg",
      "/media/hero-1600.jpg",
      "/_assets/site.3f2a.css",
      "/_assets/app.js",
    ];
    const { findings, probed } = await findingsOf([HOME, about, TEAM], { files });
    expect(rules(findings, about.pageId)).toEqual([]);
    expect(new Set(probed)).toEqual(new Set(files));
  });

  it("text that merely looks like a path is never a link and never probed", async () => {
    const about = page(
      2,
      "/about",
      mod(
        TEXT,
        '<p>Visit /shop/xyz for details.</p><svg><text>/shop/abc</text></svg><code>/media/missing.png</code><div data-path="/nope" title="/nope2">x</div><!-- <a href="/commented"> -->',
      ),
    );
    const { findings, probed } = await findingsOf([HOME, about, TEAM]);
    expect(rules(findings, about.pageId)).toEqual([]);
    expect(probed).toEqual([]);
  });

  it("a missing image is a broken asset with the media hint", async () => {
    const about = page(2, "/about", mod(TEXT, '<img src="/media/deleted.webp" alt="x">'));
    const { findings } = await findingsOf([HOME, about, TEAM]);
    const asset = findings.find((f) => f.ruleId === "links/broken-asset");
    expect(asset).toMatchObject({ severity: "error", pageId: about.pageId });
    expect(asset?.message).toStartWith("Missing file: ");
    expect(asset?.message).toContain('img[src] "/media/deleted.webp"');
    expect(asset?.fix?.hint).toContain("find_media");
  });

  it("an unbound theme asset placeholder points at set_theme_asset", async () => {
    const about = page(2, "/about", '<img src="{{theme_logo_url}}" alt="logo">');
    const { findings } = await findingsOf([HOME, about, TEAM]);
    const asset = findings.find((f) => f.ruleId === "links/broken-asset");
    expect(asset?.fix?.tool).toBe("set_theme_asset");
  });
});

describe("what is out of scope", () => {
  it("external links, other schemes, fragments and gateway paths are not checked", async () => {
    const about = page(
      2,
      "/about",
      mod(
        TEXT,
        [
          '<a href="https://other.example.org/x">x</a>',
          '<a href="//cdn.example.net/a.js">x</a>',
          '<a href="mailto:hi@example.com">x</a>',
          '<a href="tel:+491234">x</a>',
          '<a href="javascript:void(0)">x</a>',
          '<a href="#top">x</a>',
          '<a href="">x</a>',
          '<img src="data:image/png;base64,AAAA" alt="">',
          '<a href="/api/plugin/forms/submit">x</a>',
          '<script src="/api/captcha/challenge"></script>',
        ].join(""),
      ),
    );
    const { findings, probed } = await findingsOf([HOME, about, TEAM]);
    expect(rules(findings, about.pageId)).toEqual([]);
    expect(probed).toEqual([]);
  });

  it("resolves against <base href>", async () => {
    const about = page(2, "/about", '<a href="team">x</a>', {
      head: `<base href="${BASE}/">`,
    });
    const { findings } = await findingsOf([HOME, about, TEAM]);
    expect(rules(findings, about.pageId)).toEqual([]);
  });
});

describe("redirects", () => {
  const redirects: RedirectRow[] = [
    { fromPath: "/old-team", toPath: "/team", statusCode: 301 },
    { fromPath: "/older-team", toPath: "/old-team", statusCode: 301 },
    { fromPath: "/a", toPath: "/b", statusCode: 301 },
    { fromPath: "/b", toPath: "/a/", statusCode: 302 },
    { fromPath: "/retired", toPath: "/nowhere", statusCode: 301 },
    { fromPath: "/dead", toPath: "/dead", statusCode: 410 },
    { fromPath: "/about", toPath: "/elsewhere", statusCode: 301 },
  ];

  it("a link through one redirect, or a chain, is a warning naming the final URL", async () => {
    const about = page(
      2,
      "/about",
      mod(TEXT, '<a href="/old-team">x</a><a href="/older-team/">y</a>'),
    );
    const { findings } = await findingsOf([HOME, about, TEAM], { redirects });
    const chains = findings.filter((f) => f.ruleId === "links/redirect-chain");
    expect(chains.map((f) => f.severity)).toEqual(["warning", "warning"]);
    expect(chains[0]?.message).toStartWith("Link through a redirect: ");
    expect(chains[0]?.message).toContain("/old-team → /team (301)");
    expect(chains[1]?.message).toStartWith("Link through a redirect chain: ");
    expect(chains[1]?.message).toContain("/older-team → /old-team (301) → /team (301)");
    expect(chains[1]?.fix?.hint).toContain('"/team"');
  });

  it("a redirect cycle is an error; a redirect to nothing or 410 is a broken link", async () => {
    const about = page(
      2,
      "/about",
      mod(TEXT, '<a href="/a">x</a><a href="/retired">y</a><a href="/dead">z</a>'),
    );
    const { findings } = await findingsOf([HOME, about, TEAM], { redirects });
    expect(rules(findings, about.pageId).sort()).toEqual([
      "links/broken-internal",
      "links/broken-internal",
      "links/redirect-loop",
    ]);
    const loop = findings.find((f) => f.ruleId === "links/redirect-loop");
    expect(loop?.message).toContain("/a → /b (301) → /a/ (302)");
    expect(loop?.fix?.tool).toBe("bulk_create_redirects");
    const retired = findings.find((f) => f.message.includes('"/retired"'));
    expect(retired?.message).toContain("It redirects /retired → /nowhere (301)");
    const dead = findings.find((f) => f.message.includes('"/dead"'));
    expect(dead?.message).toContain("410 Gone");
  });

  it("a live page wins over a redirect row for the same path", async () => {
    const home = page(1, "/", mod(TEXT, '<a href="/about">x</a><a href="/team">t</a>'));
    const { findings } = await findingsOf([home, ABOUT, TEAM], { redirects });
    expect(rules(findings)).toEqual([]);
  });

  it("followRedirects is pure and bounded", () => {
    const hosts = siteHostsOf([BASE]);
    const idx = indexRedirects(redirects);
    const isPage = (k: string) => k === "/team";
    expect(followRedirects("/team", idx, isPage, BASE, hosts)).toEqual({ kind: "none" });
    expect(followRedirects("/a", idx, isPage, BASE, hosts).kind).toBe("loop");
    const ext = followRedirects(
      "/x",
      indexRedirects([{ fromPath: "/x", toPath: "https://other.org/", statusCode: 301 }]),
      isPage,
      BASE,
      hosts,
    );
    expect(ext).toMatchObject({ kind: "redirect", end: { kind: "off-site" } });
  });
});

describe("links/orphan-page", () => {
  it("a page nothing links to is a warning; homepage, 404 page and redirect-reached pages are not", async () => {
    const lonely = page(4, "/lonely", mod(TEXT, '<a href="/lonely">self</a>'));
    const moved = page(5, "/moved", "");
    const notFound: StagedPage = {
      ...page(6, "/not-found", ""),
      url: `${BASE}/404.html`,
      notFoundPage: true,
    };
    const home = page(1, "/", mod(TEXT, '<a href="/team">t</a><a href="/was-moved">m</a>'));
    const { findings } = await findingsOf([home, ABOUT, TEAM, lonely, moved, notFound], {
      redirects: [{ fromPath: "/was-moved", toPath: "/moved", statusCode: 301 }],
    });
    const orphans = findings.filter((f) => f.ruleId === "links/orphan-page");
    expect(orphans.map((f) => f.pageId)).toEqual([lonely.pageId]);
    expect(orphans[0]).toMatchObject({ severity: "warning" });
    expect(orphans[0]?.fix?.tool).toBe("set_structured_set");
  });

  it("links in <link> or <img> do not make a page reachable", async () => {
    const home = page(1, "/", "", { head: '<link rel="alternate" href="/team/">' });
    const { findings } = await findingsOf([home, ABOUT, TEAM]);
    expect(findings.filter((f) => f.ruleId === "links/orphan-page").map((f) => f.pageId)).toEqual([
      TEAM.pageId,
    ]);
  });
});

describe("where the fix goes", () => {
  it("navigation, module template, layout and template chrome each name their tool", async () => {
    const home: StagedPage = {
      pageId: id(1),
      path: "/",
      url: `${BASE}/`,
      html: `<html><body>${mod(NAV, '<a href="/about/">About</a><a href="/blog/">Blog</a>')}${mod(
        CTA,
        '<a href="/contact-us">Talk</a>',
      )}<a href="/team">Team</a><footer><a href="/imprint-old">Imprint</a><a href="/mystery">?</a></footer></body></html>`,
    };
    const { findings } = await findingsOf([home, ABOUT, TEAM]);
    const toolOf = (href: string) =>
      findings.find((f) => f.message.includes(`"${href}"`))?.fix?.tool;
    expect(toolOf("/blog/")).toBe("set_structured_set");
    expect(findings.find((f) => f.message.includes('"/blog/"'))?.fix?.hint).toContain(
      "nav-menu/main",
    );
    expect(toolOf("/contact-us")).toBe("edit_content");
    expect(toolOf("/imprint-old")).toBe("propose_update_layout");
    expect(toolOf("/mystery")).toBe("grep_content");
  });

  it("output of a plugin points at the plugin", async () => {
    const about = page(
      2,
      "/about",
      '<div data-caelo-plugin="forms" data-page-id="x"><a href="/thanks">ok</a></div>',
    );
    const { findings } = await findingsOf([HOME, about, TEAM]);
    expect(findings.find((f) => f.ruleId === "links/broken-internal")?.fix?.tool).toBe(
      "get_plugin",
    );
  });
});

describe("bounds", () => {
  it("findings past the runner's limit are summarised, errors first", async () => {
    const many = Array.from({ length: 600 }, (_, i) => `<a href="/missing-${i}">x</a>`).join("");
    const about = page(2, "/about", mod(TEXT, many));
    const { findings } = await findingsOf([HOME, about, TEAM]);
    expect(findings).toHaveLength(MAX_FINDINGS_PER_CALL);
    expect(findings[0]?.severity).toBe("error");
    expect(findings.at(-1)).toMatchObject({ ruleId: "links/limit-reached", severity: "info" });
  });

  it("URLs beyond the probe budget are reported as not verified", async () => {
    // Spread over two pages: one page alone stops at MAX_LINKS_PER_PAGE.
    const imgs = (from: number, to: number) =>
      Array.from(
        { length: to - from },
        (_, i) => `<img src="/media/f-${from + i}.webp" alt="">`,
      ).join("");
    const half = Math.floor(MAX_PROBES / 2);
    const pages = [
      page(1, "/", mod(TEXT, `<a href="/about">a</a>${imgs(0, half)}`)),
      page(2, "/about", mod(TEXT, imgs(half, MAX_PROBES + 3))),
    ];
    const files = Array.from({ length: MAX_PROBES + 3 }, (_, i) => `/media/f-${i}.webp`);
    const { findings, probed } = await findingsOf(pages, { files });
    expect(probed).toHaveLength(MAX_PROBES);
    const info = findings.find((f) => f.ruleId === "links/limit-reached");
    expect(info?.message).toContain("3 same-site URL(s)");
  });
});

describe("createLinksCheck", () => {
  const entry = (check: ReturnType<typeof createLinksCheck>) => [
    {
      kind: "findings" as const,
      id: check.id,
      title: check.title,
      scope: "site" as const,
      source: { kind: "core" as const },
      check,
    },
  ];

  it("runs through the runner as a valid site check", async () => {
    const check = createLinksCheck({
      modules: async () => INPUT.modules,
      layouts: async () => INPUT.layouts,
      redirects: async () => [],
      siteUrls: async () => INPUT.siteUrls,
    });
    expect(check.id).toBe(LINKS_CHECK_ID);
    const about = page(2, "/about", mod(TEXT, '<a href="/nope">x</a>'));
    const result = await runFindingChecks(entry(check), [HOME, about, TEAM], buildWith([]));
    expect(result.errors).toEqual([]);
    expect(result.findings.map((f) => f.ruleId)).toEqual(["links/broken-internal"]);
  });

  it("staging failing to answer fails the check loudly instead of guessing", async () => {
    const check = createLinksCheck({
      modules: async () => [],
      layouts: async () => [],
      redirects: async () => [],
      siteUrls: async () => [],
    });
    const failing: StagedBuild = {
      baseUrl: BASE,
      probe: async () => {
        throw new Error("staging answered 502 for /media/x.webp");
      },
    };
    const about = page(2, "/about", '<img src="/media/x.webp" alt="">');
    const result = await runFindingChecks(entry(check), [HOME, about, TEAM], failing);
    expect(result.findings).toEqual([]);
    expect(result.errors[0]?.message).toContain("502");
  });
});

describe("links-analysis helpers", () => {
  it("srcsetUrls follows the candidate grammar (commas inside URLs stay)", () => {
    expect(srcsetUrls("/a.jpg 1x, /b.jpg 2x")).toEqual(["/a.jpg", "/b.jpg"]);
    expect(srcsetUrls("/a,b.jpg 100w,/c.jpg 200w")).toEqual(["/a,b.jpg", "/c.jpg"]);
    expect(srcsetUrls(" /only.jpg ")).toEqual(["/only.jpg"]);
    // A URL is a run of non-whitespace: without a space this is ONE URL.
    expect(srcsetUrls("/x.jpg,/y.jpg")).toEqual(["/x.jpg,/y.jpg"]);
    expect(srcsetUrls("/x.jpg, /y.jpg 2x")).toEqual(["/x.jpg", "/y.jpg"]);
  });

  it("pathKey folds the forms one page answers to", () => {
    expect(pathKey("/")).toBe("/");
    expect(pathKey("/index.html")).toBe("/");
    expect(pathKey("/about/")).toBe("/about");
    expect(pathKey("/about/index.html")).toBe("/about");
    expect(pathKey("/caf%C3%A9")).toBe("/café");
  });

  it("resolveLink keeps only same-site http(s) paths outside the gateway", () => {
    const hosts = siteHostsOf([BASE, "https://example.com"]);
    expect(resolveLink("/x?y#z", `${BASE}/`, hosts)).toEqual({
      kind: "same-site",
      requestPath: "/x",
      key: "/x",
    });
    expect(resolveLink("https://EXAMPLE.com/a/", `${BASE}/`, hosts)).toMatchObject({
      key: "/a",
    });
    expect(resolveLink("/api", `${BASE}/`, hosts)).toEqual({ kind: "skip", reason: "runtime" });
    expect(resolveLink("http://[bad", `${BASE}/`, hosts)).toEqual({
      kind: "skip",
      reason: "malformed",
    });
  });

  it("extractLinks attributes each URL to its module or plugin", () => {
    const r = extractLinks(
      `<a href="/top">t</a><div data-caelo-module-id="${CTA.id}"><a href="/in">i</a><br><img src="/i.png"></div><a href="/after">a</a>`,
    );
    expect(r.links.map((l) => [l.raw, l.moduleId])).toEqual([
      ["/top", null],
      ["/in", CTA.id],
      ["/i.png", CTA.id],
      ["/after", null],
    ]);
  });
});

describe("stagedBuildAt", () => {
  const fakeFetch = (answer: (method: string, url: string) => number | Error) => {
    const calls: string[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      const a = answer(method, url);
      if (a instanceof Error) throw a;
      return new Response(method === "HEAD" ? null : "body", { status: a });
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it("2xx is found, 404/410 missing, HEAD refused falls back to GET", async () => {
    const f = fakeFetch((method, url) =>
      url.endsWith("/head-refused")
        ? method === "HEAD"
          ? 405
          : 200
        : url.endsWith("/a")
          ? 200
          : 404,
    );
    const build = stagedBuildAt({ baseUrl: `${BASE}/` }, f.fn);
    expect(await build.probe("/a")).toEqual({ found: true, status: 200 });
    expect(await build.probe("/b")).toEqual({ found: false, status: 404 });
    expect(await build.probe("/head-refused")).toEqual({ found: true, status: 200 });
    expect(f.calls).toContain(`GET ${BASE}/head-refused`);
  });

  it("other statuses and repeated network failures throw; one dropped connection is retried", async () => {
    let first = true;
    const flaky = fakeFetch(() => {
      if (first) {
        first = false;
        return new Error("socket hang up");
      }
      return 200;
    });
    expect(await stagedBuildAt({ baseUrl: BASE }, flaky.fn).probe("/x")).toEqual({
      found: true,
      status: 200,
    });
    const down = fakeFetch(() => new Error("ECONNREFUSED"));
    await expect(stagedBuildAt({ baseUrl: BASE }, down.fn).probe("/x")).rejects.toThrow(
      "staging did not answer for /x",
    );
    const broken = fakeFetch(() => 502);
    await expect(stagedBuildAt({ baseUrl: BASE }, broken.fn).probe("/x")).rejects.toThrow(
      "staging answered 502",
    );
    await expect(stagedBuildAt({ baseUrl: BASE }, broken.fn).probe("x")).rejects.toThrow(
      "root-relative",
    );
  });
});
