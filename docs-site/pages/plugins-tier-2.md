---
slug: plugins-tier-2
template: doc-page
status: published
seo:
  title: Tier 2 plugins — Caelo CMS
  description: AI-authored, sandboxed in Deno, locked SDK surface. Per-plugin RLS scoping. Owner approves each plugin per active transition.
---

# External plugins (Tier 2)


External plugins are submitted with `plugins.submit` as a single TypeScript or JavaScript module plus its JSON manifest. The module exports its plugin definition as the default export. Its slug and version must match the manifest. Only the public SDK and component kit may be imported; package-relative imports must be bundled before submission.

An Owner reviews the package under **Security → Plugins → Review package**, then approves it. Approval is bound to the exact source and manifest. If a package changes while the review page or a chat activation proposal is open, review and approve the new version. An active package cannot be overwritten: disable it before submitting a replacement. The host also restores approved external plugins after restart.

Operations and static rendering run in a separate Deno process. The runtime provides `query`, `api`, `theme`, `visitor`, and `captcha` through the SDK. It rejects direct filesystem, network, environment, process and FFI access. Visitor calls must be declared in `publicOperations`. Disable stops new dispatch and the host checks the active package before every SDK call and before returning a result. Already committed writes are preserved.

Each operation has a 30-second execution deadline, a 128 MiB V8 heap limit, a 1 MiB protocol message limit and a maximum of 256 SDK calls. A host runs at most four simultaneous external invocations. Plugins should split long work into bounded operations and await every SDK call. A deadline does not roll back an SDK write already accepted by the database.

Caelo's admin and gateway images include Deno 2.9.6 (MIT). For development, install this version on `PATH`, or set `CAELO_DENO_BINARY` to its executable path. A missing executable fails the invocation explicitly.

This implementation supplies the existing base SDK. Owner grants for elevated capabilities, client assets, chat tools and private authoring data are a separate implementation of the [external capability proposal](https://github.com/caelo-cms/caelo-cms/pull/471).

Plugin tables live in `cms_public.plugin_<slug>`. Every table declares `id: "uuid"`; the host adds `caelo_plugin_id` and forced row-level security. SDK calls validate tables and columns against the reviewed manifest and run with the plugin’s own identity.
