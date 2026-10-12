// SPDX-License-Identifier: MPL-2.0

/**
 * #649 — A/B variant routing in a real browser.
 *
 * `/api/variant.js` used to read the visitor id from `document.cookie`,
 * but the gateway sets `caelo_visitor_id` HttpOnly, so in a browser the
 * script returned before asking for a variant and every visitor saw the
 * control page. Only a real browser enforces HttpOnly, so only a browser
 * test catches it.
 *
 * Topology, as production wires it: one origin serves the static page
 * and routes `/api/*` to the API gateway (the LB's path-prefix rule,
 * CLAUDE.md §11.B). Here a small Node server plays the static host and
 * the LB; the gateway is the real `server.ts`, booted as gateway_role.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { runBunInline } from "./helpers.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const P = "e2e649";
const EXP = `${P}-hero`;
const PAGE = `/${P}-page`;

let gateway: ChildProcess | null = null;
let site: Server | null = null;
let siteOrigin = "";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function seed(action: "create" | "delete"): void {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const p = process.env.E2E_PREFIX;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM experiments WHERE slug LIKE \${p + "-%"}\`;
      await tx\`DELETE FROM pages WHERE slug LIKE \${p + "-%"}\`;
      if (process.env.E2E_ACTION !== "create") return;
      const [tpl] = await tx\`SELECT id::text AS id FROM templates LIMIT 1\`;
      if (!tpl) throw new Error("no seeded template");
      const [page] = await tx\`
        INSERT INTO pages (slug, title, template_id, current_path)
        VALUES (\${p + "-page"}, 'Experiment page', \${tpl.id}::uuid, \${"/" + p + "-page"})
        RETURNING id::text AS id\`;
      const variants = JSON.stringify([
        { label: "control", weight: 0.5 },
        { label: "b", weight: 0.5 },
      ]);
      await tx\`
        INSERT INTO experiments (slug, page_id, variants, status, started_at)
        VALUES (\${p + "-hero"}, \${page.id}::uuid, (\${variants}::text)::jsonb, 'active', now())\`;
    });
    await sql.end();
  `,
    { E2E_PREFIX: P, E2E_ACTION: action },
  );
}

/** Boot the real gateway with only its own credentials (§2: never admin_role). */
async function startGateway(port: number): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    PORT: String(port),
    GATEWAY_DATABASE_URL: process.env.GATEWAY_DATABASE_URL,
    PUBLIC_DATABASE_URL: process.env.PUBLIC_DATABASE_URL,
  };
  gateway = spawn("bun", ["--no-env-file", "apps/api-gateway/src/server.ts"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error(`gateway exited (${gateway.exitCode})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("gateway did not become healthy within 60s");
}

function html(main: string, withScript: boolean): string {
  const script = withScript
    ? `<script src="/api/variant.js" data-experiment="${EXP}" data-page="${PAGE}"></script>`
    : "";
  return `<!doctype html><html><head><title>t</title></head><body><main>${main}</main>${script}</body></html>`;
}

/**
 * The gateway paths the page uses, matched exactly. The proxy forwards
 * only these constants, never the request's own URL, so the harness
 * cannot be pointed anywhere else.
 */
const SCRIPT_PATH = "/api/variant.js";
const ASSIGN_PATH = `/api/variant/assign?exp=${EXP}`;

/** Static files this site serves: the page, and one file per variant. */
const STATIC_FILES = new Map<string, string>([
  [PAGE, html("as served", true)],
  ...["control", "b"].map(
    (label) => [`/_variants/${EXP}__${label}${PAGE}`, html(`variant ${label}`, false)] as const,
  ),
]);

async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayPort: number,
  target: string,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string" && k !== "host" && k !== "connection") headers.set(k, v);
  }
  const upstream = await fetch(`http://127.0.0.1:${gatewayPort}${target}`, {
    method: req.method,
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
  const out: Record<string, string | string[]> = {};
  upstream.headers.forEach((v, k) => {
    if (k !== "set-cookie" && k !== "content-encoding" && k !== "content-length") out[k] = v;
  });
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies;
  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

/** The static host + the LB's `/api/*` → gateway rule. */
async function startSite(gatewayPort: number): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/";
    let target: string | null = null;
    if (path === SCRIPT_PATH) target = SCRIPT_PATH;
    else if (path === ASSIGN_PATH) target = ASSIGN_PATH;
    if (target) {
      proxy(req, res, gatewayPort, target).catch((e: unknown) => {
        console.error("[ab-variant e2e] gateway proxy failed", e);
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("gateway proxy failed");
      });
      return;
    }
    const file = STATIC_FILES.get(path);
    if (file === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(file);
  });
  site = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  siteOrigin = `http://localhost:${(server.address() as AddressInfo).port}`;
}

test.beforeAll(async () => {
  if (!process.env.GATEWAY_DATABASE_URL || !process.env.PUBLIC_DATABASE_URL) {
    throw new Error("GATEWAY_DATABASE_URL and PUBLIC_DATABASE_URL are required (see ci.yml e2e)");
  }
  seed("create");
  const port = await freePort();
  await startGateway(port);
  await startSite(port);
});

test.afterAll(async () => {
  gateway?.kill();
  await new Promise<void>((r) => (site ? site.close(() => r()) : r()));
  seed("delete");
});

test("a first-time visitor gets a variant and keeps it on reload (#649)", async ({ page }) => {
  const firstAssign = page.waitForResponse((r) => r.url().includes("/api/variant/assign"));
  await page.goto(`${siteOrigin}${PAGE}`);
  const assigned = await firstAssign;
  expect(assigned.status()).toBe(200);
  const { variant } = ((await assigned.json()) as { data: { variant: string } }).data;
  expect(["control", "b"]).toContain(variant);
  await expect(page.locator("main")).toHaveText(`variant ${variant}`);

  // The id stays out of page script's reach.
  const [visitorCookie] = (await page.context().cookies()).filter(
    (c) => c.name === "caelo_visitor_id",
  );
  expect(visitorCookie?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain("caelo_visitor_id");

  // Reload: the browser sends the cookie back; same variant, no re-mint.
  for (let i = 0; i < 2; i++) {
    const again = page.waitForResponse((r) => r.url().includes("/api/variant/assign"));
    await page.reload();
    const res = await again;
    expect(((await res.json()) as { data: { variant: string } }).data.variant).toBe(variant);
    expect(await res.headerValue("set-cookie")).toBeNull();
    await expect(page.locator("main")).toHaveText(`variant ${variant}`);
  }
});
