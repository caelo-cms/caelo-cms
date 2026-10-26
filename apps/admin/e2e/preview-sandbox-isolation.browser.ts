// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #946 — a `<script>` in module HTML must never run with the
 * operator's admin session.
 *
 * Before the fix the Live Edit preview was framed with
 * `allow-scripts allow-same-origin` on the admin origin, so a module script
 * could read `parent.document` (CSRF token included) and call admin
 * endpoints as the operator — and module HTML is AI-authored or imported
 * from third-party sites. The preview now runs in an opaque origin.
 *
 * The seeded module carries a probe script that tries exactly what an
 * attacker would and writes what it could do into the page. The spec then
 * checks that Live Edit itself still works: media loads through the
 * read-only grant, right-click → chip lands in the composer, and a reload
 * after an edit keeps working (it is now driven by the editor).
 */

import { expect, type Request, test } from "@playwright/test";
import {
  clearLoginRateBucket,
  referenceViaContextMenu,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

const ts = Date.now();
const TPL_SLUG = `e2e-sbx-tpl-${ts}`;
const MOD_SLUG = `e2e-sbx-mod-${ts}`;
const PAGE_SLUG = `e2e-sbx-page-${ts}`;
// A valid 1x1 PNG (the upload pipeline decodes what it stores).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The probe: everything a hostile module script would try, reported in #probe. */
function moduleHtml(assetId: string): string {
  return `<section class="probe"><h1>SANDBOX_PROBE</h1><p>Probe paragraph for the context menu.</p><img id="probe-img" src="/_caelo/media/${assetId}/orig" alt="probe"><pre id="probe">pending</pre><script>
(function () {
  var r = { origin: self.origin, top: window.top === window };
  try { r.parentDoc = String(parent.document.querySelectorAll("input").length); } catch (e) { r.parentDoc = "blocked"; }
  try { r.cookie = document.cookie; } catch (e) { r.cookie = "blocked"; }
  try { localStorage.setItem("x", "1"); r.storage = "open"; } catch (e) { r.storage = "blocked"; }
  fetch("/edit?caelo-probe=1", { credentials: "include" })
    .then(function (res) { r.adminFetch = "read:" + res.status; })
    .catch(function () { r.adminFetch = "blocked"; })
    .then(function () { document.getElementById("probe").textContent = JSON.stringify(r); });
})();
</script></section>`;
}

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = \${process.env.PAGE_SLUG})\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.PAGE_SLUG}\`;
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
    });
    await sql.end();
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG },
  );
});

test("a module script in the Live Edit preview cannot act as the operator; Live Edit still works", async ({
  page,
  baseURL,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  // A real stored image, so the preview's media request is a real one.
  const upload = await page.request.post("/api/media/upload", {
    headers: { origin: baseURL ?? "" },
    multipart: {
      file: { name: `sandbox-probe-${ts}.png`, mimeType: "image/png", buffer: PNG },
      name: `sandbox probe ${ts}`,
    },
  });
  expect(upload.status(), await upload.text()).toBe(200);
  const { assetId } = (await upload.json()) as { assetId: string };

  const seed = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const out = {};
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${process.env.TPL_SLUG}, 'sbx', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT default_page_type_id FROM site_defaults WHERE id = 1) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      const mod = await tx\`
        INSERT INTO modules (slug, display_name, type, html)
        VALUES (\${process.env.MOD_SLUG}, 'sandbox probe', \${process.env.MOD_SLUG}, \${process.env.MOD_HTML})
        RETURNING id::text AS id\`;
      const pg = await tx\`
        INSERT INTO pages (slug, title, template_id, status)
        VALUES (\${process.env.PAGE_SLUG}, 'Sandbox Probe', \${tpl[0].id}::uuid, 'draft')
        RETURNING id::text AS id\`;
      out.pg = pg[0].id;
      const ci = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${mod[0].id}::uuid, '{}'::jsonb) RETURNING id::text AS id\`;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES (\${out.pg}::uuid, 'content', 0, \${mod[0].id}::uuid, \${ci[0].id}::uuid)\`;
    });
    await sql.end();
    process.stdout.write(JSON.stringify(out));
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG, MOD_HTML: moduleHtml(assetId) },
  );
  const ids = JSON.parse(seed) as { pg: string };

  // The probe's admin request, as the server receives it.
  const probeRequest = page.waitForRequest((req: Request) => req.url().includes("caelo-probe=1"));

  await page.goto(`/edit?page=${ids.pg}`);
  const frameEl = page.locator("iframe[title='Live preview']");
  // The regression itself: no allow-same-origin next to allow-scripts.
  await expect(frameEl).toHaveAttribute("sandbox", "allow-scripts");
  const preview = page.frameLocator("iframe[title='Live preview']");
  await expect(preview.locator("h1")).toHaveText("SANDBOX_PROBE", { timeout: 15_000 });

  // --- isolation ------------------------------------------------------------
  const probe = preview.locator("#probe");
  await expect(probe).not.toHaveText("pending", { timeout: 15_000 });
  const report = JSON.parse((await probe.textContent()) ?? "{}") as Record<string, unknown>;
  expect(report).toEqual({
    origin: "null",
    top: false,
    parentDoc: "blocked",
    cookie: "blocked",
    storage: "blocked",
    adminFetch: "blocked",
  });
  // The request left the browser WITHOUT the operator's session.
  const sent = await (await probeRequest).allHeaders();
  expect(sent.cookie ?? "").not.toContain("caelo_session");

  // --- Live Edit still works ------------------------------------------------
  // Media loads through the read-only preview grant (no session needed).
  await expect
    .poll(() =>
      preview.locator("#probe-img").evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  // Right-click → "Add to chat as reference" → chip in the current composer.
  await referenceViaContextMenu(page, preview.locator("section.probe p"));
  await expect(page.getByTestId("chip")).toHaveCount(1);

  // A forged message from outside this editor's channel adds nothing.
  await preview.locator("body").evaluate(() => {
    window.parent.postMessage(
      { kind: "caelo:element-referenced", moduleId: "m", selector: "h1", label: "forged" },
      window.location.origin,
    );
  });
  await page.waitForTimeout(300);
  await expect(page.getByTestId("chip")).toHaveCount(1);

  // A reload request is answered by an editor-driven navigation that
  // carries the session: the page renders again (not the login screen).
  await preview.locator("#probe").evaluate((el) => {
    el.textContent = "STALE";
  });
  await preview.locator("body").evaluate(() => {
    const channel = new URLSearchParams(window.location.search).get("channel");
    window.parent.postMessage(
      {
        kind: "caelo:navigate",
        channel,
        href: window.location.pathname + window.location.search,
      },
      window.location.origin,
    );
  });
  await expect(preview.locator("h1")).toHaveText("SANDBOX_PROBE", { timeout: 15_000 });
  await expect(probe).not.toHaveText("STALE", { timeout: 15_000 });

  // --- opened directly in a tab, the preview sandboxes itself -----------------
  const direct = await page.goto(`/edit/preview-by-path/${PAGE_SLUG}`);
  expect(direct?.headers()["content-security-policy"]).toBe("sandbox allow-scripts");
  expect(direct?.headers()["referrer-policy"]).toBe("no-referrer");
  const topProbe = page.locator("#probe");
  await expect(topProbe).not.toHaveText("pending", { timeout: 15_000 });
  const topReport = JSON.parse((await topProbe.textContent()) ?? "{}") as Record<string, unknown>;
  expect(topReport.origin).toBe("null");
  expect(topReport.cookie).toBe("blocked");
  expect(topReport.adminFetch).toBe("blocked");
});
