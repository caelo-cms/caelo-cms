---
slug: plugins-permissions
template: doc-page
status: published
seo:
  title: Plugin permissions — Caelo CMS
  description: What every Caelo plugin may reach, what needs an Owner grant, and the rules no grant can lift — own data only, core data only through named operations, never a direct write to live.
---

# Plugin permissions

These rules bind every plugin identically — shipped with a release or installed at runtime, written by a person or by the AI. The normative text is [CMS_REQUIREMENTS §14](https://github.com/caelo-cms/caelo-cms/blob/main/CMS_REQUIREMENTS.md).

## The base — no grant needed

- **Its own public tables** under `cms_public.plugin_<slug>`, through `ctx.query.insert / list / update / delete`. Postgres row-level security scopes every row to the plugin: another plugin cannot read them even if its code tries.
- `ctx.api` — the plugin's own public read surface for its Web Component.
- `ctx.theme` — read-only theme tokens.
- `ctx.visitor` — an opaque visitor id, the public user id and an IP hash. **Never** the visitor's session token.
- `ctx.captcha` — proof verification for public writes.
- `publicOperations` — the operations a visitor may call through the API gateway. Everything else is refused (default deny).

## Grants — approved by the Owner, per plugin version

| Grant | Allows |
|---|---|
| Private plugin storage | Tables in the plugin's own private schema for author-side data a visitor must never read |
| Core data, read (per domain) | The named read operations of one domain — e.g. media: list and get |
| Core data, write (per domain) | The named write operations of one domain |
| Chat tools | The plugin's operations as AI tools; the Owner sees every tool name and description at approval |
| Companion skills | Skills that ship with the plugin |
| AI provider / image generation | Model calls brokered by Caelo, budgeted; the plugin never sees a key |
| Background workers | Scheduled work, run by Caelo |
| Email | Sending mail through the site's transport |
| Private files | Immutable author-side files, with quotas |
| Client assets | A browser runtime on every page of the site |
| Contributions | Structured head/sitemap entries, URL slots, data lists, deferred modules |

Grants are bound to the plugin's exact artifact. A new version asks again; a revoked grant stops working before the next call. You can revoke a grant at `/security/plugins/installations`, or ask the AI. It lists the grants (`list_plugin_grants`) and proposes the revoke (`propose_revoke_plugin_capability`), and nothing changes until you click Approve. Revoking a grant of the running version disables the plugin but keeps its data.

## Rules no grant can lift

1. **Own data, or granted interfaces — nothing else.** A plugin never touches another plugin's data, and never reaches core data except through the named operations of a domain it was granted. There is no table access and no SQL.
2. **No direct writes to live.** Authoring writes — to core data and to the plugin's own private storage — are validated, audited and snapshotted like any other change. From a chat they land on that chat's branch, can be undone with it, and go live only when you publish. The one exception is a visitor's write into the plugin's own public tables, such as a form submission.
3. **One sandbox.** Plugin backend code runs in a Deno subprocess with no file, network or environment access, and talks to Caelo only through a checked broker. Building the plugin resolves nothing but its own code and the SDK.
4. **Nothing runs before activation**, and only a human Owner activates or grants.
5. **Hard-to-revert actions** (for example changing the site's URL strategy) additionally ask for your click in the chat, every time.

## What happens when the AI builds a plugin

1. You describe what you want; the AI calls `submit_plugin({ slug, source, manifest })`.
2. The validator runs. On failure the AI gets structured errors and fixes them in the same turn.
3. On success the plugin waits at `/security/plugins`. The AI says so and does not claim it is active.
4. You review the source, the schema, the requested grants and every tool description, and approve.
5. Caelo provisions the plugin's tables and loads it. Its tools reach the AI on the next turn.

Disabling a plugin keeps its data. Uninstalling removes it.

## Approving a plugin that asks for access

A plugin that requests grants is reviewed at **Security → Plugins → Install external packages and review access** (`/security/plugins/installations`). Packages built outside Caelo are uploaded there as a JSON file `{ "manifest": …, "source": "…" }`; plugins the AI builds with extra access land in the same queue. Approving needs the `plugins.install` permission, which only the Owner has by default — the moderation permission `plugins.approve` is not enough.

- **Every grant is its own checkbox, none preselected.** Each shows the plugin's stated reason. You see the exact source, the manifest, and every tool name and description the AI will be shown.
- **Approval issues a receipt per grant**, bound to the package's SHA-256. A manifest that merely lists a grant gets nothing; only receipts count.
- **Updates are new packages.** The running version keeps running while you review the replacement. Removing columns or changing their types is refused; failed preparation keeps the old version.
- **Revoking a grant disables that version** and keeps its data. A write already accepted finishes first; no write starts after the revocation. Approving again issues fresh receipts, so earlier approvals do not come back to life.
- **Private storage is only for authoring.** The plugin gets it when it acts for someone who may author content — in a chat, in the Owner panel, or for an action you approved. Rendering and visitor calls never get it.
- **Tools that ask before every use** show the approval card in the chat. The card is bound to the exact package, receipts, arguments and person; it can be used once, and a changed package or changed arguments need a fresh approval.

- **Companion skills** — guides the plugin gives the AI — are shown in full before approval. They are active only while the approved version runs and its grant holds; revoking the grant or disabling the plugin removes them from the AI's view at once. Their slugs start with the plugin's slug.

This release supports private storage, chat tools and companion skills for such plugins. A request for any other grant can be reviewed, but the plugin will not activate until Caelo implements that grant.

## Status

Caelo is converging on this model. Where the current release does not meet it yet — shipped plugins still run in-process with their capabilities fixed at load, and a broad core-data capability instead of per-domain grants — the gaps are listed in CMS_REQUIREMENTS §14.13 and tracked as defects.

## Next

- [Build a plugin →](/plugins-build)
- [Architecture →](/architecture)
- The [`@caelo-cms/plugin-sandbox` source](https://github.com/caelo-cms/caelo-cms/tree/main/packages/plugin-sandbox)
