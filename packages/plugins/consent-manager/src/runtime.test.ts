// SPDX-License-Identifier: MPL-2.0

/**
 * The runtime is inlined into every page as one <script>. Its own source
 * must therefore never spell a closing script tag or an HTML comment
 * opener: the preview would have to ship it base64-encoded (#866), and a
 * page that embeds it verbatim would end the element early.
 */

import { describe, expect, it } from "bun:test";
import { buildRuntimeJs, RUNTIME_CSS } from "./runtime.js";
import { buildTagInjector } from "./tags.js";

describe("consent runtime source", () => {
  it("contains nothing that could end its inline <script>", () => {
    const js = buildRuntimeJs(
      {
        slug: "consent-manager",
        categories: [{ key: "marketing", displayName: "Marketing", required: false }],
        policyVersion: 1,
        recordEndpoint: "/api/plugin/consent-manager/record_consent",
      },
      buildTagInjector([]),
    );
    expect(js).toContain("/api/plugin/consent-manager/record_consent");
    expect(/<\/script|<!--/i.test(js)).toBe(false);
  });
});

describe("consent runtime in an opaque-origin sandbox (#946)", () => {
  it("starts and records a decision although document.cookie throws", () => {
    // The editor previews pages sandboxed WITHOUT allow-same-origin, where
    // reading or writing document.cookie throws a SecurityError. The banner
    // must still ask, and a decision must still reach the server.
    const js = buildRuntimeJs(
      {
        slug: "consent-manager",
        categories: [{ key: "marketing", displayName: "Marketing", required: false }],
        policyVersion: 1,
        recordEndpoint: "/api/plugin/consent-manager/record_consent",
      },
      buildTagInjector([]),
    );
    const classes = new Set<string>();
    const doc = {
      readyState: "complete",
      documentElement: {
        classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      },
      get cookie(): string {
        throw new Error("SecurityError: sandboxed");
      },
      set cookie(_v: string) {
        throw new Error("SecurityError: sandboxed");
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => undefined,
    };
    const beacons: string[] = [];
    const win: {
      caeloConsent?: { grantAll: () => void; isGranted: (key: string) => boolean };
    } = {};
    new Function("document", "window", "navigator", "console", "location", js)(
      doc,
      win,
      { sendBeacon: (url: string) => beacons.push(url) },
      { warn: () => undefined },
      { protocol: "https:", reload: () => undefined },
    );
    expect(classes.has("caelo-consent-ask")).toBe(true);
    expect(win.caeloConsent?.isGranted("marketing")).toBe(false);
    win.caeloConsent?.grantAll();
    expect(beacons).toEqual(["/api/plugin/consent-manager/record_consent"]);
    expect(classes.has("caelo-consent-ask")).toBe(false);
    // The decision holds for the document's lifetime, so the operator sees
    // the accepted state (PR #957 review).
    expect(win.caeloConsent?.isGranted("marketing")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A minimal DOM — just what the runtime touches — so the behaviour a
// visitor sees can be tested without a browser dependency.
// ---------------------------------------------------------------------------

type Listener = (ev: { key?: string; currentTarget: unknown; preventDefault: () => void }) => void;

class FakeEl {
  readonly attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly listeners = new Map<string, Listener[]>();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  checked = false;
  disabled = false;
  /** Whether layout gives it a box (the banner shown by the CSS). */
  visible = true;
  text = "";
  constructor(
    readonly tagName: string,
    attrs: Record<string, string> = {},
    children: FakeEl[] = [],
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    for (const c of children) this.appendChild(c);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  /** Reflects the attribute, as `HTMLElement.lang` does. */
  get lang(): string {
    return this.getAttribute("lang") ?? "";
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  hasAttribute(n: string): boolean {
    return this.attrs.has(n);
  }
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) {
      fn({ currentTarget: this, preventDefault: () => undefined });
    }
  }
  focus(): void {
    if (focusDoc) focusDoc.activeElement = this;
  }
  getClientRects(): unknown[] {
    return this.visible ? [{}] : [];
  }
  contains(el: FakeEl): boolean {
    for (let n: FakeEl | null = el; n; n = n.parent) if (n === this) return true;
    return false;
  }
  descendants(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(sel: string): FakeEl[] {
    const parts = sel.split(",").map((p) => p.trim());
    return this.descendants().filter((el) => parts.some((p) => matches(el, p)));
  }
  querySelector(sel: string): FakeEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

let focusDoc: { activeElement: FakeEl | null } | null = null;

/** `tag[attr][attr="v"]:not([attr="v"])` — the selector forms the runtime uses. */
function matches(el: FakeEl, sel: string): boolean {
  const m = /^([a-z]*)((?:\[[^\]]+\])*)((?::not\(\[[^\]]+\]\))*)$/.exec(sel);
  if (!m) throw new Error(`fake DOM: unsupported selector ${sel}`);
  if (m[1] && el.tagName !== m[1]) return false;
  const attr = (spec: string): boolean => {
    const a = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(spec);
    if (!a) throw new Error(`fake DOM: unsupported attribute selector ${spec}`);
    const v = el.getAttribute(a[1] ?? "");
    return v !== null && (a[2] === undefined || v === a[2]);
  };
  for (const spec of (m[2] ?? "").match(/\[[^\]]+\]/g) ?? []) if (!attr(spec)) return false;
  for (const spec of (m[3] ?? "").match(/\[[^\]]+\]/g) ?? []) if (attr(spec)) return false;
  return true;
}

interface Harness {
  readonly html: FakeEl;
  readonly doc: { activeElement: FakeEl | null; cookie: string };
  readonly jar: Map<string, string>;
  /** Every `domain=` a cookie was expired on, by name. */
  readonly expired: Map<string, string[]>;
  readonly beacons: string[];
  readonly reloads: { count: number };
  readonly win: { caeloConsent?: { open: () => void; isGranted: (k: string) => boolean } };
  keydown(key: string): void;
}

const CATEGORIES = [
  { key: "necessary", displayName: "Necessary", required: true },
  { key: "analytics", displayName: "Analytics", required: false },
  { key: "marketing", displayName: "Marketing", required: false },
];

function consentCookie(granted: string[]): string {
  return encodeURIComponent(JSON.stringify({ granted, policyVersion: 1, at: "x" }));
}

function boot(opts: {
  body: FakeEl[];
  cookies?: Record<string, string>;
  tags?: Parameters<typeof buildTagInjector>[0];
  pathname?: string;
  lang?: string;
}): Harness {
  const jar = new Map(Object.entries(opts.cookies ?? {}));
  const expired = new Map<string, string[]>();
  const docListeners = new Map<string, Listener[]>();
  const body = new FakeEl("body", {}, opts.body);
  const head = new FakeEl("head");
  const html = new FakeEl("html", { lang: opts.lang ?? "en" }, [head, body]);
  const doc = {
    readyState: "complete",
    documentElement: html,
    body,
    head,
    activeElement: body as FakeEl | null,
    get cookie(): string {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(raw: string) {
      const [pair, ...attrs] = raw.split(";");
      const [name, value] = (pair ?? "").split("=");
      if (!name) return;
      if (attrs.some((a) => a.trim() === "max-age=0")) {
        const domain = attrs.find((a) => a.startsWith("domain="))?.slice("domain=".length) ?? "";
        expired.set(name, [...(expired.get(name) ?? []), domain]);
        jar.delete(name);
      } else {
        jar.set(name, value ?? "");
      }
    },
    querySelector: (s: string) => html.querySelector(s),
    querySelectorAll: (s: string) => html.querySelectorAll(s),
    addEventListener: (t: string, fn: Listener) =>
      docListeners.set(t, [...(docListeners.get(t) ?? []), fn]),
    createElement: (t: string) => new FakeEl(t),
  };
  focusDoc = doc;
  const beacons: string[] = [];
  const reloads = { count: 0 };
  const win: Harness["win"] = {};
  const js = buildRuntimeJs(
    {
      slug: "consent-manager",
      categories: CATEGORIES,
      policyVersion: 1,
      recordEndpoint: "/api/plugin/consent-manager/record_consent",
    },
    buildTagInjector(opts.tags ?? []),
  );
  new Function("document", "window", "navigator", "console", "location", "Blob", js)(
    doc,
    win,
    { sendBeacon: (url: string) => beacons.push(url) },
    { warn: () => undefined },
    {
      protocol: "https:",
      hostname: "www.shop.example.co.uk",
      pathname: opts.pathname ?? "/",
      reload: () => {
        reloads.count += 1;
      },
    },
    class {
      constructor(readonly parts: unknown[]) {}
    },
  );
  return {
    html,
    doc,
    jar,
    expired,
    beacons,
    reloads,
    win,
    keydown: (key) => {
      for (const fn of docListeners.get("keydown") ?? []) {
        fn({ key, currentTarget: doc, preventDefault: () => undefined });
      }
    },
  };
}

function bannerWithOpener(): { banner: FakeEl; analytics: FakeEl; accept: FakeEl; opener: FakeEl } {
  const analytics = new FakeEl("input", { "data-consent-category": "analytics" });
  const accept = new FakeEl("button", { "data-consent-accept-all": "" });
  const banner = new FakeEl("div", { "data-consent-banner": "" }, [
    new FakeEl("p"),
    analytics,
    accept,
    new FakeEl("button", { "data-consent-reject-all": "" }),
    new FakeEl("button", { "data-consent-save": "" }),
  ]);
  const opener = new FakeEl("button", { "data-consent-open": "" });
  return { banner, analytics, accept, opener };
}

describe("reopening the banner (#1134, #1128)", () => {
  it("shows the decision as it stands now, not as the page loaded", () => {
    const { banner, analytics, opener } = bannerWithOpener();
    const h = boot({
      body: [banner, opener],
      cookies: { caelo_consent: consentCookie(["necessary", "analytics"]) },
    });
    expect(analytics.checked).toBe(true);
    // Another tab withdrew analytics since this page loaded.
    h.jar.set("caelo_consent", consentCookie(["necessary"]));
    opener.click();
    expect(h.html.classes.has("caelo-consent-open")).toBe(true);
    expect(analytics.checked).toBe(false);
  });

  it("moves focus into the banner, closes on Escape without recording, and returns focus", () => {
    const { banner, analytics, opener } = bannerWithOpener();
    const h = boot({
      body: [banner, opener],
      cookies: { caelo_consent: consentCookie(["necessary"]) },
    });
    opener.focus();
    opener.click();
    // The first control inside the dialog, not the footer link behind it.
    expect(h.doc.activeElement).toBe(analytics);
    h.keydown("Escape");
    expect(h.html.classes.has("caelo-consent-open")).toBe(false);
    expect(h.beacons).toEqual([]);
    expect(h.doc.activeElement).toBe(opener);
  });

  it("does not let Escape dismiss a banner still waiting for a first decision", () => {
    const { banner, opener } = bannerWithOpener();
    const h = boot({ body: [banner, opener] });
    expect(h.html.classes.has("caelo-consent-ask")).toBe(true);
    h.keydown("Escape");
    expect(h.html.classes.has("caelo-consent-ask")).toBe(true);
  });

  it("returns focus to the opener after a choice", () => {
    const { banner, accept, opener } = bannerWithOpener();
    const h = boot({
      body: [banner, opener],
      cookies: { caelo_consent: consentCookie(["necessary"]) },
    });
    opener.click();
    accept.click();
    expect(h.beacons).toHaveLength(1);
    expect(h.html.classes.has("caelo-consent-open")).toBe(false);
    expect(h.doc.activeElement).toBe(opener);
    expect(h.win.caeloConsent?.isGranted("marketing")).toBe(true);
  });

  it("does the same through caeloConsent.open(), focusing the visible banner", () => {
    const hidden = bannerWithOpener();
    hidden.banner.visible = false;
    const shown = bannerWithOpener();
    const h = boot({
      body: [hidden.banner, shown.banner],
      cookies: { caelo_consent: consentCookie(["necessary", "analytics"]) },
    });
    h.jar.set("caelo_consent", consentCookie(["necessary"]));
    h.win.caeloConsent?.open();
    expect(hidden.analytics.checked).toBe(false);
    expect(shown.analytics.checked).toBe(false);
    expect(h.doc.activeElement).toBe(shown.analytics);
  });
});

describe("withdrawing consent deletes the tags' cookies (#1136)", () => {
  const ga = {
    name: "GA4",
    category: "analytics",
    src: "https://www.googletagmanager.com/gtag/js?id=G-ABC123",
    inline: "",
    position: "head" as const,
    cookies: [
      { name: "_ga", prefix: false },
      { name: "_ga_", prefix: true },
    ],
    scope: { include: null, exclude: [], locales: null },
  };

  it("expires every matching cookie on the host and each parent domain, then reloads", () => {
    const { banner, opener } = bannerWithOpener();
    const reject = banner.querySelector("[data-consent-reject-all]");
    const h = boot({
      body: [banner, opener],
      tags: [ga],
      cookies: {
        caelo_consent: consentCookie(["necessary", "analytics"]),
        _ga: "GA1.1.1",
        _ga_ABC123: "GS1.1",
        other: "keep",
      },
    });
    reject?.click();
    expect(h.jar.has("_ga")).toBe(false);
    expect(h.jar.has("_ga_ABC123")).toBe(false);
    expect(h.jar.get("other")).toBe("keep");
    expect(h.jar.has("caelo_consent")).toBe(true);
    // Host-only first, then every suffix with two or more labels — the
    // browser ignores the attempt on the public suffix (co.uk).
    expect(h.expired.get("_ga")).toEqual([
      "",
      "www.shop.example.co.uk",
      "shop.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
    // The tag had loaded, so the page reloads under the narrower decision.
    expect(h.reloads.count).toBe(1);
  });

  it("keeps the cookies of a category that stays granted", () => {
    const { banner, opener } = bannerWithOpener();
    const h = boot({
      body: [banner, opener],
      tags: [ga],
      cookies: { caelo_consent: consentCookie(["necessary"]), _ga: "GA1.1.1" },
    });
    h.win.caeloConsent?.open();
    banner.querySelector("[data-consent-accept-all]")?.click();
    expect(h.jar.get("_ga")).toBe("GA1.1.1");
  });
});

describe("tag scope (#1138)", () => {
  const leadinfo = (scope: {
    include: string[] | null;
    exclude: string[];
    locales: string[] | null;
  }) => ({
    name: "Leadinfo",
    category: "marketing",
    src: "https://cdn.leadinfo.net/ping.js",
    inline: "",
    position: "body_end" as const,
    cookies: [],
    scope,
  });
  const loaded = (h: Harness) =>
    h.html.descendants().some((el) => el.getAttribute("data-caelo-tag") === "Leadinfo");
  const granted = { caelo_consent: consentCookie(["necessary", "marketing"]) };

  it("loads only on the paths and in the language it is scoped to", () => {
    const scope = {
      include: ["/de/seo-monitoring/*", "/de/seo-crawler"],
      exclude: [],
      locales: ["de"],
    };
    expect(
      loaded(
        boot({
          body: [],
          tags: [leadinfo(scope)],
          cookies: granted,
          pathname: "/de/seo-monitoring/a/",
          lang: "de-DE",
        }),
      ),
    ).toBe(true);
    expect(
      loaded(
        boot({
          body: [],
          tags: [leadinfo(scope)],
          cookies: granted,
          pathname: "/de/seo-crawler.html",
          lang: "de",
        }),
      ),
    ).toBe(true);
    expect(
      loaded(
        boot({
          body: [],
          tags: [leadinfo(scope)],
          cookies: granted,
          pathname: "/de/pricing",
          lang: "de",
        }),
      ),
    ).toBe(false);
    expect(
      loaded(
        boot({
          body: [],
          tags: [leadinfo(scope)],
          cookies: granted,
          pathname: "/de/seo-crawler",
          lang: "en",
        }),
      ),
    ).toBe(false);
  });

  it("never loads on an excluded path, and an empty include list means nowhere", () => {
    expect(
      loaded(
        boot({
          body: [],
          tags: [leadinfo({ include: null, exclude: ["/jobs*"], locales: null })],
          cookies: granted,
          pathname: "/jobs/1",
        }),
      ),
    ).toBe(false);
    expect(
      loaded(
        boot({
          body: [],
          tags: [leadinfo({ include: [], exclude: [], locales: null })],
          cookies: granted,
          pathname: "/",
        }),
      ),
    ).toBe(false);
  });
});

describe("banner CSS (#1139)", () => {
  it("only hides, so the module's own display value lays the banner out", () => {
    expect(RUNTIME_CSS).not.toContain("revert");
    expect(RUNTIME_CSS).toBe(
      "html:not(.caelo-consent-ask):not(.caelo-consent-open) [data-consent-banner]{display:none}",
    );
  });
});
