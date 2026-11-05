# Static files on the site's domain

Issue #1461. A site sometimes needs a small data file at an exact address on its own domain: searchVIU's Cloudflare Verified Bots registration needs `/bot/ips.json`, others need `/.well-known/security.txt`, `/ads.txt` or a CSV. Pages serve HTML and media takes images, so these are their own small domain: `static_files`.

Rules: `packages/shared/src/static-files.ts`. Ops: `packages/admin-core/src/ops/static_files.ts`, `static_files_pending.ts`. AI tools: `ai/tools/static-file-tools.ts`. Build: `loadStaticFiles` and `assertStaticFilesFit` in `apps/static-generator/src/generate.ts`. Owner page: Settings → Static files. Migration `0625_static_files.sql`.

## What a file may be

| Rule | Value |
|---|---|
| Content-Type | `application/json`, `text/plain`, `text/csv`, `application/xml`, `text/xml`, always served with `charset=utf-8` |
| Never | HTML, JavaScript, CSS, SVG: they would bypass "no raw HTML on pages" and the module and plugin rules (CLAUDE.md §2) |
| Path ending | `.json`, `.txt`, `.csv`, `.xml` or none, and it must fit the type. A path without an ending takes any allowed type (`/.well-known/apple-app-site-association`) |
| Size | 256 KiB per file, 50 files per site, 20 per write |
| Reserved | any first segment starting with `_`, `api`, the files every build writes (`robots.txt`, `sitemap.xml`, `routing-manifest.json`, `cdn_manifest.json`, `render-deps.json`), `/.well-known/oauth-*`, `openid-configuration` and `acme-challenge`. `/.well-known/` is otherwise open; it is the only path that may start with a dot |
| JSON | must parse |
| XML | no DOCTYPE, no stylesheet, no XHTML, SVG or MathML namespace, and no `xmlns` value spelled with character references |

The XML rule exists because a browser runs what an XML document carries in those namespaces, on the site's own origin. A `Content-Security-Policy: sandbox` response header, the way SVGs are handled (#891), would be the alternative, but plain GCP serves object metadata and a per-path CSP there means a URL-map rule per file. Refusing the body works the same on every provider.

Collisions are refused when the file is written and again by the build: a page or a redirect at the same URL, another file, or a path that would need a folder where a file stands. The write op checks exact URLs and the other files; the build also sees what the op cannot: a page merged from another branch, a slug change after the file was saved, a page below an extension-less file, a bare-slug page in the `no-extension` URL style. A redirect write refuses a `fromPath` a file holds, because the redirect plan would otherwise drop the row without a word (a served file wins).

## Who may write

Reads (`static_files.list`, `.get`, tools `list_static_files`, `get_static_file`) are open to the AI. Writes are human + system: a file at a chosen path can prove domain ownership to a third party, and recovering from one means going to that third party, so it is §11.A gated. `propose_set_static_files` takes one file or many in one click; `propose_delete_static_files` removes them. The approval card (`static_files.preview_set`, `.preview_delete`) is written by the server and shows the text of what would be served. The approver needs `settings.write`, as for a custom domain. A panel save needs the same.

## How it goes live

`static_files` is authoring state with snapshots and journal rows, but it has no branch column: every AI write is approved and applied with the approver's branch-free context, as an approved template update is, so there is nothing to overlay. The draft boundary is the build. The generator is the only reader that reaches a visitor, it runs at Stage, and production gets what a human Publish live copies from there. A Stage with no other pending change still builds, so `stage_changes` after an approval picks the file up. A site revert restores files that have a row in the snapshot it rewinds to. Such a revert needs `settings.write` too, though a revert otherwise needs only the content permission: it writes static files.

`static_files.list` reports `releaseState` per file (`not_staged`, `staged`, `live`), compared against the Stage run each target serves (a promote's or rollback's `build_id` names it). It is a display value; the deploy log is the record.

The build writes each file at its path, adds its type to `_content-types.json` and lists it in `_static-files.json`. A file is never in `routing-manifest.json`'s `pages`, so the quality check and the sitemap do not read it as a page.

| Provider | Content-Type comes from | Note |
|---|---|---|
| `gcp` | object metadata, set at upload; promote keeps it | A static file always uploads (`alwaysUpload`): the byte-identical skip could not see a changed type |
| `gcp-firebase` | one `Content-Type` header entry per file in the version config (`staticFileHeaderEntries`); clones keep it | Hosting otherwise goes by the file name |
| self-hosted | `@caelo_static_<n>` header rules appended to `_redirects.caddy`, which the public site block already imports and the Caddy container reloads; `syncRedirects` keeps them | No Caddyfile change |
| staging gateway | the staged manifest, on every provider | Rewrites the live origin to the staging host inside the body, as for every text file; the bytes Publish live ships are unchanged |
| `aws`, `azure` | none | No publisher exists (#749, #750), so a Stage refuses with the publisher's NotImplemented message. Their publishers must serve the sidecar's types when they land |

Cache: JSON 60 seconds, the other types 5 minutes on GCS (`cacheControlForContentType`), the page policy on Firebase.
