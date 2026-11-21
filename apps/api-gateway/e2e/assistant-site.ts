// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1655) — the browser fixture of the site assistant: the real
 * gateway on its own database identity, site-search's index as a release,
 * the site assistant's conversation on the visitor AI with the scripted
 * model behind the provider seam (docs/dev/visitor-ai.md: never a real key),
 * and a page that carries the widget markup the plugin's skill teaches, the
 * texts as the site's own, and the plugin's runtime. Feedback is on.
 *
 * Serves pages at `/` and `/preise/`, the gateway at `/api/*` (the page's
 * origin stands in for the site's live origin), and `/__test/feedback`
 * (what the inbox holds). Prints `READY <port>`.
 */

import { RUNTIME_JS } from "@caelo-cms/plugin-site-assistant/runtime";
import { handleRequest } from "../src/server.js";
import { TEST_LIVE_ORIGIN } from "../src/test-support.js";
import { setVisitorAiModelFactoryForTests } from "../src/visitor-ai/provider.js";
import { scriptedVisitorModel } from "../src/visitor-ai/scripted-model.js";
import { ASSISTANT_SITE_PAGES, prepareAssistantSite } from "./assistant-test-site.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const site = await prepareAssistantSite({
  admin: required("ADMIN_DATABASE_URL"),
  publicAdmin: required("PUBLIC_ADMIN_DATABASE_URL"),
  publicGateway: required("PUBLIC_DATABASE_URL"),
  stagingAdmin: required("PUBLIC_STAGING_ADMIN_DATABASE_URL"),
});
try {
  await site.setFeedback(true);
} catch (e) {
  await site.restore();
  throw e;
}
// A model that streams its answer in a few pieces, so the widget shows it growing.
const scripted = scriptedVisitorModel({ delayMs: 150 });
setVisitorAiModelFactoryForTests(() => scripted.model);

const TEXTS: Record<string, string> = {
  title: "Fragen zur Website",
  greeting: "Ich beantworte Fragen aus den Seiten dieser Website.",
  disclosure: "Antworten schreibt eine KI aus den Seiten dieser Website; sie können falsch sein.",
  placeholder: "Ihre Frage",
  send: "Senden",
  close: "Schließen",
  sources: "Quellen",
  helpful: "Hilfreich",
  not_helpful: "Nicht hilfreich",
  note: "Was hat gefehlt? (optional)",
  thanks: "Danke für Ihre Rückmeldung!",
  unavailable: "Der Assistent ist gerade nicht erreichbar.",
  budget: "Der Assistent hat sein Tageslimit erreicht.",
  limit: "Diese Unterhaltung ist zu Ende.",
  toolong: "Die Frage ist zu lang.",
  error: "Etwas ist schiefgelaufen.",
  new: "Neue Unterhaltung",
};

const WIDGET = `<div data-caelo-assistant>
  <button type="button" data-caelo-assistant-open aria-haspopup="dialog">Fragen?</button>
  <template data-caelo-assistant-texts>
    ${Object.entries(TEXTS)
      .map(([k, v]) => `<span data-text="${k}">${v}</span>`)
      .join("\n    ")}
    <a data-text="privacy" href="/datenschutz/">Datenschutz</a>
    <a data-text="handoff" href="/kontakt/">Kontakt</a>
  </template>
  <div data-caelo-plugin="site-assistant"><div data-caelo-assistant-settings data-feedback="on" hidden></div></div>
</div>`;

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main><footer>${WIDGET}</footer><script>${RUNTIME_JS}</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function routes(pathname: string): Promise<Response> {
  if (pathname === "/__test/feedback") return Response.json(await site.feedback());
  if (pathname === "/") return page("Start", "<h1>Start</h1>");
  const p = ASSISTANT_SITE_PAGES.find((x) => x.path === pathname);
  if (p)
    return page(
      p.title,
      `<h1>${p.title}</h1>${p.sections.map((s) => `<section id="${s.anchor}"><h2>${s.heading}</h2><p>${s.text}</p></section>`).join("")}`,
    );
  return new Response("not found", { status: 404 });
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req, srv) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return routes(url.pathname);
    // The page's origin stands for the site's live origin, which the
    // gateway admits (registerTestLiveOrigin).
    const headers = new Headers(req.headers);
    if (headers.get("origin") === url.origin) headers.set("origin", TEST_LIVE_ORIGIN);
    return handleRequest(new Request(req, { headers }), {
      peerAddress: srv.requestIP(req)?.address ?? null,
    });
  },
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  setVisitorAiModelFactoryForTests(null);
  await site.restore();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

console.log(`READY ${server.port}`);
