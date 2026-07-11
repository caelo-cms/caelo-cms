// SPDX-License-Identifier: MPL-2.0

/**
 * issue #200 — the local fixture website the migration scenarios
 * crawl. Deliberately shaped like a real small-business site:
 *
 *   - distinct design (gradient hero, warm palette, serif display)
 *     so keep-design assertions have something to preserve;
 *   - three page types (static / blog articles / product pages) so
 *     clustering produces per-type templates;
 *   - a sitemap-only landing page (never linked) so sitemap seeding
 *     is exercised;
 *   - robots.txt with a disallowed section;
 *   - one seeded TYPO ("Addresse") and one DEAD LINK
 *     (/impressum-alt) so the migration report has real findings;
 *   - old-style .html paths so redirects are required.
 *
 * Served by Bun.serve on 127.0.0.1:0 — the admin's crawl worker
 * reaches it because global-setup exports
 * CAELO_IMPORTER_ALLOWED_HOSTS=127.0.0.1,localhost (test admin only).
 */

const CSS = `
  :root { --brand: #7c2d12; --accent: #f59e0b; --paper: #fef3c7; --ink: #1c1917; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: Georgia, serif; color: var(--ink); background: #fffbf5; }
  header.site { background: linear-gradient(120deg, var(--brand), var(--accent)); color: var(--paper); padding: 2rem; }
  header.site nav a { color: var(--paper); margin-right: 1rem; text-decoration: none; font-weight: bold; }
  main { max-width: 60rem; margin: 0 auto; padding: 2rem; }
  h1 { font-size: 2.5rem; color: var(--brand); }
  .hero { background: linear-gradient(120deg, var(--brand), var(--accent)); color: var(--paper); padding: 4rem 2rem; border-radius: 12px; }
  .card { border: 1px solid #e7e5e4; border-radius: 8px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(124, 45, 18, 0.12); }
  footer.site { background: var(--ink); color: var(--paper); padding: 2rem; margin-top: 3rem; }
`;

const chrome = (title: string, body: string): string => `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${title} · Werkstatt Steinmann</title>
<meta name="description" content="Werkstatt Steinmann — Handwerkzeug aus Freiburg seit 1952.">
<style>${CSS}</style></head><body>
<header class="site"><strong>Werkstatt Steinmann</strong>
<nav><a href="/">Start</a><a href="/ueber-uns">Über uns</a><a href="/blog/erster-beitrag.html">Blog</a><a href="/produkte/hammer.html">Produkte</a><a href="/kontakt">Kontakt</a></nav>
</header>
<main>${body}</main>
<footer class="site">© 1952–2026 Werkstatt Steinmann · Freiburg im Breisgau</footer>
</body></html>`;

const blogPost = (title: string, extra = ""): string =>
  chrome(
    title,
    `<article><h1>${title}</h1><p>Aus der Werkstatt: ${title}. Hobeln, sägen, schleifen — ehrliche Arbeit.</p><p>Mehr davon im nächsten Beitrag.</p>${extra}</article><section><h2>Weitere Beiträge</h2><ul><li><a href="/blog/erster-beitrag.html">Erster Beitrag</a></li><li><a href="/blog/zweiter-beitrag.html">Zweiter Beitrag</a></li></ul></section>`,
  );

const productPage = (name: string, price: string): string =>
  chrome(
    name,
    `<h1>${name}</h1><section class="card"><table><tr><td>Preis</td><td>${price}</td></tr><tr><td>Material</td><td>Esche & Stahl</td></tr></table></section><section class="card"><h2>Bestellen</h2><form action="/bestellen"><input name="menge" placeholder="Menge"><button>Anfragen</button></form></section>`,
  );

export const MIGRATE_FIXTURE_ROUTES: Record<string, { body: string; contentType: string }> = {
  "/": {
    contentType: "text/html",
    body: chrome(
      "Start",
      `<div class="hero"><h1>Handwerkzeug, das bleibt.</h1><p>Seit 1952 fertigen wir Hämmer, Sägen und Hobel in Freiburg.</p></div><section class="card"><h2>Unsere Klassiker</h2><ul><li><a href="/produkte/hammer.html">Schreinerhammer</a></li><li><a href="/produkte/saege.html">Gestellsäge</a></li></ul></section>`,
    ),
  },
  "/ueber-uns": {
    contentType: "text/html",
    // Seeded TYPO: "Addresse" (correct German: Adresse) — the
    // migration report must surface it.
    body: chrome(
      "Über uns",
      `<h1>Über uns</h1><p>Drei Generationen Handwerk.</p><p>Unsere Addresse: Münsterplatz 1, 79098 Freiburg.</p>`,
    ),
  },
  "/kontakt": {
    contentType: "text/html",
    body: chrome(
      "Kontakt",
      `<h1>Kontakt</h1><p>Schreiben Sie uns: werkstatt@steinmann.example</p>`,
    ),
  },
  "/blog/erster-beitrag.html": {
    contentType: "text/html",
    // Seeded DEAD LINK — /impressum-alt 404s.
    body: blogPost(
      "Warum Eschenholz?",
      `<p>Rechtliches im <a href="/impressum-alt">alten Impressum</a>.</p>`,
    ),
  },
  "/blog/zweiter-beitrag.html": {
    contentType: "text/html",
    body: blogPost("Der richtige Schliff"),
  },
  "/produkte/hammer.html": {
    contentType: "text/html",
    body: productPage("Schreinerhammer", "49 €"),
  },
  "/produkte/saege.html": { contentType: "text/html", body: productPage("Gestellsäge", "129 €") },
  "/versteckte-landingpage": {
    contentType: "text/html",
    // Reachable ONLY via the sitemap — proves sitemap seeding.
    body: chrome(
      "Aktion",
      `<h1>Frühjahrsaktion</h1><p>Nur über den Newsletter verlinkt — kein interner Link führt hierher.</p>`,
    ),
  },
  "/robots.txt": {
    contentType: "text/plain",
    body: "User-agent: *\nDisallow: /intern/\nSitemap: __BASE__/sitemap.xml\n",
  },
};

export function sitemapXml(base: string): string {
  const urls = [
    "/",
    "/ueber-uns",
    "/kontakt",
    "/blog/erster-beitrag.html",
    "/blog/zweiter-beitrag.html",
    "/produkte/hammer.html",
    "/produkte/saege.html",
    "/versteckte-landingpage",
  ];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${urls
    .map((u) => `<url><loc>${base}${u}</loc></url>`)
    .join("")}</urlset>`;
}

export interface FixtureSite {
  readonly url: string;
  stop(): void;
}

/** Start the fixture site on a random localhost port. */
export function startMigrateFixtureSite(): FixtureSite {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const base = `http://127.0.0.1:${server.port}`;
      if (path === "/sitemap.xml") {
        return new Response(sitemapXml(base), { headers: { "content-type": "application/xml" } });
      }
      const route = MIGRATE_FIXTURE_ROUTES[path];
      if (!route) return new Response("Nicht gefunden", { status: 404 });
      return new Response(route.body.replaceAll("__BASE__", base), {
        headers: { "content-type": route.contentType },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true);
    },
  };
}
