// SPDX-License-Identifier: MPL-2.0

/**
 * #677 — `caelo_visitor_id` exists only for a plugin that declares the
 * `visitor_id` consent purpose, and only after the visitor granted that
 * purpose's category.
 *
 * Ratings is the plugin that declares it (`functional`: one rating per
 * visitor and page). So with ratings running, the cookie appears after the
 * visitor allows functional cookies — not after "reject all", not after
 * allowing only analytics — and goes again when they withdraw. Without a
 * declaring plugin, even "accept all" never sets it: nothing on the site
 * needs it.
 *
 * Only a real browser shows what a visitor ends up holding (the cookie is
 * HttpOnly, set on a beacon response) and what it sends back, so this
 * drives Chromium against a generated site.
 *
 * Topology, as production wires it: one origin serves the static build
 * and routes `/api/*` to the API gateway. The fixture
 * (apps/api-gateway/e2e/consent-site.ts) generates a page with a consent
 * banner through the real static generator — the consent-manager runtime
 * is injected exactly as on a live build — and serves it next to the real
 * gateway, booted as public_role only (no cms_admin login, #635).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VISITOR_COOKIE = "caelo_visitor_id";

// One fixture process owns the shared database at a time.
test.describe.configure({ mode: "serial" });

/** Start the consent-site fixture; resolves with its process and page URL. */
async function startFixture(withRatings: boolean): Promise<{ proc: ChildProcess; url: string }> {
  for (const name of ["ADMIN_DATABASE_URL", "PUBLIC_ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL"]) {
    if (!process.env[name]) throw new Error(`${name} is required (see ci.yml e2e)`);
  }
  const proc = spawn("bun", ["--no-env-file", "apps/api-gateway/e2e/consent-site.ts"], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL,
      PUBLIC_ADMIN_DATABASE_URL: process.env.PUBLIC_ADMIN_DATABASE_URL,
      PUBLIC_DATABASE_URL: process.env.PUBLIC_DATABASE_URL,
      // The browser talks to the fixture directly: no proxy in front.
      CAELO_TRUSTED_PROXY_HOPS: "0",
      CONSENT_SITE_RATINGS: withRatings ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = await new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error("consent site fixture not ready in 120s")),
      120_000,
    );
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`consent site fixture exited (${code})`));
    });
    const lines = createInterface({ input: proc.stdout as NodeJS.ReadableStream });
    lines.on("line", (line) => {
      if (!line.startsWith("READY ")) return;
      clearTimeout(timer);
      resolveReady(line);
    });
  });
  const [, port, path] = ready.split(" ");
  return { proc, url: `http://127.0.0.1:${port}${path}` };
}

/** Stop a fixture; SIGTERM makes it restore the shared database first. */
async function stopFixture(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((done) => {
    proc.once("exit", () => done());
    proc.kill("SIGTERM");
  });
}

/** Every request the page sends with its Cookie header, and every Set-Cookie it receives. */
function watchCookies(page: Page): {
  sent: string[];
  received: string[];
  settle: () => Promise<void>;
} {
  const sent: string[] = [];
  const received: string[] = [];
  const pending: Promise<void>[] = [];
  page.on("request", (req) => {
    pending.push(
      req.allHeaders().then((h) => {
        sent.push(`${req.method()} ${req.url()} cookie=${h.cookie ?? ""}`);
      }),
    );
  });
  page.on("response", (res) => {
    pending.push(
      res.headersArray().then((headers) => {
        for (const h of headers) {
          if (h.name.toLowerCase() === "set-cookie") received.push(`${res.url()} ${h.value}`);
        }
      }),
    );
  });
  return {
    sent,
    received,
    settle: async () => {
      await Promise.all(pending);
    },
  };
}

/** Click a banner control and wait until its record_consent beacon completed. */
async function decide(page: Page, control: string): Promise<void> {
  const recorded = page.waitForEvent("requestfinished", (r) =>
    r.url().endsWith("/api/plugin/consent-manager/record_consent"),
  );
  await page.locator(`[data-consent-banner] ${control}`).click();
  await recorded;
}

/** Tick exactly `categories` in the banner and save, waiting for the beacon. */
async function grantOnly(page: Page, categories: string[]): Promise<void> {
  for (const key of ["functional", "analytics"]) {
    const box = page.locator(`[data-consent-banner] [data-consent-category="${key}"]`);
    if (categories.includes(key)) await box.check();
    else await box.uncheck();
  }
  await decide(page, "[data-consent-save]");
}

async function visitorCookie(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name === VISITOR_COOKIE);
}

async function grantedCategories(context: BrowserContext): Promise<string[]> {
  const consent = (await context.cookies()).find((c) => c.name === "caelo_consent");
  return JSON.parse(decodeURIComponent(consent?.value ?? "{}")).granted ?? [];
}

test.describe("with ratings, which declares the visitor-id purpose (functional)", () => {
  let fixture: ChildProcess | null = null;
  let pageUrl = "";

  test.beforeAll(async () => {
    const started = await startFixture(true);
    fixture = started.proc;
    pageUrl = started.url;
  });

  test.afterAll(async () => {
    await stopFixture(fixture);
  });

  test("after 'reject all' the visitor holds no caelo_visitor_id and never sends one (#677)", async ({
    context,
    page,
  }) => {
    const seen = watchCookies(page);
    await page.goto(pageUrl);
    await expect(page.locator("[data-consent-banner]")).toBeVisible();

    await decide(page, "[data-consent-reject-all]");
    await expect(page.locator("[data-consent-banner]")).toBeHidden();

    // More gateway traffic after the decision: a fresh page view and the
    // captcha challenge a form would fetch before submitting.
    await page.reload();
    await expect(page.locator("[data-consent-banner]")).toBeHidden();
    const status = await page.evaluate(async () => {
      const r = await fetch("/api/captcha/challenge", { credentials: "same-origin" });
      return r.status;
    });
    expect([200, 204]).toContain(status);
    await seen.settle();

    expect(await grantedCategories(context)).toEqual(["necessary"]);
    expect(await visitorCookie(context)).toBeUndefined();
    expect(seen.sent.some((s) => s.includes("/api/plugin/consent-manager/record_consent"))).toBe(
      true,
    );
    expect(seen.sent.filter((s) => s.includes(`${VISITOR_COOKIE}=`))).toEqual([]);
    expect(seen.received.filter((s) => s.includes(`${VISITOR_COOKIE}=`))).toEqual([]);
  });

  test("allowing only analytics sets no caelo_visitor_id: ratings declared it functional", async ({
    context,
    page,
  }) => {
    await page.goto(pageUrl);
    await grantOnly(page, ["analytics"]);
    const granted = await grantedCategories(context);
    expect(granted).toContain("analytics");
    expect(granted).not.toContain("functional");
    expect(await visitorCookie(context)).toBeUndefined();
    // The site's analytics tag runs once analytics is granted.
    expect(
      await page.evaluate(() => (window as { __caeloE2eAnalytics?: boolean }).__caeloE2eAnalytics),
    ).toBe(true);
  });

  test("allowing functional sets caelo_visitor_id; withdrawing in the banner deletes it (#677)", async ({
    context,
    page,
  }) => {
    await page.goto(pageUrl);
    await grantOnly(page, ["functional"]);
    // The control: with functional consent the gateway does set it — so the
    // absences above are the consent gate, not a harness that cannot see it.
    await expect.poll(async () => (await visitorCookie(context))?.httpOnly).toBe(true);

    await page.locator("[data-consent-open]").click();
    await expect(page.locator("[data-consent-banner]")).toBeVisible();
    await decide(page, "[data-consent-reject-all]");
    await expect.poll(async () => await visitorCookie(context)).toBeUndefined();
  });
});

test.describe("without a plugin that declares the visitor-id purpose", () => {
  let fixture: ChildProcess | null = null;
  let pageUrl = "";

  test.beforeAll(async () => {
    const started = await startFixture(false);
    fixture = started.proc;
    pageUrl = started.url;
  });

  test.afterAll(async () => {
    await stopFixture(fixture);
  });

  test("'accept all' never sets caelo_visitor_id: nothing on the site needs it", async ({
    context,
    page,
  }) => {
    const seen = watchCookies(page);
    await page.goto(pageUrl);
    await decide(page, "[data-consent-accept-all]");
    await page.reload();
    await seen.settle();
    // Accept-all grants what the banner offers: analytics (the site's tag),
    // not functional — nothing on this site uses it without ratings.
    const granted = await grantedCategories(context);
    expect(granted).toContain("analytics");
    expect(granted).not.toContain("functional");
    expect(await visitorCookie(context)).toBeUndefined();
    expect(seen.received.filter((s) => s.includes(`${VISITOR_COOKIE}=`))).toEqual([]);
  });
});
