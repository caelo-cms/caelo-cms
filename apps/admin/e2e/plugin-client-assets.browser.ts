// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — what a plugin's client files can do in a visitor's real browser
 * (docs/dev/external-plugin-brokers.md §6.7, decision Q4 B).
 *
 * The review refuses a third-party URL it can read in a client file; a URL
 * the file computes at runtime it cannot read, so the site's CSP, derived
 * by the build from the grant's origins, is what stops it. A script whose
 * plugin needs consent does not load until the visitor gives it. Data a
 * build hands a file cannot end its data block and become a script.
 *
 * The fixture (apps/api-gateway/e2e/client-assets-site.ts) assembles the
 * page with the plugin host's own functions and serves it with the
 * enforced CSP the build composes; it needs no database.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = resolve(REPO_ROOT, "apps/api-gateway/e2e/client-assets-site.ts");

let proc: ChildProcess | null = null;
let url = "";

test.beforeAll(async () => {
  const child = spawn("bun", ["--no-env-file", FIXTURE], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ["ignore", "pipe", "inherit"],
  });
  proc = child;
  const ready = await new Promise<string>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error("client-assets fixture not ready in 60s")),
      60_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`client-assets fixture exited (${code})`));
    });
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      if (!line.startsWith("READY ")) return;
      clearTimeout(timer);
      done(line);
    });
  });
  const [, port, path] = ready.split(" ");
  url = `http://127.0.0.1:${port}${path}`;
});

test.afterAll(async () => {
  if (!proc || proc.exitCode !== null) return;
  const child = proc;
  await new Promise<void>((done) => {
    child.once("exit", () => done());
    child.kill("SIGTERM");
  });
});

/** Third-party hosts, answered here if a request ever leaves the browser. */
async function thirdParties(page: Page): Promise<{ approved: number; collector: number }> {
  const hits = { approved: 0, collector: 0 };
  await page.route("https://approved.example/**", (route) => {
    hits.approved += 1;
    return route.fulfill({
      status: 200,
      body: "ok",
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await page.route("https://collector.example/**", (route) => {
    hits.collector += 1;
    return route.fulfill({
      status: 200,
      body: "stolen",
      headers: { "access-control-allow-origin": "*" },
    });
  });
  return hits;
}

test("the CSP lets a client file reach its granted origin and blocks every other", async ({
  page,
}) => {
  const hits = await thirdParties(page);
  await page.goto(url);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-approved", "ok");
  await expect(html).toHaveAttribute("data-collector", "blocked");
  await expect(html).toHaveAttribute("data-violations", /connect-src https:\/\/collector\.example/);
  expect(hits).toEqual({ approved: 1, collector: 0 });
});

test("build data cannot end its data block and become a script", async ({ page }) => {
  await thirdParties(page);
  await page.goto(url);
  const html = page.locator("html");
  // The probe read the text back exactly; nothing of it ran.
  await expect(html).toHaveAttribute(
    "data-note",
    "</script><script>document.documentElement.setAttribute('data-pwned','1')</script><!--",
  );
  await expect(html).not.toHaveAttribute("data-pwned", "1");
});

test("a script that needs consent loads only after the visitor gives it", async ({ page }) => {
  await thirdParties(page);
  const gatedRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/_caelo/plugin/probe-gated/")) gatedRequests.push(req.url());
  });
  await page.goto(url);
  const html = page.locator("html");
  // The consent runtime ran (the banner asks) and the probe settled.
  await expect(html).toHaveClass(/caelo-consent-ask/);
  await expect(html).toHaveAttribute("data-approved", "ok");
  expect(gatedRequests).toEqual([]);
  await expect(html).not.toHaveAttribute("data-gated", "ran");

  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(html).toHaveAttribute("data-gated", "ran");
  expect(gatedRequests).toHaveLength(1);

  // A later page view starts it from the stored decision, once.
  gatedRequests.length = 0;
  await page.reload();
  await expect(html).toHaveAttribute("data-gated", "ran");
  expect(gatedRequests).toHaveLength(1);
});
