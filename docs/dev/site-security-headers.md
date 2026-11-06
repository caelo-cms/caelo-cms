# A site's security headers

Issue #1454. Every page of a published or staged site sends a complete set of security headers. The Owner's policy and what a build ships make one set, and every host serves that set.

Rules and host forms: `packages/shared/src/site-security-headers.ts`. Build: `apps/static-generator/src/security-headers-pass.ts`, `page-scripts-pass.ts`. Ops: `packages/admin-core/src/ops/security_headers.ts`. AI tools: `ai/tools/security-header-tools.ts`. Quality check: `quality/checks/security-headers.ts`. Owner page: Settings → Security headers. Migrations `0639_site_security_headers.sql`, `0640_deploy_run_security_headers.sql`.

## What a page sends

| Header | Value | Mode |
|---|---|---|
| `Referrer-Policy` | `strict-origin-when-cross-origin` by default | always |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb, serial, hid, midi, bluetooth denied. Autoplay and fullscreen stay open, because video embeds use them | always |
| `X-Frame-Options` | `SAMEORIGIN`; left out when the policy lists other frame ancestors, because it cannot express a list | always |
| `Content-Security-Policy` | `frame-ancestors`, `base-uri 'self'`, `object-src`: nothing here can stop a script or a style | `report_only` |
| `Content-Security-Policy-Report-Only` | the full policy | `report_only` |
| `Content-Security-Policy` | the full policy | `enforce` |
| `Strict-Transport-Security` | one year, no subdomains, no preload | where the host does not send its own |

An SVG keeps its sandboxing CSP (`SVG_DOCUMENT_CSP`, #891) and gets none of this. Files other than documents get only `nosniff`, except on `gcp` (see below), and a CSP does nothing on them there.

## The CSP is derived from the build

`CspScanner` reads each page's final HTML, after every pass that rewrites it, and keeps sets of origins per directive: scripts, stylesheets, images, fonts (from `@font-face`), media, frames, form targets, objects. A media CDN, a font host and an approved embed therefore appear without anyone naming them. A withheld module's `<template>` is read too, because the consent runtime restores it after consent. A module an Owner has not resolved is left out of the page, so it adds nothing.

Derivation means the CSP allows what the site's authors put in a page. It defends against injected script, not against an author: a module with a `<script src>` to a host brings that host along. That is why approval of third parties stays where it is: consent's `allow_external_embed` and `add_tracking_tag`.

What runs after load cannot be read from markup:

- A plugin says it itself, as the reserved `csp-sources.json` of `buildAssets` (`pluginCspSourcesSchema`): origins per kind and the exact text of inline scripts its runtime injects. The Owner sees it per plugin in `get_security_headers` and the Settings page. Today consent-manager uses it for tracking tags, with the hosts a known vendor goes on to contact (`csp-sources.ts`). A tag container (GTM) can load anything, so what it loads beyond Google's own hosts shows as a violation.
- The rest goes into the policy's `extraSources`.

### Why `script-src` has no `'unsafe-inline'`

The composer joins a page's module JS into one inline script, one distinct body per set of modules. As a hash each is 50 bytes in a header that holds about 6 KB, so a site with 200 different module sets would not fit. On a deployed page that script is therefore a content-hashed file instead (`/_assets/page-script.<hash>.js`, immutable like every hashed asset), and `'self'` covers it on any number of pages. It also removes the `data:` URL form the composer uses for a body containing `</script`. The admin's preview keeps the inline form: it is the admin's document and sends none of these headers.

The hashes left are small in number: a parked script of a withheld module (one per module, the runtime runs it inline), an inline `<script>` in a module's own html, and tag snippets. JSON-LD is a data block, which a CSP does not govern.

An `onclick=` attribute or a `javascript:` link cannot be allowed by hash without `'unsafe-hashes'`, which would weaken the policy. These are reported instead ("blockers", below).

### Why `style-src` keeps `'unsafe-inline'`

`style` attributes cannot be hashed. Plugin components write `<style>` into their shadow roots at runtime. A page's inline `<style>` varies with its modules and carries the critical CSS: as a linked file it would block first paint. CSS cannot run script, so the cost is limited to what CSS alone can leak.

### The header budget

`SITE_HEADERS_MAX_BYTES` is 6 KiB over all header names and values. `gcp` has a hard limit of 8 KB and 16 headers per backend (Load Balancing quotas). Firebase documents no limit.

If a `report_only` policy does not fit, it loses its hashes and then the report-only header, and the `security-headers/csp-too-large` finding says so (`cspCut`). If an `enforce` policy does not fit, the build fails with the way out: an enforced policy that left something out would block it.

## Rollout: report-only first

Every install starts at `report_only` (a stored default, migration 0639), so an update cannot take a site's scripts down. Switching to `enforce` is the Owner's decision.

Violations reach the Owner in the Stage's quality audit:

- The audit's origin sends the build's own headers, so Lighthouse sees each violation. Under `report_only` a violation is not a console error: it fails only `inspector-issues` (Best Practices, weight 1, so it still blocks Publish live). Under `enforce` it also fails `errors-in-console`. Measured with real Chromium through `runAuditJob`: a clean page 100, a third-party fetch 96 report-only and 92 enforced.
- `inspector-issues` names no directive, so the audit session reads Lighthouse's `InspectorIssues` artifact (`quality/csp-violations.ts`). The finding names the blocked host and the `extraSources.<kind>` to add through `propose_set_security_headers`.
- The core `security-headers` check names what no policy can allow: `inline-handler`, `javascript-url`, `data-script`, `foreign-base`. Under `report_only` they are warnings, because nothing is blocked for a visitor. Under `enforce` they are errors, which block Publish live.

There is no report endpoint on the gateway. Reports from visitors' browsers would need a public write that cannot carry a captcha, plus a table in `cms_public` that the admin reads as untrusted data, on a gateway that answers a fixed 404 when no visitor plugin is active (#763). So the report-only header carries no `report-to`, and violations on pages the audit does not open, or after consent, are not seen by anyone. That is the known limit of this rollout.

Lighthouse's `csp-xss`, `has-hsts`, `origin-isolation` and `clickjacking-mitigation` are informative audits with weight 0. They never count as findings (`lighthouse-extract.ts`), so an unenforced CSP costs no score.

## How it goes live

**A rendered setting** (CLAUDE.md §2, [redirects-and-settings-sync.md](./redirects-and-settings-sync.md)): it goes live with a human Publish live, and never by a sync on save.

The policy is stored live in `site_settings.security_headers` and read by the build. The set is written into the build as `_security-headers.json`, and travels with its files. A sync on save was the alternative, and it would be wrong here: a CSP names what one build ships, so pushing a new one onto the old files, or the old one onto new files, can stop scripts. So a save changes nothing a visitor gets; the next Stage sends it on staging and Publish live on the live site. A rollback restores the headers of the build it restores. A plugin-data build and a redirect sync copy the live version's config, so they keep the headers. Each deploy run records its set (`deploy_runs.security_headers`), which is where `security_headers.get` reads what staging and live send.

| Host | Where the headers come from | Note |
|---|---|---|
| `gcp-firebase` | a header entry in the Hosting version (`siteHeaderEntry`), matched by `SITE_DOCUMENT_PATH_PATTERN` | Goes live atomically with the release. Disjoint from the SVG entry, because Firebase names no winner when two set one header. Hosting sends HSTS itself, so the policy's `hsts` has no effect |
| `gcp` | the static backend bucket's `customResponseHeaders`, written by Publish live and rollback (`gcp-site-headers.ts`) | After the files, and the load balancer takes minutes to apply it, so the previous build's headers sit on the new files meanwhile. One list per bucket, so it covers every file; harmless, a CSP acts on documents only and an SVG is a download there. Needs `compute.backendBuckets.get` and `.update` (contract 23). The converge and the stack leave the non-nosniff entries alone |
| self-hosted | `@caelo_documents` header rules appended to `_redirects.caddy`, which the public site block already imports and the Caddy container reloads; `syncRedirects` keeps them | No Caddyfile change |
| staging gateway | the staged manifest's `securityHeaders`, on HTML answers, on every provider | No HSTS: the host is a staging host |
| quality audit origin | the build's `_security-headers.json` | So the audit sees what staging sends |
| `aws`, `azure` | none | No publisher exists (#749, #750): a Stage refuses with the publisher's message, and `security_headers.get`, `.set` and the proposal say so. Their publishers must serve the set when they land |

A build staged before this feature has no set. Publish live of such a run, or a rollback to one, ships no page headers until the next Stage and Publish live.

## Who may change it

`security_headers.get` and the tool `get_security_headers` are open to the AI. `security_headers.set` is human and system: the Owner's page. The AI proposes through `propose_set_security_headers` (CLAUDE.md §11.A, `owner_settings.propose_set_security_headers`, kind `set_security_headers`), a PATCH merged onto the row at approve time. The approval card (`security_headers.preview_set`) shows each header before and after on the last staged build, and what enforcing would stop. The approver needs `settings.write`.

A wrong CSP takes a site's scripts down, a `frame-ancestors` change exposes it to clickjacking, and a browser remembers HSTS for its whole period, so a click is required. Origins are validated as `https://` or `wss://` plus a host: no keyword, no path, no wildcard scheme, so no setting can add `'unsafe-inline'`, `'unsafe-eval'` or `*`.

A site whose tag container needs inline script stays on `report_only`. There is deliberately no switch for `'unsafe-inline'` in `script-src`.

## What a real host still has to prove

Unit tests pin each host's config. Only Caddy was run for real (the compose stack's `caddy:2-alpine` serving a generated snippet: documents, a 404 and no header on `.svg` or `/_assets/`). No Firebase or `gcp` host has served this yet.

- **Firebase:** that a version with the document entry deploys (`SITE_DOCUMENT_PATH_PATTERN` is checked in ECMAScript, and uses only syntax RE2 shares), that a header of up to 6 KiB is accepted and served, and that the entry reaches a custom 404 at an extensionless path.
- **`gcp`:** that `backendBuckets.patch` accepts the list, including a 6 KiB value, that the headers survive Cloud CDN's cache, and that contract 23's role is enough.
- **Browsers:** that a real tracked page raises no violation with the derived policy, also after consent. A plugin-data build re-renders bake regions without a new CSP, so an inline script a plugin's `staticRender` adds later would need a new Stage; no shipped plugin renders one.
