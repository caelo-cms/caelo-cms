---
slug: plugins-tier-2
template: doc-page
status: published
seo:
  title: Tier 2 plugins — Caelo CMS
  description: External packages run in isolated Deno processes with explicit Owner capability grants and per-plugin RLS.
---

# External plugins (Tier 2)


External plugins are submitted with `plugins.submit` as a single TypeScript or JavaScript module plus its JSON manifest. The module exports its plugin definition as the default export. Its slug and version must match the manifest. Only the public SDK and component kit may be imported; package-relative imports must be bundled before submission.

An Owner reviews the package under **Security → Plugins → Review package**, then approves it. Approval is bound to the exact source and manifest. If a package changes while the review page or a chat activation proposal is open, review and approve the new version. An active package cannot be overwritten: disable it before submitting a replacement. The host also restores approved external plugins after restart.

Operations and static rendering run in a separate Deno process. The runtime provides `query`, `api`, `theme`, `visitor`, and `captcha` through the SDK. It rejects direct filesystem, network, environment, process and FFI access. Visitor calls must be declared in `publicOperations`. Disable stops new dispatch and the host checks the active package before every SDK call and before returning a result. Already committed writes are preserved.

Each operation has a 30-second execution deadline, a 128 MiB V8 heap limit, a 1 MiB protocol message limit and a maximum of 256 SDK calls. A host runs at most four simultaneous external invocations. Plugins should split long work into bounded operations and await every SDK call. A deadline does not roll back an SDK write already accepted by the database.

Caelo's admin and gateway images include Deno 2.9.6 (MIT). For development, install this version on `PATH`, or set `CAELO_DENO_BINARY` to its executable path. A missing executable fails the invocation explicitly.

## Installing a package with author capabilities

Upload a JSON file containing `manifest` and `source` at **Security → Plugins → Install external packages and review access**. The `plugins.install` permission, assigned to Owner by default, controls approval and revocation. The moderation permission `plugins.approve` is insufficient.

Declare `requestedCapabilities`, explain each in `capabilityReasons`, and review every access checkbox. No checkbox is preselected. This rollout supports `cms_admin_schema` (the plugin's own private storage, including conditional writes) and `chat_runner_tools` (namespaced, schema-validated tools with host-enforced per-action approvals). Other requests can be staged but activation fails until their brokers are implemented.

The isolated operation receives `adminQuery` only for an authenticated author with `content.write`. `ctx.invocation` contains the host-selected actor, human operator and chat branch; operation arguments cannot replace them. Visitor and rendering calls receive no private storage handle. Name external tools `<slug_with_underscores>__<tool_name>` and declare each operation only once as a tool.

Updates are separate immutable artifacts: upload and approve a replacement while the previous version keeps running. Preparation validates the isolated definition and provisions declared schemas before committing the new active artifact. Failed preparation preserves the active version; the UI offers retry using the existing approval. Removing columns or changing their declared types is rejected. Revoking an active capability disables that package while preserving its data. Re-approval issues new receipts; old runtime handles remain invalid.

Every storage call holds the registry row through commit. Revocation waits for an already accepted write to commit; once revocation completes, old handles cannot begin another write. This does not undo earlier writes or promise cancellation of already dispatched external effects.

Plugin tables live in `cms_public.plugin_<slug>`. Tables may declare `id: "uuid"`; otherwise the host creates that primary key. Forced row-level security scopes access to the plugin identity. SDK calls validate tables and columns against the reviewed manifest and run with the plugin’s own identity.

External tools declaring `approvalMode: "user-approval"` use the native chat approval card. Before showing it, the host records an immutable binding to the artifact, capability receipt IDs, tool and operation, exact arguments, author and chat branch. The binding survives restarts; updates, revocation/reapproval, or changed arguments require a fresh call and approval. Legacy queued approvals without that binding cannot execute an external gated tool. Power-MCP passes authenticated author context for ordinary tools and directs approval-gated calls to the CMS chat.

The installation page supports retrying an approved installation and reloading its exact finalized active artifact after a transient host-load failure. Neither action issues new capability receipts. AI-authored capability-bearing `submit_plugin` requests enter this same installation review queue.
