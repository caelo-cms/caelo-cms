<!-- SPDX-License-Identifier: MPL-2.0 -->

# Brokering every capability to runtime-installed plugins: design

**Status:** decided (maintainer, 2026-11-26: every recommendation of §9 accepted, decisions on #1729) and shipping in one PR, #1732, in phases. **Phase A has landed:** the status record, the refusal at submission and the parity test (§4.1, §4.2), the sandbox pools, budgets and bundle cache (§4.4), the one registration seam (§4.3, with the confirmed §10 gaps), `background_workers` (§5.1), `list_types` (§6.1), and `snapshots` withdrawn (§7.4). **Phase B1 has landed:** `cms_admin` with the `pluginAccess` marker (§7.1) and `change_journal` with resumable rebuilds (§5.2). **Phase B2 has landed:** `ai_provider` (§7.2) and `email` (§7.3). **Phase C1 has landed:** `client_assets` (§6.7, decision Q4 B) for every plugin, deferrals and build assets, with the four shipped users moved to it. **Phase C2 has landed:** `url_slots` as declared tables (§6.8, Q7 A) and the staging-time check of a `cms_admin` allowlist (§7.1). **Phase B3a-2 has landed:** `head_contributions` with share images, the head vocabulary binding every plugin (§6.2). The rest follows in the order of §8; each phase updates this line, the status table in §4.1 and the CMS_REQUIREMENTS §14.13 list. **Phase B3b has landed:** `link_resolve` (§6.4, `linkResolveReads` required of every link resolver), `list_resolve` (§6.5) and `content_variants` (§6.6), with the value checks applied where list overlays and content variants meet their fields, and the `metaSignature` gap of §10 checked (#1737).

CLAUDE.md §2 says "A shipped plugin may do nothing a runtime-installed plugin with the same grants could not" (also CMS_REQUIREMENTS §14.2). When this was written a runtime-installed (external) plugin could be granted 12 of the 26 capabilities in `pluginCapability` (`packages/plugin-sdk/src/index.ts:174-201`). File and line references describe the tree at `ad4754b5c`, before the implementation. This document designs a broker for each of the other 14, groups them by mechanism, proposes an order, and lists the decisions the maintainer has to make (§9).

Terms used here:

- **External plugin**: a plugin installed at runtime (AI-written or pasted by an Owner), stored in `plugins.source_code`, run in the Deno sandbox. Its manifest says `tier: 2`.
- **Shipped plugin**: a plugin under `packages/plugins/<slug>/`, loaded from disk, run in-process.
- **Receipt**: a row of `plugin_capability_grants`, one per capability the Owner approved for one artifact digest.
- **Composition point**: a place where core asks plugins during a render (head entries, list sources, link resolution, …) and renders their answer.

---

## 1. The problem in the code

1. **Two hand-written allowlists.** `externalPluginDefinition` throws `External capability broker unavailable: <capability>` for anything outside a 12-entry list (`packages/plugin-host/src/external-plugin.ts:34-55`). `activateApprovedExternalPlugin` keeps a second copy of the same list (`packages/plugin-host/src/loader.ts:887-904`). Neither is derived from anything.
2. **Nothing refuses earlier.** `plugins.stage_installation` validates the manifest and runs `validateInstallationPolicy` (`packages/admin-core/src/ops/plugins/installations.ts:39-59`), and `plugins.approve_installation` and `plugins.finalize_installation` run `validateSelectedGrants` (`installations.ts:293`, `installations.ts:458`). None of them checks that a broker exists. The Owner approves, receipts are written (`installations.ts:302-312`), and the load then fails.
3. **The external load path skips most registrations.** A shipped plugin goes through `registerLoadedPlugin` (`loader.ts:1088`), which claims URL slots (`loader.ts:1484-1494`), seeds config (`loader.ts:1499-1522`), runs `onActivate` (`loader.ts:1524-1550`), syncs list types (`loader.ts:1553-1576`), registers tools and list sources (`loader.ts:1578-1584`) and schedules workers (`loader.ts:1600-1622`). An external plugin goes through `loadTier2Row` (`loader.ts:568-664`), which provisions schemas, creates the plugin actor and registers tools, and nothing else. `externalPluginDefinition` also drops the manifest fields those registrations need (`workers`, `listSources`, `listTypes`, `contributes`, `mailTemplates`, `mailUnsubscribe`, `urlContributions`: compare `external-plugin.ts:73-132` with the manifest schema, `index.ts:1248-1431`).
4. **The sandbox context has no handle for these capabilities.** The child builds `ctx` from flags the host sends (`packages/plugin-host/src/sandbox-entry.ts:203-218`), and the wire allows only the methods in `sandboxMethod` (`packages/plugin-host/src/sandbox-protocol.ts:17-68`). There is no `cms`, `ai`, `email` or `snapshots` method. `sandbox-runtime.test.ts:174` asserts that `ctx.cms` is absent "even with the grant".

---

## 2. What exists today

### 2.1 How an external plugin runs

- **One child per call.** `runSandbox` bundles the source with `Bun.build` (only the entry and the two SDK packages resolve: `sandbox-runtime.ts:312-378`), writes it to a temp dir and spawns `deno run` with `--deny-read --deny-write --deny-net --deny-env --deny-run --deny-ffi --deny-sys`, a 256 MB heap and code generation from strings disabled (`sandbox-runtime.ts:465-495`). The prelude removes `Deno` and `process` before plugin code runs (`sandbox-entry.ts:26-71`).
- **Broker.** Every SDK call is a JSON line `{kind:"call", id, method, args}`. The host parses it against `sandboxMessage` (at most 4 arguments, `sandbox-protocol.ts:70-81`), checks the sequence and the call limit (`sandbox-runtime.ts:567`), re-checks the approval (`sandbox-runtime.ts:569`), and runs `broker()`, which Zod-parses the arguments per method and calls the host handle on `ctx` (`sandbox-runtime.ts:62-292`).
- **Approval re-check.** `authorize` reads `plugin_external.approval` (`packages/plugin-host/src/external-ops.ts:37-76`) and fails unless the plugin is active, runs the approved digest and holds exactly the receipts it was loaded with (`packages/plugin-host/src/external-authorization.ts:65-81`). This runs before the call, before every SDK call and before the result is accepted (`sandbox-runtime.ts:457`, `:564`, `:569`). Private-storage writes check the receipt again inside their own transaction (`packages/plugin-host/src/private-storage.ts:479-482`).
- **Limits.** 1 MB per message line (`sandbox-protocol.ts:6`), 1024 SDK calls per invocation (`sandbox-protocol.ts:7`; 200 000 for a batch, `:14`), 30 s per invocation (240 s when `image_generation` is granted, `external-plugin.ts:71`), at most 4 children per host process. A fifth call fails at once with `SandboxBusy` (`sandbox-runtime.ts:380`, `:448`).
- **Cost.** Measured while writing this (Deno 2.4.2, Apple silicon, an operation that makes no SDK call): 100-230 ms per call, of which about 25 ms is bundling. CI uses a newer Deno; a 1-vCPU Cloud Run admin will be slower. This matters for composition points, which run on every editor preview.
- **No plugin code in a held transaction.** A sandboxed plugin asked at render time while the caller holds an admin transaction is refused (`packages/plugin-host/src/dispatch.ts:619-633`, #1254).
- **No plugin code on the gateway.** A visitor-facing operation is a declaration core code runs (#1340, [plugin-public-surface.md](../plugin-public-surface.md)). External code never answers a visitor.

### 2.2 How shipped plugins use the 14 capabilities

Read from the plugin definitions (`packages/plugins/*/src/index.ts`, `requestedCapabilities` and the fields set):

| Capability | Shipped users | Surface | Host consumer | Gate today |
|---|---|---|---|---|
| `cms_admin` | comments, consent-manager, forms, international-site, site-assistant, site-search | `ctx.cms.call(op, input)` (`index.ts:2116-2121`) | `makePluginCms` runs the op as actor kind `plugin`, inheriting the chat branch (`packages/plugin-host/src/capabilities.ts:795-841`) | Attached when requested (`capabilities.ts:225`, `:232-234`); op must admit `plugin` (`packages/query-api/src/execute.ts:69`). About 60 operations admit it (37 in admin-core, 26 in the plugin host, counting single-line `actorScope` arrays). No op allowlist is checked for shipped plugins. |
| `ai_provider` | comments, forms, international-site, newsletter, site-search | `ctx.ai.complete`, `ctx.ai.generateObject` (`index.ts:2129-2174`) | `makePluginAi`: input Zod, ledger reservation, settle (`packages/plugin-host/src/plugin-ai.ts:55-80`, `:112-130`) | Attached when requested and a provider exists (`capabilities.ts:238-240`); per-plugin cap `plugins.ai_cost_cap_microcents`, default none (`packages/plugin-host/src/ai-ledger.ts:155-170`) |
| `snapshots` (withdrawn in Phase A, §7.4) | none | `ctx.snapshots.emit` (`index.ts:2176-2184` before its removal) | `makePluginSnapshots` calls the snapshot emitter with any entity kind, id and payload, on main (`capabilities.ts:848-877`) | Attached when requested (`capabilities.ts:241-243`) |
| `background_workers` | auth, consent-manager, international-site, newsletter, ratings, site-assistant, site-search | `workers[]` (`index.ts:237-263`) | `pluginWorkerScheduler.schedule` (`loader.ts:1600-1622`); the tick runs `plugin:<slug>/<worker>` tasks (`packages/admin-core/src/scheduler/plugin-workers.ts:64-89`) with origin `worker` (`packages/plugin-host/src/scheduler.ts:82-107`) | Registration refused without the grant (`loader.ts:1102-1106`) |
| `change_journal` | consent-manager (module, content_instance; all lines), international-site (10 kinds + own tables; main) | `changeConsumer` (`index.ts:1035-1057`) | `change-consumers.ts`: batches of up to 500 changes (`:84`), origin `chat` on a branch or `system` on main (`:505-509`) | `loader.ts:1110-1135`; core kinds also need `cms_admin` |
| `email` | auth, forms, newsletter | `ctx.email.send / unsubscribeLink / queue` (`index.ts:2062-2107`), `mailTemplates`, `mailUnsubscribe`, `requires: ["email"]` | `makePluginEmail` (`packages/plugin-host/src/mail-queue.ts:137-221`); the outbox drain with per-recipient and site-wide caps (`packages/admin-core/src/email/outbox.ts:1-31`) | Attached when requested, on the admin and the gateway (`capabilities.ts:229`, `:244-247`). `send` takes any HTML to any address and is not capped (`mail-queue.ts:145-163`). |
| `head_contributions` | international-site | `contributes`, `contributionsOperation`, `shareImagesOperation` | `collectContributions`: Zod per entry, contradiction check, core escapes (`packages/plugin-host/src/head-composition.ts:87-212`, `:213-252`); `resolveShareImages` (`packages/plugin-host/src/share-images.ts:49-101`) | Validator (`packages/plugin-sandbox/src/validate.ts:217-222`) |
| `url_slots` | international-site (`path-prefix`, `host`) | `urlContributions`: synchronous `encode`/`decode` functions (`index.ts:1941-1981`), `urlAnnotationsOperation` | `url-composition.ts:177`, `:214`, `:299`, `:365`; called from write ops inside their transaction (`packages/admin-core/src/ops/content/compose-paths.ts:235-310`) | Release-signed only (`loader.ts:1409-1418`) |
| `client_assets` | comments, consent-manager, site-assistant, site-search (`buildAssets`); consent-manager (`deferralsOperation`) | `buildAssets` returns `.js`/`.css` per build; `deferralsOperation` returns per-module verdicts with placeholder HTML (`index.ts:630-656`) | `collectBuildAssets`, 512 KB per plugin, `csp-sources.json` (`packages/plugin-host/src/client-assets.ts:80`, `:90`, `:158`) | `buildAssets` refused unless `tier === 1` (`loader.ts:1151-1155`) |
| `list_sources` | consent-manager, international-site | `listSources` + `listSourcesOperation` | `list-source-resolution.ts`: entries validated per node field, 4 MB answer cap (`:56`, `:84-112`, `:158-181`); names claimed site-wide (`list-sources.ts`) | `loader.ts:1215-1232` |
| `list_types` | site-assistant, site-search | `listTypes` (data) | `list_types.sync_plugin_types` at load (`loader.ts:1553-1576`) | `loader.ts:1182-1186` |
| `list_resolve` | international-site | `listResolveOperation` | `list-resolve.ts`: overlays per variant, 16 MB answer cap (`:47`) | `loader.ts:1187-1200` |
| `content_variants` | international-site | `contentVariantsOperation` | `content-variants.ts:89-148`; answer `{moduleId?, values?, problems?}` with `values: record<unknown>` (`index.ts:718-724`) | validator (`installation-policy.ts:41`) |
| `link_resolve` | international-site | `linkResolveOperation`, `linkResolveReads`, `linkLocationsOperation` | `link-resolve.ts`: a page partition `{variant, group}` per page (`index.ts:747-757`) | validator (`installation-policy.ts:42`) |

Two facts from this table shape the whole design:

- **The manifest carries booleans, not operation names**, for most composition points (`hasContentVariants`, `hasLinkResolve`, `hasListResolve`, `hasShareImages`, `hasDeferrals`, `hasBuildAssets`: `index.ts:1315-1330`, `:1396`). The names live on the definition object (`index.ts:2771`, `:2791`, `:2894`, `:3080`), which an external plugin does not have on the host side: the host builds its definition from the manifest alone.
- **Field values are not escaped at render.** The template engine substitutes values raw (`packages/shared/src/template-engine.ts:117-121`), and a `text` or `richtext` value is checked only for type and length (`packages/shared/src/lists/fields.ts:216-224`). Every composition point that returns values (list sources, list overlays, content variants, deferral placeholders) is therefore a channel for HTML into public pages.

### 2.3 Calls that act for nobody

An external plugin gets private storage, private files, images, fonts and site media only for an authoring origin (`chat`, `owner-panel`, `approved`) and only when the human it acts for holds `content.write` (`capabilities.ts:179-211`, `:282-292`). A worker (`worker`), a change-consumer batch (`system`, or `chat` without a human), an observer and a batch get none of them. A shipped plugin's worker gets every handle it requested (`capabilities.ts:213-279`). Q1 decides this. **Decided (Q1 A) and implemented:** a call of origin `worker`, `system`, `observer` or `batch` without a chat branch gets the plugin's private storage on main as the plugin actor (`UNATTENDED_ORIGINS`, `capabilities.ts`), and nothing else of the author handles.

---

## 3. Principles

1. **One handle, two transports.** Every capability is a host handle built in `capabilities.ts`. The handle holds every check. The sandbox broker only parses the wire arguments and calls the same handle; a shipped plugin calls it in-process. A check added for external plugins goes into the handle, so shipped plugins are held to it too (Q2 covers rules that change shipped behaviour). This is how "a shipped plugin may do nothing a runtime-installed plugin with the same grants could not" holds by construction, and it is the path to CMS_REQUIREMENTS §14.3's target of one sandbox for every plugin.
2. **Four mechanisms**, chosen per capability:
   - **(A) Host-initiated run**: the host decides when to run a plugin operation (a tick, a journal batch) and runs it in the sandbox like a tool call.
   - **(B) Declarative output**: core asks at a composition point, the sandbox returns data, the host validates it against a host-owned schema and core renders it.
   - **(C) Brokered call**: the plugin calls a named host operation over the RPC; the host checks the receipt and the operation's own rules.
   - **(D) Manifest data**: the reviewed manifest says it; no plugin code runs (list types, worker specs, URL tables).
3. **The receipt is the authority.** Constraints (an operation allowlist, an AI cap) are read from the receipt row (`plugin_capability_grants.constraints`, written at `installations.ts:305-309`), never from the manifest at call time.
4. **Render paths read, and run outside transactions.** Nothing on a render path writes (`capabilities.ts:398-406`), and no sandbox call runs inside a held transaction (`dispatch.ts:619-633`).
5. **Core serializes what reaches a page.** A plugin returns typed data; core escapes it or refuses it. No plugin output becomes raw HTML in `<head>` (CLAUDE.md §2) or unchecked markup in the body.
6. **Plugin code has no network.** The only way out of the sandbox is what the host writes on its behalf, so public tables and page output are the exfiltration channels. Every broker says what it lets reach a visitor.
7. **Fail loudly and actionably.** Every refusal names the capability, the rule and the next step (CLAUDE.md §11).

---

## 4. Shared pieces

### 4.1 Capability status record and refusal at submission (cross-cutting item 1)

`packages/plugin-sdk/src/external-capabilities.ts` (implemented), typed as a `Record` over the enum, so a new capability does not compile without an entry (the pattern of `PLUGIN_CAPABILITY_INFO`, `packages/plugin-sdk/src/capability-info.ts:17`):

```ts
export type ExternalCapabilityStatus =
  | { readonly status: "brokered" }
  | { readonly status: "planned"; readonly issue: number };

export const EXTERNAL_CAPABILITY_STATUS: Readonly<Record<PluginCapability, ExternalCapabilityStatus>> = { … };
```

A third status, `withdrawn`, is not needed: the one capability it would have described, `snapshots`, was removed from the enum (§7.4). The helpers next to the record are `isExternallyBrokered`, `externallyBrokeredCapabilities`, `externalCapabilityRefusal` (the message below) and `externalCapabilityHint` (the hint for a submission without grants).

**Current status** (keep in step with the record):

| Status | Capabilities |
|---|---|
| brokered | `cms_admin`, `cms_admin_schema`, `change_journal`, `chat_runner_tools`, `background_workers`, `head_contributions`, `list_types`, `list_sources`, `link_resolve`, `list_resolve`, `content_variants`, `companion_skills`, `font_assets`, `private_files`, `image_generation`, `site_media_read`, `consent_provider`, `page_output`, `collections`, `batch_jobs`, `visitor_ai`, `ai_provider`, `email`, `client_assets`, `url_slots` (only `host` and `path-prefix`, as declared tables: §6.8) |
| planned | none: every capability is brokered (a new one names its issue) |

- The 12 brokered capabilities started as `brokered`, the others as `planned` with issue 1729 until each gets its own issue.
- `external-plugin.ts:34-55` and `loader.ts:887-904` are replaced by a lookup in the record.
- `validateInstallationPolicy` (`packages/plugin-sandbox/src/installation-policy.ts:6`) refuses a requested capability that is not `brokered`. It runs in `stage_installation`, `approve_installation`, `finalize_installation` and `readExternalApproval` (`external-authorization.ts:97-102`), so an artifact staged before this change cannot be approved either, and the load error stays as a last line.
- The refusal, written for the AI that submitted:

  > `background_workers` (Background jobs) is not available to runtime-installed plugins yet (#1729). Remove it from `requestedCapabilities` and remove `workers`, which needs it. Runtime-installed plugins can request: cms_admin_schema, chat_runner_tools, companion_skills, font_assets, private_files, image_generation, site_media_read, consent_provider, collections, page_output, batch_jobs, visitor_ai.

  The "remove X, which needs it" part comes from a second record, `CAPABILITY_MANIFEST_FIELDS: Record<PluginCapability, readonly string[]>` (the manifest fields `installation-policy.ts:27-44` already maps to capabilities).
- `plugins.submit` (`packages/admin-core/src/ops/plugins/registry.ts:347-462`) validates without `allowExternalCapabilities`, so a tier-2 manifest that declares `workers` or `tools` gets the hint "background workers are Tier 1 only" (`validate.ts:285-290`). That wording predates the one-plugin model. The hint changes to "declare `requestedCapabilities: [...]` with a reason", followed by the status message above.
- `submit_plugin` (`packages/admin-core/src/ai/tools/submit-plugin.ts:14-22`) names only two capabilities. Its description lists the brokered ones, generated from the record, in one short line (the tool-text rules, [ai-tool-texts.md](./ai-tool-texts.md)).
- The Owner's review page shows an artifact that was staged before this change and requests an unbrokered capability as "cannot be approved: … is not available yet", with no Approve button.

Size **S**. It ships first: it is the issue's first acceptance criterion.

### 4.2 Parity test (cross-cutting item 2)

`packages/plugin-host/src/external-capability-parity.test.ts`, a unit test with no database:

1. **Every capability has a status.** It iterates `pluginCapability.options` and expects an entry in `EXTERNAL_CAPABILITY_STATUS`. The `Record` type already enforces this at compile time; the runtime check guards against a cast.
2. **Every `planned` entry names an issue** (a positive integer), and `validateInstallationPolicy` refuses a manifest requesting it with a message that contains `#<issue>`.
3. **Every `brokered` entry is exercised.** Each broker PR registers a smoke in `EXTERNAL_BROKER_SMOKES: Partial<Record<PluginCapability, () => Promise<void>>>`: a fixture external plugin requesting the capability is built with `externalPluginDefinition` and run through the real sandbox (Deno). The test fails for a `brokered` capability without a smoke.
4. **The definition carries what the capability needs.** For each `brokered` capability, a fixture manifest sets every field in `CAPABILITY_MANIFEST_FIELDS`, and the test checks that the definition `externalPluginDefinition` returns carries each of them (this catches the drift in §1 item 3).
5. **No hand-written lists.** The test reads `external-plugin.ts` and `loader.ts` and fails if either contains a string literal that is a capability name. The lookup must go through the record.

A new capability without a status fails the type check and the test. A capability marked `brokered` without a smoke or without its fields fails the test.

### 4.3 One registration seam

**Implemented in Phase A** as `preflightRegistration(def)` (the gates, before any side effect) and `registerPluginSurfaces(lp, host)` (`packages/plugin-host/src/loader.ts`), called by both load paths. The external path also runs an installed plugin's `onActivate` (decision Q1 A): the manifest declares `hasOnActivate` (optional, so no shipped manifest changes), the definition runs it in the sandbox as `$onActivate`, and `$inspect` refuses an artifact whose flag does not match its definition. Each later broker adds its manifest fields to `externalDeclarations` (`packages/plugin-host/src/external-plugin.ts`, a pure function the parity test checks) and gets the registration from the seam.

`registerLoadedPlugin` and `loadTier2Row` share one function, `registerPluginSurfaces(lp, def, infra)`, extracted from `loader.ts:1484-1622`: URL slots, config seed, `onActivate`, list types, tools, list sources, prompt context, workers and skills. Each surface registers only when the definition carries it; the capability gates in `loader.ts:1096-1231` stay in front of it. Each broker PR then adds the manifest-to-definition mapping in `externalPluginDefinition` and the broker, and gets the registration for free. The external path's own steps (approval, `$inspect`, schema provisioning) stay where they are. Size **M**; it ships inside the `background_workers` PR, which needs it first.

### 4.4 Sandbox runtime changes

**Implemented in Phase A:** the bundle cache, the two pools, the budget per kind (`SANDBOX_BUDGETS`, `SANDBOX_POOLS` in `packages/plugin-host/src/sandbox-runtime.ts`) and the call limit per kind. The kind of a call comes from its origin (`sandboxKindOf` in `external-plugin.ts`: worker, batch, render with a `renderId` is a preview, any other render a build, the rest interactive), or from `RunPluginOperationOpts.sandboxKind` for calls whose origin does not say it (a journal batch, a rebuild chunk); it travels on the context under the host-only symbol `SANDBOX_KIND` (`sandbox-kind.ts`). **Implemented in Phase B3a:** the render-point runtime (`packages/plugin-host/src/render-points.ts`): the reserved entries (`RENDER_POINT_ENTRIES`, resolved by the child, checked by `$inspect` both ways), page ids in chunks (`chunkPageIds`, by bytes and, for a point whose answer grows with its pages, by count), answers over one line as `part` messages capped at the caller's total (`RunPluginOperationOpts.maxAnswerBytes`, `SANDBOX_ANSWER_BYTES`), and `assertAnswerSize` for an in-process answer. A new point adds one row to `RENDER_POINT_ENTRIES`, asks through `runPluginOperation` with its cap and checks its values with `plugin-values.ts` (§4.5).

Needed by the host-initiated runs and composition points:

| Change | Why | Where |
|---|---|---|
| **Bundle cache keyed by artifact digest** | Bundling is about 25 ms of each call (§2.1) and is a pure function of the digest-bound source. Cache the bundle in memory per digest; the child is still new per call. | `sandbox-runtime.ts:297-302` |
| **Two slot pools** instead of one global limit | Today 4 children per process, and a fifth call fails at once (`sandbox-runtime.ts:448`). A worker or journal batch must not make a chat tool call or an editor preview fail. Pools: *interactive* (chat, panel, approved, render) and *background* (worker, journal batch, rebuild), each with a short wait queue that has a deadline instead of an immediate `SandboxBusy`. Numbers in Q10. | `sandbox-runtime.ts:380-448` |
| **Time budget per invocation kind** | One 30 s value (`external-plugin.ts:71`) fits a tool call, not a worker run (lease 5 min, `plugin-workers.ts:29`) or a preview (which must stay fast). Numbers in Q10. | `external-plugin.ts:63-72` |
| **Call limit per kind** | 1024 SDK calls (`sandbox-protocol.ts:7`) is small for a worker that pages through rows. The time budget bounds a background run; raise its call limit as `SANDBOX_BATCH_CALL_LIMIT` does for batches (`sandbox-protocol.ts:14`). | `sandbox-runtime.ts:567` |
| **Chunked arguments and answers** | The wire limit is 1 MB per line (`sandbox-protocol.ts:6`), and some composition points exceed it: `link_resolve` is asked about every page of the site (50 000 page ids are about 1.9 MB), and list-resolve answers may reach 16 MB (`list-resolve.ts:47`). The host splits the page ids into chunks and merges the answers, with one call per chunk. An answer the plugin cannot fit in a line it returns in parts through a `result.part` message (new in `sandboxMessage`); the host enforces the point's total cap while assembling. | `sandbox-protocol.ts`, `sandbox-entry.ts` |
| **Reserved entry names for composition points** | The host has no operation name for a point (§2.2). The child resolves `$contentVariants`, `$linkResolve`, … from the plugin's own definition, as it already does for `$staticRender` (`sandbox-entry.ts:229-233`), and `$inspect` checks each one the manifest's flags announce (`sandbox-entry.ts:221-228`). Q3. | `sandbox-entry.ts` |
| **Approval check per invocation for background kinds** (optional) | `authorize` reads the approval op before every SDK call (`sandbox-runtime.ts:569`). A worker that makes 5 000 calls makes 5 000 approval reads. Writes already re-check the receipt inside their own transaction (`private-storage.ts:479-482`), so a background run could check once per invocation plus per write and still meet §14.2 ("a revoked grant takes effect before the next operation"). Measure first; keep per-call checks if the cost is small. | `sandbox-runtime.ts:564-569` |

A **render session**, meaning one child per plugin and render pass that answers every composition point of that pass, would save one spawn per point. It is left out: it changes the one-child-per-call isolation. It is worth considering only if measurements after PR 8 show that previews with an external contributor are too slow.

### 4.5 Values that reach a page

All composition points that return values go through one host function, `checkPluginValue(field, value)`, for what does not depend on where the value goes. The template engine itself does no escaping (`template-engine.ts`: module HTML substitutes raw):

- `text`, `select`, `icon`: data, never markup. Kept raw here and escaped where they land (below).
- `link`: `linkValueSchema` (`fields.ts`), plus a refusal of any scheme but `https:`, `http:`, `mailto:`, `tel:` and of protocol-relative `//host`, as written and as a browser decodes it in an attribute (`javascript&#58;`).
- `richtext`: CLAUDE.md §1A says richtext is prose. The value is parsed with `htmlparser2` and refused if it contains an element outside an inline and block prose allowlist (`p`, `a`, `strong`, `em`, `ul`, `ol`, `li`, `h2`-`h6`, `blockquote`, `code`, `br`, `span`), any `on*` attribute, `style`, or a URL attribute that fails the `link` rule. It is refused, not cleaned: a cleaned value would be a silent fallback (CLAUDE.md §2), and the refusal names the element and the field.
- `media`: `caelo:media/<id>`, and the asset must exist and be `library` (not `reference`) on the render's branch.

**Where the value lands decides the rest** (maintainer decision on #1732, 2026-11-26). A checked value stays the plugin's (`pluginValue`, shared `lists/plugin-values.ts`, with its origin: plugin, point, field, type) until the template engine substitutes it. The engine knows the place of every `{{…}}` tag of a module template from `template-contexts.ts`, which works it out once per template text (the tags are masked to opaque words, the HTML runs through htmlparser2's tokenizer, and the result is kept for the most recent 512 templates; a render without a plugin value never asks). `contextualPluginValue` then decides:

| Where the module puts it | A plugin's value |
|---|---|
| Element content, a comment, `<title>`, `<textarea>`; a quoted attribute that is no URL | HTML-escaped (`& < > " '`); a `richtext` stays prose in content and is escaped in an attribute. Never refused for its words: "JavaScript: Grundlagen" renders as text. |
| An unquoted attribute (`title={{label}}`) | Escaped for that context too: `=`, the backtick and whitespace as character references, so the value stays one value and starts no other attribute; an empty one is written `""`. |
| A URL attribute (`href`, `src`, `srcset`, `action`, `formaction`, `poster`, `cite`, `xlink:href`, `data`, `ping`, …) | The link rule when the placeholder decides the URL's scheme; the URL characters only when unconditional template text before it already ended the scheme part (`mailto:{{x}}`, `/de/{{slug}}`); refused when the template's own scheme is no link scheme (`javascript:{{x}}`, `context-url-scheme`) or when the scheme could be made of several parts (`url-composed`: `{{a}}{{b}}`, `{{x}}:…`, a section before it whose text may be absent, or a section around it that may repeat it). A `&` in the template's text before the scheme part ends makes it composed too, since a character reference could be completed across the value or a section (`{{x}}&#58;…`, `jav&#{{x}};…`), and in a URL the value's own `&` is written `&amp;`, so it starts none. Text fields included. |
| An event handler (`on*`), a `style` attribute, `srcdoc`, a `<script>` or `<style>` body, a tag or attribute name, `<meta>`, `<base>`, an SVG animation's `to`/`from`/`values`/`by` | Refused, whatever it says (`context-event-handler`, `context-style-attribute`, `context-srcdoc`, `context-script`, `context-style`, `context-tag`, `context-meta`, `context-base`, `context-svg-animation`). |

A refused value keeps its placeholder raw and records `plugin-value-refused:<plugin>.<point>.<field>:<rule>`, a render failure in the #1604 sense: listed in the preview, recorded by a Stage, filed by the audit (`render/plugin-value-refused`, fix `get_plugin`), refused by Publish live. A core value is never asked: it substitutes as it always has, in every place, so no existing module is flagged by this. A plugin value that reaches Mustache unhandled (a tag form the section pass does not own) fails loudly as `context-unknown`, never as an object or unchecked.

Q2 decided that this binds shipped plugins in the same PR. **Implemented in Phase B3a** for every plugin (`packages/plugin-host/src/plugin-values.ts`), and made context-dependent after the review of #1732. Media facts come from `media.describe_many`. The shipped list sources (consent-manager, international-site) declare only `text`, `link` and `boolean` fields, so nothing of theirs is refused.

### 4.6 Adding a broker (checklist, from Phase A on)

1. **Status:** flip the capability to `brokered` in `EXTERNAL_CAPABILITY_STATUS` (`packages/plugin-sdk/src/external-capabilities.ts`) and keep `CAPABILITY_MANIFEST_FIELDS` exact. Update the table in §4.1 and the CMS_REQUIREMENTS §14.13 bullet.
2. **Declarations:** carry the capability's manifest fields in `externalDeclarations` (`packages/plugin-host/src/external-plugin.ts`). A `has…` flag whose point a reserved entry answers also needs its `DEFINITION_KEY` entry in the parity test.
3. **Registration:** if the shipped path registers something for it, that code belongs in `registerPluginSurfaces` (`loader.ts`), so both paths run it; gates belong in `preflightRegistration`.
4. **Handle:** put every check in the host handle built in `capabilities.ts` (principle 1). The sandbox broker in `sandbox-runtime.ts` only Zod-parses the wire arguments, and the method joins `sandboxMethod` (`sandbox-protocol.ts`) and the child's `ctx` (`sandbox-entry.ts`, attached by a `has…` flag in the first message).
5. **Reserved entries:** a composition point the host asks is a `$name` entry the child resolves from the plugin's definition (like `$staticRender`, `$onActivate`), checked by `$inspect` against the manifest's flag.
6. **Kind:** a call whose origin does not say what it is passes `RunPluginOperationOpts.sandboxKind` (`journal`, `rebuild`). It also reaches `makePluginContext` (`MakePluginContextOpts.sandboxKind`), for in-process plugins too, so a handle can apply a rule of that kind of work (Phase B1: no public-table writes from journal work, site-wide reads only in background work).
8. **Operations:** an operation that admits actor kind `plugin` declares `pluginAccess` (`read`, `write`, or `handle` when it backs one of the plugin's own handles); the registry tests in admin-core and plugin-host fail without it (Phase B1, §7.1).
7. **Parity:** add the capability's smoke to `SMOKES` in `external-capability-parity.test.ts`, plus adversarial sandbox cases for the new surface and an integration test through staging, approval and activation (`external-plugin-seam.integration.test.ts` has the flow).

---

## 5. Group A: host-initiated runs

### 5.1 `background_workers`

**Today.** See §2.2. The worker spec is reviewed manifest data; the run is `runPluginOperation` with `{ _trigger: "worker", workerName }` and origin `worker` (`scheduler.ts:82-107`); the tick gives each worker a 5-minute lease and stops claiming after its 4-minute budget (`plugin-workers.ts:29`, `packages/admin-core/src/scheduler/tick.ts:41`).

**Mechanism (A).** No new RPC. `externalPluginDefinition` carries `workers`; `registerPluginSurfaces` schedules them; a run dispatches to the external definition's operation, which is already a sandbox invocation (`external-plugin.ts:63-72`).

**Host checks.**
- The receipt for `background_workers` exists for the running digest (registration, `loader.ts:1102-1106`, and `authorize` per call).
- The cron is parsed with croner in every review (`parseWorkerCron`, #1720). The tick rounds every cron up to its interval, so a worker runs at most once per tick: this is the rate limit.
- Background pool, background time budget (Q10), raised call limit (§4.4).
- `publicDatabases: "each"` runs once against the staging public database with a context that has `ctx.query` and nothing else (`capabilities.ts:113-127`). That works for external plugins unchanged.
- What the worker's context holds is decided by Q1.

**Risks and how they are closed.**

| Risk | Closed by |
|---|---|
| A worker that never ends | The time budget and SIGKILL (`sandbox-runtime.ts:504-508`). The due-table records the failure and the next occurrence runs as usual (`scheduler.ts:34-35`). |
| A worker that floods the database | Each SDK call is a named op on an index the manifest declares (the #1292 index gate refuses unindexed reads); the call limit and the time budget bound one run; the tick rounds the cadence. |
| A worker that starves chats and previews | The separate background pool (§4.4). |
| A worker that keeps running after a revoke | `authorize` before every SDK call and before the result is accepted; writes re-check inside their transaction. |
| Writes nobody reviews | Private-storage writes land on main through `plugin_storage.*` and are audited and snapshotted ([branch-aware-plugin-storage.md](../branch-aware-plugin-storage.md), decision 1). Public-table writes go live; that is the case for shipped workers too (ratings aggregates). See Q12 for workers that hold `cms_admin`. |

**What stays different.** Nothing beyond what holds for shipped workers: no timer, no network, the tick's granularity.

**Tests.**
- Integration (real Postgres; extends `packages/admin-core/src/__tests__/plugin-installations.integration.test.ts`): stage, approve and finalize an external plugin with a worker; `runSchedulerTick` runs it; the row it writes is there; `publicDatabases: "each"` writes to both public databases.
- Adversarial: an endless loop is killed at the budget, recorded as failed on its due-table row, and the other tasks of the tick still run; a worker run after `revoke_capability` fails before its first SDK call; a worker that makes more calls than its limit; a worker that tries `adminQuery` while Q1 says no (`SandboxCapabilityDenied`); a worker that tries to write a public table on the staging target outside its declared tables; a worker in the background pool does not cause `SandboxBusy` for a concurrent chat tool call.
- Parity smoke (§4.2).

**Size M**, including the registration seam (§4.3) and the runtime changes (§4.4).

### 5.2 `change_journal`

**Today.** See §2.2 and [state-and-changes.md](./state-and-changes.md). A batch is up to 500 change records with ids only (`index.ts:1060-1084`); the plugin reads what it needs through `ctx.cms` and stores the result; a rebuild is one call with `{}` that recomputes everything. `plugin_changes.cursor_state` answers a plugin about its own cursor and is reached through `ctx.cms` (`change-consumers.ts:376-397`, used at `packages/plugins/international-site/src/index.ts:367`).

**Mechanism (A)** for batches and rebuilds, **(C)** for the cursor state. `externalPluginDefinition` already carries `changeConsumer` (`external-plugin.ts:112`); the drain dispatches to the sandbox like any operation.

**RPC surface.** `changes.cursorState()`, no arguments, returns `{ continuous: boolean }`, attached with the `change_journal` receipt. It needs no `cms_admin` grant, because it only answers about the plugin's own consumer.

**Host checks.**
- Core kinds need the `cms_admin` read grant, as today (`loader.ts:1116-1120`). A consumer of `ownTables` only can ship before the `cms_admin` broker.
- A batch on a chat's branch runs in that branch's scope, so the plugin's writes land on the branch and are staged with it (`change-consumers.ts:505-509`). Which handles it gets: Q1.
- Background pool and budget. A failure never fails the write that caused it; the batch is delivered again and the failure is recorded against the plugin (#1008).
- **The rebuild is chunked** (Q11). A full recompute of a 50 000-page site does not fit a 60 s sandbox call. The SDK contract becomes `rebuild({ cursor? }) → { done?: boolean; cursor?: string }`, and an answer without `done: false` means done, so today's shipped rebuilds stay valid. The host keeps the cursor on the consumer row, and the consumer stays in "rebuilding" across ticks until done.

**Risks.**
- **Reading the whole site**: a consumer of core kinds reads changed entities through the `cms_admin` broker, which only allows the receipt's operations (§7.1) on their own `readScope`.
- **Staged content reaching visitors**: a main-line batch sees staged content that is not published yet. A batch that copies it into a `published` public table shows it to visitors before Publish live. Observers and batches are already refused public-table writes for this reason (`capabilities.ts:407-415`); Q12 proposes the same rule for journal batches.
- **Delivery load**: at most `MAX_BATCHES` batches per drain (`change-consumers.ts:90`) and the background pool.

**What stays different.** The plugin never sees the journal itself, only change records for its declared kinds; the cursor and the claims belong to the host.

**Tests.** Integration: an external consumer of its own table receives a batch for a chat write on the chat's branch and for a main write on main; a rebuild resumes across three ticks; a consumer with core kinds and no `cms_admin` receipt is refused at registration. Adversarial: a batch that throws is delivered again and leaves the write intact; a batch that writes a public table is refused (if Q12 is A); a rebuild that never reports `done` stays "rebuilding" and is visible in plugin health, without blocking other consumers.

**Implemented (Phase B1).**
- The drain dispatches batches with kind `journal` and rebuild chunks with kind `rebuild` (`change-consumers.ts`), so a sandboxed consumer gets the background pool and budget, and every plugin's handles know it.
- `ctx.changes.cursorState()` answers the plugin about its own consumer with the `change_journal` grant alone, on every admin-side origin but a visitor's. international-site used `ctx.cms.call("plugin_changes.cursor_state")` and now uses the handle; the operation is `pluginAccess: "handle"`.
- A journal batch on a chat's branch acts unattended on that branch (Phase A's known gap): an installed plugin gets private storage and `ctx.cms` there, and its writes are staged with the chat.
- Q12 for every plugin: `ctx.query` refuses public-table writes from journal batches and rebuilds (`capabilities.ts`, next to the observer and batch rule). No shipped consumer wrote public tables.
- Q11 for every plugin: the rebuild operation gets `{ cursor? }` and answers `{ done: false, cursor }` to continue. The host stores the cursor on the consumer (`change_consumers.rebuild_cursor`, migration 0800, `plugin_changes.save_rebuild_cursor`, fenced on the claim) and runs at most 10 chunks per drain (`DrainLimits.maxRebuildChunks`). With chunks left the consumer reports `rebuilding` and resumes at its next drain, and no batch reaches it until the rebuild is done. Any other answer means done (today's rebuilds are unchanged). An answer of `done: false` without a cursor, or with the cursor the chunk was given, is refused loudly (`rebuildChunkOutcome`).
- Plugin health carries `consumerRebuild` (since when, resumable), in Settings → Plugins and `get_plugin`. Migration 0801 lets human and ai actors read `change_consumers` for it.
- A consumer of core kinds without the `cms_admin` grant is refused at staging (the manifest schema) and again at registration.

**Size M.** It depends on §7.1 for core kinds.

---

## 6. Group B: declarative output

The same rules apply to every point in this group:

- Origin `render`, read-only; the plugin's private reads see the render's branch (`RenderScope`, [branch-aware-plugin-storage.md](../branch-aware-plugin-storage.md) §5).
- Asked before the caller opens a transaction (`dispatch.ts:619-633`), batched once per pass, arguments and answers chunked (§4.4).
- Interactive pool. Render budget: Q10.
- A failure in a preview is flagged and the page renders without the plugin's contribution; a failure in a build stops the build (`render-failures.ts`, #1087). This is unchanged.
- The host validates the answer against its schema and size cap before anything renders it. Values go through §4.5.
- Operation names come from the reserved entries (§4.4, Q3).

### 6.1 `list_types` (mechanism D)

**Today.** `listTypes` is manifest data; at load `list_types.sync_plugin_types` stores it as types owned by the plugin and available while it runs (`loader.ts:1553-1576`). Slugs must start with `<slug>-` (`index.ts:1565-1573`).

**Design.** `externalPluginDefinition` carries `listTypes`; `registerPluginSurfaces` syncs them. No plugin code runs. The existing schema (`listTypeDefSchema`, at most 20 per plugin) and the sync op's validation against every stored list of the type stay the checks.

**Risks.** None beyond the shipped case: a type is a definition, and the prefix keeps it from replacing a site's types.

**Tests.** Integration: an external plugin's types appear while it runs and become unavailable when it is disabled; a slug without the prefix is refused at staging. **Size S.**

### 6.2 `head_contributions` (with share images)

**Today.** The answer is typed (`headEntry`, `sitemapContribution`, a BCP 47 `lang`), and core escapes it (`head-composition.ts:213-252`). But `rel` is any string of up to 60 characters, a `meta` may carry any `name` or `property`, and `href` is any string (`index.ts:384-428`). international-site uses only `link rel="alternate"` with `hreflang` (`packages/plugins/international-site/src/index.ts:2272-2279`).

**Mechanism (B)**, entry `$contributions`, plus `$shareImages`.

**Answer for external plugins** (Q2 decides whether shipped plugins follow):
- `link`: only `rel: "alternate"` with `hreflang`. The target is named by `pageId`, and core builds the URL with the same resolver as the page's canonical. A plugin never composes a URL for a page of the site (#590 already asks shipped plugins to do this; for external plugins it becomes the only form).
- `meta`: an allowlist (`property` `og:locale` and `og:locale:alternate`). `robots`, `googlebot`, `referrer`, `viewport` and anything core's SEO fields own are refused. SEO is fill-once and owned by core (CLAUDE.md §2), and a `noindex` from a plugin could take the whole site out of search.
- `sitemap`: `exclude` and `alternates` by `pageId`.
- `lang`: BCP 47, as today.
- Share images: the asset must exist, be an image and be `library` (`share-images.ts:33` checks only that it is a uuid).

**Risks closed.** A third-party stylesheet or preconnect (CSS injection, a request before consent) is closed by the `rel` allowlist. An off-site `hreflang` (an SEO hijack) is closed because core builds the URLs. Deindexing is closed by the `meta` allowlist. Page bloat is closed by a cap on entries per page (20) and on the whole answer (1 MB).

**Tests.** Unit: each refused `rel` and `meta`, a `pageId` from another site, a `javascript:` value in `content`. Integration: preview and build emit byte-identical head blocks for an external contributor; a contradiction with international-site fails loudly. **Size S-M.**

**Implemented in Phase B3a-2**, for every plugin (Q2 A). The vocabulary is the plugin SDK's `head-contributions.ts` (`headEntry`, `sitemapContribution`, `HEAD_ENTRIES_PER_PAGE` = 20, `HEAD_ANSWER_MAX_BYTES` = 1 MB); the host checks each answer part by part (`head-vocabulary.ts`), so one bad entry does not take a page's other alternates with it, while a page with more than 20 head entries (or sitemap alternates) gets none of them, because a cut set would claim alternates the plugin did not mean. The contribution op is asked `{pageIds}` in chunks of 200 pages (`HEAD_CONTRIBUTION_PAGES_PER_CALL`; at the vocabulary's limits a page's answer is under 5 KB, so a chunk stays under the cap); it no longer gets `siteBaseUrl` or `pageUrlStyle`, because it writes no URL. Core looks every named page up in the render's view with `pages.public_url_pages` (system-only, by id: the chat's branch in a preview, main in a build; the same rows `pages.resolve_public_urls` reads) and builds its URL with `resolvePublicPageUrls`, the canonical's builder. A refused part (rule names such as `rel-stylesheet`, `href-not-allowed`, `name-robots`, `property-og-image`, `content-format`, `page-unknown`, `entries-over-limit`, `answer-too-large`, `lang-invalid`) becomes `plugin-value-refused:<plugin>.head-composition.<field>:<rule>`; a share image that is missing, a reference image or no image becomes `<plugin>.share-images.image:media-missing|media-reference|media-not-image`, and that page shows no share image, not the site default. The preview lists them (`inspect_page_render` names the repair), `get_page_seo` carries the share-image refusal, the build records them as render failures (a Stage reports them, the audit files `render/plugin-value-refused`, Publish live refuses the build). The registration seam refuses `contributes` or a share-images operation without the grant or without its operation. An answer for a page that was not asked about and a contradiction between plugins still throw: they are contract breaks, not content.

Shipped plugins: international-site is the only one that contributes (consent-manager and the others add nothing to the head). It now names its hreflang and sitemap alternates by page id (its published-version set no longer resolves URLs; the switcher still does); `international-site-head-output.integration.test.ts` pins its generated head and sitemap on a multi-language site byte for byte, captured before the change. `external-head-contributions.integration.test.ts` runs an installed contributor through staging, approval, activation, the preview and the build's SEO pass with every adversarial case above; measured on Apple silicon, Deno 2.9.6, under heavy machine load: see the PR.

### 6.3 `list_sources`

**Today.** See §2.2. Entries are validated against the node's fields, ids are stable and unique, and an answer for a page that was not asked about is refused (`list-source-resolution.ts:16-25`).

**Mechanism (B)**, entry `$listSources`; the names come from the manifest's `listSources`, which `externalPluginDefinition` carries.

**Added for external plugins.** Value checks per field (§4.5), a 1 MB chunked answer within the existing 4 MB total, names claimed site-wide as today (a name a shipped plugin holds cannot be taken).

**Risk closed.** Stored XSS. A list source fed from an inbox table (visitor text) would put visitor HTML on every page whose module iterates it, because nothing escapes it today (§2.2).

**Tests.** Adversarial: an entry label `<img src=x onerror=…>` renders escaped; a `richtext` entry with `<script>` is refused with the field named; an answer of 5 MB is refused before it is walked; an entry for a page not asked about. **Size M**, including the shared render-point runtime (chunking, render budget, reserved entries, `checkPluginValue`), which ships in this PR because it is the first point to need it.

**Implemented in Phase B3a.** `externalDeclarations` carries `listSources`; the definition names `$listSources` as its `listSourcesOperation`; the call reads private storage read-only on the render's branch; a build asks once per 1000 pages (`LIST_SOURCE_PAGES_PER_CALL`), each answer capped at 4 MB while its parts arrive. `external-list-sources.integration.test.ts` runs it through staging, approval, activation and the preview (escaped label, refused `<script>` richtext and `javascript:` link, a refused render write); measured on Apple silicon, Deno 2.9.6: a preview of a page with an external source took 150-170 ms in all, a build-style resolve of 30 000 pages 1.8-4.4 s in 30 calls (unchunked it could not run: the page ids alone pass the 1 MB line).

### 6.4 `link_resolve`

**Today.** The answer is a page partition (`variant` token, `group`), and core maps every `caelo:page/<id>` reference (`link-resolve.ts:1-45`). It is asked about every page in the render's scope. With `linkResolveReads` declared, core keeps the answer per scope and asks only about deltas (#1269).

**Mechanism (B)**, entry `$linkResolve`.

**Added for external plugins.** `linkResolveReads` becomes manifest data and is **required** for an external contributor. Without it, every preview would ask a sandbox about every page of the site, which breaks O(request) (CLAUDE.md §2) and costs a sandbox spawn per 1 MB chunk. The page ids are chunked.

**Risks.** Misdirected links stay inside the site, and a target with no member in the variant fails loudly (by design). The low injection risk comes from the token regex (`index.ts:747-757`).

**Tests.** Integration: links on a page of variant `de` resolve to the `de` member; a second preview asks no question after an unrelated write; a write to a declared table asks again only about the pages it names. Adversarial: an answer for a page not asked about; two plugins claiming one page. **Size S-M.**

**Implemented in Phase B3b.** `linkResolveReads` is a manifest field (`linkResolveReadsSchema`, projected by `manifestFromDefinition`) and the validator requires it of **every** link resolver, shipped or installed (Q2 A): every table one of the plugin's `adminSchema` tables, every column one of theirs, `pageColumns` naming a listed table's page column, `tables: []` for an answer from the page ids alone (`linkResolveReadsFailures`, `plugin-sandbox/src/validate.ts`). The shipped test fixtures that resolved links without it now declare `{ tables: [] }`; international-site already declared it, so its derived manifest gains the field (a changed manifest the Owner approves once after the upgrade, #1332). `externalDeclarations` carries it and `$linkResolve` names `linkResolveOperation`. Core asks once per 10 000 pages (`LINK_RESOLVE_PAGES_PER_CALL`), each answer capped at 4 MB while its parts arrive (`assertAnswerSize` for an in-process answer), and the answer is `{ pages }` and nothing else. The answer carries no URL: core builds every href from the page it names (`pageRefUrl`), so the link rule of §4.5 has nothing of the plugin's to check, and the variant token rule refuses a variant that carries a scheme. `external-link-resolve.integration.test.ts` runs it through staging, approval, activation and the preview (a German page's link goes to the German page at core's path, a group spelled `//evil.example/…` never reaches an href), the kept answers (an unrelated write asks nothing, a write to the declared table asks only about the page it names), and the adversarial cases (an answer for a page not asked about, a `javascript:` variant, a shipped and an installed plugin placing one page, a 7 MB answer, a resolver past its 5 s preview budget). Measured on Apple silicon, Deno 2.9.6, on a shared machine at load 50: a preview of a page with an external link resolver took 136-492 ms the first time and 33-232 ms with the kept answers (no sandbox call for links); a build-style resolve of 30 000 pages 0.4-3.1 s in 3 calls.

### 6.5 `list_resolve`

**Today.** See §2.2: overlays replace values and hide entries, never add, remove or reorder (`list-resolve.ts:1-36`).

**Mechanism (B)**, entry `$listResolve`. The arguments' `scope` lists (up to 50 000 ids each, `index.ts:569-582`) and the answer are chunked. Values go through §4.5 against the field their address names.

**Depends on** `link_resolve` (the variants come from its partition). **Tests** as for list sources, plus an overlay that tries to add an entry or set a structural `module` value (refused and reported to the plugin's error channel, as today). **Size M.**

**Implemented in Phase B3b.** `$listResolve` names `listResolveOperation`. A scope too big for one wire line is asked in parts (`chunkListResolveScope`: lists, content instances and pages in order, the plugin sources with the first part), and the parts' overlays merge per variant (two parts setting one address to different values throw); each answer is capped at 16 MB while its parts arrive. The value checks run where an overlay value meets its field, in the shared list resolver (`pluginOverlayValue`, `shared/src/lists/resolve.ts`): the pure checks of §4.5 moved to `shared/src/lists/plugin-values.ts` (the plugin host re-exports them), `mergeListOverlays` names the plugin that set each address (`ListVariantOverlay.owners`), and the plugin host attaches what the media table says of every `caelo:media/<id>` the answers carry (`ResolvedListOverlays.media`, carried through the build's overlay batches). A refused value fails with `plugin-value-refused:<plugin>.list-resolve.<address>:<rule>`, so its spot stays raw and Publish live refuses it; it never falls back to the stored, untranslated value. An overlay that does not address a stored value (an invented entry, a structural field, a value failing its field's shape) is still refused and reported to the plugin's error channel, as before. Shipped international-site translates only `text` and `richtext` fields; its text is now escaped (identical on the page for plain text) and its richtext held to prose. `external-list-resolve.integration.test.ts` runs a resolver through staging, approval and activation and the preview (an escaped name, a refused `<script>` description and `javascript:` landing page, a translated entry, an invented entry reported), plus an answer for a variant not asked about, a 17 MB answer, a plugin past its preview budget and a 50 000-id scope asked in four parts; `plugin-overlay-values.test.ts` covers the field rules (text, link schemes, richtext, media), and that values without an owner stay core's.

### 6.6 `content_variants`

**Today.** The answer may swap the module of a layout placement or replace its values with any JSON (`index.ts:718-724`, `content-variants.ts:89-148`).

**Mechanism (B)**, entry `$contentVariants`.

**Added for external plugins.**
- `values` are checked field by field against the placement's module fields, which are in the arguments (`index.ts:684-710`), with §4.5. A key the module does not declare is refused.
- `moduleId` must name a module that exists on the render's branch.
- `problems`: at most 50 strings of at most 2 000 characters, shown as text.

**Risk closed.** Raw HTML into a site's header or footer on every page.

**What stays different.** A `richtext` translation that uses markup outside the prose allowlist is refused (§4.5). If international-site's stored translations do that today, Q2 decides whether that is a bug to fix there or a reason to keep the rule external-only.

**Tests.** Adversarial: a value for an undeclared field; `<script>` in a richtext value; a `moduleId` of a module deleted on the branch; a module swap on a page placement (already refused). **Size M.**

**Implemented in Phase B3b.** `$contentVariants` names `contentVariantsOperation`. The pages are asked in chunks below the wire line (`chunkItems`, by the bytes of each page with its placements: the build asks about every page at once), each answer capped at 4 MB, and an answer for a page its call was not asked about throws. Every value is checked by `checkContentVariantValues` (`plugin-host/src/content-variants.ts`) for the fields of the module that renders it, which for a layout variant that swaps the module is known only once the caller has loaded it: the editor preview (`preview-variants.ts`) and the build (`content-variants-pass.ts`) both run it, for every plugin. A value equal to what core would render there is core's own and stays as it is; otherwise `text` is escaped, `richtext` held to prose, `url` and `link` to the link rule, `image` to a library image, `number` and `boolean` to their type; a `list` is checked without its list type (which the point does not carry): every string to the prose rule, every `href` to the link rule, every media reference to the media rule; `module` and `module-list` values are structure (refused); a key the module does not declare is refused. A refused value becomes its stand-in, and the template engine records `plugin-value-refused:<plugin>.content-variants.<placement>/<field>:<rule>` for it whether the HTML shows the field or not, keeps its spot raw (never the field's default, the source language) and renders a refused list empty; the preview lists it, a Stage records it, Publish live refuses it. The media facts come with the answer (`ResolvedContentVariant.media`). A `moduleId` the render's branch does not have was already flagged by both callers.

**international-site under Q2 A.** Its translations keep the source's markup (the translator is told to), so a source richtext written as prose translates to prose and passes; one using markup outside the prose allowlist is refused on the translated pages, and the audit's hint says to rewrite the stored richtext as prose and translate again (the rule is not loosened). Two changes make its real output pass and render as before: the answer carries only the fields the placement's module declares (a field removed since the translation would otherwise be refused as undeclared), and a `text` field's value as text, its character references decoded (`asPlacementData`), so that the host's escaping renders `AGB &amp; Datenschutz` exactly as the source does. Proof: `international-site-chrome.integration.test.ts` now translates a shared call to action with a prose richtext and a text keeping `&amp;` through `translate_chrome`, and asserts the German page's HTML byte for byte; the same test passes unchanged on the branch before this phase (`4f5d01958`), where values were substituted raw. `external-content-variants.integration.test.ts` runs an installed contributor through staging, approval, activation and the preview (escaped text, checked prose, a refused `<script>` body, `javascript:` link and undeclared field, a swapped module the branch does not have) and the adversarial cases (an answer for a page not asked about, a module swap on a page placement, a 5 MB answer, a plugin past its preview budget). Measured on Apple silicon, Deno 2.9.6, shared machine: a preview of a page with an external content variant took 748 ms the first time and 262 ms the second (one sandbox call per preview: content variants keep no answers).

### 6.7 `client_assets`

This is the grant with the widest blast radius. The JavaScript runs on the public site's origin on every page, outside any Shadow DOM, and today it is whatever string `buildAssets` returns at build time (`client-assets.ts:158`). The editor preview frames are sandboxed without `allow-same-origin` (`apps/admin/src/lib/server/preview-sandbox.ts:7-19`), so the admin is not exposed, but every visitor is. The grant covers two things that need different designs.

**Deferrals** (mechanism B, entry `$deferrals`). The verdict schema stays (`index.ts:630-656`). The raw `defaultPlaceholder` and `editorNotice` markup (up to 20 KB of HTML each) are replaced for external plugins by placeholders declared in the manifest (`deferralPlaceholders: { <reason>: { html, css } }`). They are part of the reviewed artifact, checked like module HTML at staging, and the answer names only a reason. The module content stays inside the inert `<template>`, as today. **Size M.**

**Build assets.** The options are in Q4. The recommended design:
- The JS and CSS files are part of the artifact (`clientFiles` in the manifest, under the same 512 KB budget). The Owner reviews their bytes, and they are bound to the digest like the source. The validator checks them with a browser rule set: no `eval` or `Function`, no dynamic `import()`, no `document.write`, and network only through the component kit's gateway helpers.
- Per build the sandbox returns only a JSON data object (entry `$buildData`, at most 64 KB). Core embeds it as `<script type="application/json" data-caelo-plugin-data="<slug>">`, with `<` escaped, and the static file reads it. The code is reviewed; the data cannot become code.
- `csp-sources.json` of an external plugin may name only the site's own origins (the gateways). A third-party origin needs an approval per origin, like consent-manager's external embeds (CLAUDE.md §11.A).
- A plugin whose `consentPurposes` name a category other than `necessary` has its files started by the consent provider's runtime only after that category is granted. This needs a small contract with consent-manager.
- CLAUDE.md §1A: a client file shows, hides and toggles; it never builds content. The approval card says so, and the structure check's JS rules (`packages/admin-core/src/quality/checks/structure-js.ts`) run over the files.

**Risks closed.** Data turning into code (stored XSS through baked data), unreviewed code changing per build, third-party requests before consent, and content only JavaScript can see.

**Tests.** Adversarial: data containing `</script><script>…`; a client file with `eval`, a dynamic import or a `fetch` to a third-party host (refused at staging); a CSP source naming a third-party origin without approval (refused at build); a build that is byte-identical between preview and deploy. **Size L.**

**Implemented in Phase C1**, for every plugin, shipped or installed (decision Q2 A):

- *Deferrals.* `deferralPlaceholders` (manifest and definition, `plugin-sdk/src/client-assets.ts`) hold the markup; a verdict's `placeholder` and `editorNotice` are `{ name, values }`, and core fills the `{{name}}` slots with escaped text (`declaredPlaceholder`, `plugin-host/src/deferrals.ts`). `validateManifest` holds the markup to an element and attribute allowlist (no `src`, `style`, `on*`; links by the page link rule; no slot in an `href`) and the CSS to "loads nothing" (`plugin-sandbox/src/client-assets.ts`). `$deferrals` is a reserved entry; the modules are asked in 512 KB chunks with a 1 MB answer cap; an undeclared placeholder, slots without values and a verdict for a module not asked about are refused.
- *Files.* `clientFiles` replaces `buildAssets`: the bytes are manifest data, so both digests bind them (`releaseManifestDigest`, `externalArtifactDigest`). The review runs the browser rule set over each `.js` (`validateClientScript`, `plugin-sandbox/src/validate.ts`: a classic script, no `eval`, `Function`, `.constructor(…)` or string timers, no `import()`, `document.write`, markup sinks or workers, no URL of another site unless the grant names its origin) and the CSS rule over each `.css` (`cssLoadProblem`, `plugin-sandbox/src/client-assets.ts`: no `@import`, `expression()` or bindings, and every `url()` or URL string relative, `data:` or an origin the grant names). The CSS is read token by token as a browser reads it (`css-tokens.ts`, CSS Syntax 3: a comment inside a string hides nothing, an escape is decoded once), and every URL is resolved the way the browser resolves it, so `/\host` and `https:\\host` name the host they reach. It does not run the structure check's JS rules (`structure-js.ts`): they judge module markup ownership, which a plugin file has none of; the markup-sink rule covers "never builds content".
- *Data.* `buildDataOperation` / `hasBuildData`, the `$buildData` entry, answers `{ data, csp? }` (`collectBuildAssets`, `plugin-host/src/client-assets.ts`); core refuses anything but plain JSON, any `__proto__`, `constructor` or `prototype` key, and more than 64 KB, and embeds it as `<script type="application/json" data-caelo-plugin-data>` with `<` escaped (`dataBlockJson`).
- *Network.* `capabilityConstraints.client_assets.origins` (the grant, shown on the approval card as the capability's scope) are the plugin's CSP sources. `csp` in build data is accepted only from the site's consent provider (`CONSENT_PROVIDER_SLUG`, by slug until #676), whose tags are Owner approvals; from any other plugin it fails the build.
- *Consent.* A plugin with `consentPurposes` must require the consent provider; its scripts are parked (`type="text/plain"`, `data-caelo-consent`, `data-caelo-src`) and consent-manager's runtime starts each once every category is granted (`startConsentedScripts`).
- *Shipped users.* comments, site-assistant and site-search ship their runtimes unchanged as `clientFiles`; consent-manager ships one static runtime that reads its build data (`consent_build_data`), declares its two placeholders and now requests `client_assets`. Each derived manifest changes, so each of the four waits for the Owner's approval of the changed manifest after the upgrade (#1332).
- *Tests.* `client-assets.test.ts` (sandbox), `client-assets.test.ts` and `client-assets.integration.test.ts` (plugin-host), `module-deferrals.integration.test.ts`, `external-client-assets.integration.test.ts` (staging, approval, activation, preview, a file changed after approval) and the real-browser `apps/admin/e2e/plugin-client-assets.browser.ts` (the enforced CSP blocks a runtime-computed third-party fetch and allows the granted one; build data cannot leave its block; a consent-gated script loads only after consent). The existing visitor E2E `consent-visitor-cookie.browser.ts` passes with the converted consent runtime.
- *Not done:* the approval card shows the origins as the capability's raw scope JSON, not in plain words; a client file can still create a `<script>` element from its data at runtime, which the review cannot see: under `enforce` the CSP refuses it (no hash, no granted origin), under the default `report_only` it runs, as any injected script would.

### 6.8 `url_slots`

**Today.** Slots are claimed by pure, synchronous `encode`/`decode` functions (`index.ts:1941-1981`). Core calls them while composing `pages.current_path` inside write transactions (`compose-paths.ts:235-310`, `url-composition.ts:214-298`), after collecting annotations through `urlAnnotationsOperation`, also inside the transaction (`compose-paths.ts:243-244`). international-site's `decode` reads a process-global locale cache refreshed by a worker (`packages/plugins/international-site/src/index.ts:3084-3115`).

**What is impossible.** Plugin code on the URL path. A sandbox call cannot run inside a held transaction (`dispatch.ts:619-633`), and one spawn per composed page would make a slug change cost seconds.

**Mechanism (D)**, manifest data the host reads itself (Q7):
- `urlSlots.host` and `urlSlots.pathPrefix` declare where the data lives: a table of the plugin's private storage, its page column and its value column (the per-page annotation), and a second table mapping each value to a path segment or a host. The host reads both through `plugin_storage.*` within the composing transaction, on the writer's branch, so derived URLs follow the branch as they do now ([branch-aware-plugin-storage.md](../branch-aware-plugin-storage.md) §4).
- The host checks that the mapping is one-to-one (that is what makes `decode` possible), that segments are valid slugs and do not collide with reserved paths (`_caelo`, `api`), and that every host is a domain this install serves (the domain list). An off-site host would point canonicals and hreflang at someone else's domain.
- A write to a declared URL table is refused except from an `approved` invocation. A URL-shape change is §11.A-gated (CLAUDE.md §11.A, "pages: move_pages / … ≥ 10 URLs" and the international-site locale config). Activation shows the URL diff on the approval card.
- `slug-format` and `full-path` map unbounded input and cannot be a table. They stay unavailable to external plugins (`withdrawn` or `planned` with an issue; Q7).

**Tests.** Integration: a prefix table produces `/de/…` paths on the branch and 301s at Stage; decoding a prefixed path finds the page; a host outside the install's domains is refused; a chat write to the URL table is refused. Adversarial: a mapping with two values for one segment; a segment `_caelo`. **Size L.** Value is low: the slots are exclusive and international-site holds both. This is why it comes last.


**Implemented in Phase C2** (decision Q7 A). For every plugin, shipped or installed; no shipped plugin declares tables, international-site keeps its in-process code.
- **Data.** `urlTables` (plugin-sdk `url-tables.ts`): a `pages` table (`page_id` uuid plus a value column, one row per shaped page; a page without a row keeps the site's shape, so activation moves nothing) and a `values` table (the value, and its `segmentColumn` for `path-prefix`, `hostColumn` for `host`), both in `adminSchema`. The validator checks the tables, the column types, an index leading with `page_id` and with the value column, and that `urlContributions` claims exactly the slots the tables fill. A `pages` table names its page in `page_id`, so a chat's pending row makes the page a branch-URL candidate (#1411) like international-site's.
- **Status and refusal.** `url_slots` is `brokered` with `only: "slots host and path-prefix only, declared as urlTables"`; the requestable list a refusal and `submit_plugin` print carries it (`externallyRequestable`). Staging refuses `slug-format` and `full-path` (`externalUrlSlotRefusal`: why, what may be claimed, what to remove) and a claim without tables; `externalPluginDefinition` carries `urlTables` only, never code, and the loader refuses code contributions from a sandboxed plugin.
- **Reading** (`plugin-host/src/url-tables.ts`, `readDeclaredUrlAnnotations`). `collectUrlAnnotations` reads the declared plugins' tables itself, through the plugin's own storage handle on the render's branch, joined to the composing transaction (#1254): the values table whole (at most 500 rows), the pages rows by `page_id` in chunks of 500. It refuses, loudly, a segment that is not page-slug-shaped (which excludes `..`, `/`, `%`, `_`, control characters and capitals) or is reserved (`api`), a host that is not the site's base URL host or a public domain of the install, two values on one segment or host, a page with two rows, and a page naming a value with no row. The encoders are the host's (`declaredUrlContributions`); `decodePagePath` decodes a declared prefix when given the values (`readDeclaredUrlValues`).
- **Writes** (`checkUrlTableWrite`, in the storage handle). A write to either table is refused unless the invocation is `approved` (an approval-gated tool after the Owner's click; on the chat's branch when the approver cannot publish or the tool is `approvedOnChatBranch`). It is also refused when the new segment or host fails the checks above, when the segment is already the address of a page of the writer's view (a prefixed home would collide with it), when a page row names a missing value, and when it removes or renames a value a page still names. `updateMany` and `compareAndSwap` are refused on these tables, so every change is checked row by row.
- **Moving pages.** A table change never moves a stored path by itself: the approved `propose_url_migration` moves the affected pages with their 301s, a later write of one page recomposes it with its 301, and a Stage recomposes the pages a chat's merged rows move, with their 301s. For every plugin, `pages.refresh_current_path` refuses `redirectFromOld: "skip"` from a plugin for a published page: only the operator may let a public address 404.
- **Shipped plugins (Q2 A).** URL slots need the `url_slots` grant for every plugin (validator and `preflightRegistration`). international-site claimed `path-prefix` and `host` without it; it now requests it, so an install approves it once after the upgrade (Settings → Plugins).
- **Tests.** `plugin-host/src/url-tables.test.ts` (segments: `..`, `.`, `/`, `//`, `%2e%2e`, `%2F`, `%00`, NUL, newline, tab, bidi override, capitals, `_caelo`, `.well-known`, `api`; hosts: scheme, port, user, path, capitals, trailing dot, unserved; one value per address; the write gate for chat, owner-panel, worker, system, render and batch; staging of `slug-format` and `full-path`), the `url_slots` parity smoke, and `admin-core/src/__tests__/external-url-slots.integration.test.ts` (staging, approval, activation, refusals at the write, `/de/<slug>` and the market's host composed from the tables, the approved URL migration with its 301, a draft-bound approval visible on the chat's branch only, a plugin's `skip` refused, slot exclusivity).
---

## 7. Group C: brokered calls

### 7.1 `cms_admin`

**Today.** See §2.2. For external plugins the installation policy already requires an explicit operation allowlist (`installation-policy.ts:49-54`, `capabilityConstraints.cms_admin.operations`, `index.ts:1349-1362`), and the receipt stores it (`installations.ts:305-309`). Nothing reads it yet. Shipped plugins call at least 26 distinct operations through `ctx.cms`. The writes among them are international-site's `pages.update`, `pages.duplicate`, `pages.refresh_current_path`, `page_module_content.set` and `pages_seo.apply_translation`.

**Mechanism (C).** RPC method `cms.call`:

```ts
args: [op: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(120), input: z.unknown()]
```

**Host checks, in order** (in the handle, so they bind shipped plugins too; Q2, Q9):
1. The handle is attached only when the receipt for `cms_admin` exists.
2. `op` is in the receipt's `constraints.operations`.
3. The op is registered and admits actor kind `plugin` (`execute.ts:69`).
4. **Access by origin.** On `render`, only read operations. That needs a read/write marker on each operation that admits actor kind `plugin`, which does not exist (`ReadOperationDefinition` covers only some reads, `packages/query-api/src/operation.ts:101-124`, and CMS_REQUIREMENTS §14.13 lists "a render call's `ctx.cms.call` is not refused for core writes"). The PR adds `pluginAccess: "read" | "write"` to each op that admits `plugin`, and a test fails for an op that admits `plugin` without it.
5. `readScope: "site"` operations only from background origins (worker, journal rebuild, batch), never per render or per chat call (CLAUDE.md §2, the O(request) rule). No operation that admits `plugin` is site-scoped today (all 17 read operations shipped plugins call are `request`); the rule keeps it that way.
6. Executed as today: plugin actor, the invocation's branch and task, `renderSiteBaseUrl` and live URLs on a render (`capabilities.ts:801-830`), stats per op (`timedPluginOpCall`).
7. Result size: an answer over 1 MB is refused with "page through it (limit, afterId)" rather than truncated.

**Implemented (Phase B1).**
- `pluginAccess` is declared on every operation that admits `plugin`: 29 core reads, 10 core writes, and the plugin host's handle operations as `handle` (`packages/query-api/src/plugin-access.ts`; registry tests in admin-core and plugin-host).
- The checks live in `pluginCmsRefusal` (`capabilities.ts`), in this order: registered and open to plugins, not `handle`, in the receipt's operations (installed plugins: `ExternalApproval.cmsOperations`, read from the receipt), no write on a render, and a site-scoped read only from a worker, batch or rebuild. Every plugin is held to all but the allowlist, which a shipped plugin's grant does not carry. None of the 32 shipped-plugin and preview integration suites tripped the new rules.
- An installed plugin gets `ctx.cms` on a render (reads), in unattended calls, in journal work, and in chat and panel calls for a person who may author. A live build's refusal (#1495) is recorded by the host handle before the error crosses the wire.
- The sandbox's `cms.call` checks only the wire shape. An answer larger than one message (1 MB) is refused with "page through it" rather than ending the call: that is the wire's limit, which an in-process plugin does not have.
- **Added in Phase C2:** staging, approval and finalization refuse an allowlist naming an operation no plugin can call — not registered, not open to plugins, or backing a handle — with the names and the next step (`pluginOperationAllowlistRefusal`, `packages/query-api/src/plugin-access.ts`; the decision ops are bound to the registry the admin runs). The installations page shows a package staged before that check as not approvable.

**Approval card.** It shows the allowlist grouped by domain and by read or write, in plain words, which is the per-domain read and write grants of CMS_REQUIREMENTS §14.5.

**Risks.** Every write is a core op with its own validation, snapshot, lock and branch handling, so nothing new can be written. Exfiltration has no network to go through, only public tables (Q12). Database load is bounded by the allowlist, the origin rules and each op's own index-backed reads.

**What stays different.** External code never runs on the gateway, so the gateway half of `ctx.cms` (`capabilities.ts:225`) is not needed.

**Tests.** Unit: an op outside the allowlist; an op that does not admit `plugin`; a write op on a render; a site-scope op from a chat. Integration: a chat-origin `pages.update` lands on the chat's branch and is undone with the chat; an allowlist change in a new version is a new artifact and needs approval. Adversarial: an op name with a path or a capital letter; an input of 2 MB; a revoke between two calls. **Size M-L**, mostly the marker on about 60 operations.

### 7.2 `ai_provider`

**Today.** See §2.2. Calls are reserved against the site and per-person budgets, the chat session's budget and the plugin's own cap, all under one ledger lock ([ai-spend-ledger.md](./ai-spend-ledger.md)). A plugin's cap is none unless an Owner sets it (`packages/admin-core/src/ops/security/ai_calls.ts:430-470`). The manifest's `capabilityConstraints.ai_provider.maxDailyCostMicrocents` (`index.ts:1358`) is read by nothing.

**Mechanism (C).** RPC methods `ai.complete [opts]` and `ai.generateObject [opts]`, parsed with `pluginAiCompleteInput` and `pluginAiGenerateObjectInput` (`plugin-ai.ts:55-80`). `jsonSchema` is also held to `validateExternalToolSchema`, the safe subset tool schemas use (`installation-policy.ts:135-238`).

**Host checks.**
- A daily cap for the plugin is required (Q8): the receipt's `maxDailyCostMicrocents`, enforced by the ledger as the lower of it and `plugins.ai_cost_cap_microcents`.
- The person a call acts for is charged as today (`plugin-ai.ts:125-130`); background origins spend as the system actor under the site budgets and the plugin cap.
- `aiDelegated` (#741) refuses the call, as today (`plugin-ai.ts:112`).
- The sandbox time budget of an invocation holding `ai_provider` becomes the long one (240 s, like images, `external-plugin.ts:71`).

**Risks.** Spend is closed by the reservation before dispatch and the required cap; a leak of the key is impossible because no key or model choice ever reaches the plugin; prompt injection through site content is the plugin's problem, and its output is untrusted to the host anyway.

**Tests.** Integration with the fake provider: a call is reserved and settled; the cap refuses the next call with the Owner's next step; a delegated call returns `AiDelegated:`. Adversarial: `maxTokens` above the bound; a `jsonSchema` with `$ref` or `pattern`; 20 parallel calls cannot overshoot the cap. **Size M.**

**Implemented (Phase B2).**
- **The cap.** `validateInstallationPolicy` refuses an installed plugin that requests `ai_provider` without `capabilityConstraints.ai_provider.maxDailyCostMicrocents`, and a `maxDailyCostMicrocents` on any other capability. `approve_installation` copies it into the receipt as before. The ledger (`readPluginAiCap`, `bindingPluginCap`, `ai-ledger.ts`) reads the `ai_provider` receipt of the active installation version, never the manifest, and holds the plugin to the lower of it and the Owner's cap; a refusal says which one bound and what to do (a higher cap needs a new version). A runtime-installed plugin's text call without such a receipt is refused outright (`plugin-grant-cap`), so a revoked grant or a receipt without a cap cannot spend through the ledger either. `capsApply` counts the grant, so an unpriced model never runs for an installed plugin. Images keep the Owner's cap and are bounded by the receipt's cap too when it exists. Owner side: the approval card shows "at most $X in any 24 hours"; `ai_calls.aggregate_per_plugin` and `get_plugin` report the binding cap with both sources ([ai-spend-ledger.md](./ai-spend-ledger.md)).
- **The broker.** `ai.complete` and `ai.generateObject` join `sandboxMethod`; the broker parses one options object and hands it to `makePluginAi`, which Zod-parses it strictly (a `model`, a `pluginId` or a second argument is refused) and reserves before dispatch. The spender is built by the host from the loaded plugin and the invocation; nothing the plugin sends names a plugin, a person or a model. The handle is attached on every admin-side origin from the receipt (`withExternalCallHandles`, `capabilities.ts`); the 240 s interactive budget comes from Phase A.
- **Rules for every plugin (Q2 A).** `makePluginAi` refuses a `render` and a `visitor` call: a render runs on every preview and build of every page. No shipped plugin calls the AI there (comments, forms, newsletter and international-site call it from tools, site-search from a worker), so none changed. A `generateObject` schema is bounded to 32 levels and 256 KB before the reservation. **Deviation from the line above:** it is not held to `validateExternalToolSchema`. That subset exists because the host compiles tool schemas; it never compiles this one (the AI SDK's `jsonSchema()` passes it to the provider, which constrains and checks the answer), and international-site's translation schemas use `anyOf` for nullable fields, which the subset refuses. The bound covers what the host does do with it: count it into the prompt bound and let a provider adapter walk it.
- **Not covered:** a batch job's remote context (`plugin-batches/job.ts`) carries no `ctx.ai` for any plugin; parity holds, the gap is the same for shipped plugins.
- **Tests.** `capabilities-brokered-calls.test.ts` (handles from receipts, render and visitor refused, the schema bound, unknown options), `sandbox-ai-email.test.ts` (through Deno: options reach the handle unchanged, extra arguments refused), `external-capability-parity.test.ts` (smoke), `installation-policy.test.ts` (the required cap), and `external-plugin-ai-email.integration.test.ts`: reserve and settle under the plugin's own id for the person it acts for (system actor for a worker), another plugin's spend untouched, a call past the approved cap refused before the provider, the Owner's lower cap binding, 20 parallel reservations admitting exactly what fits, a render refused, no spend without a receipt carrying a cap, and none after a revoke.

### 7.3 `email`

**Today.** See §2.2. `queue` writes a template, recipient and token to the outbox, and the drain applies per-recipient and site-wide caps ([mail-outbox.md](./mail-outbox.md)). `send` delivers any HTML to any address through the transport with no cap (`mail-queue.ts:145-163`). The declared visitor blocks (double opt-in) need `ctx.email` on the gateway (`packages/plugin-host/src/public-blocks/mail-blocks.ts:80-110`). The external approval path does not check `requires: ["email"]`: `unmetHostRequirement` (`registry.ts:992`) is called only at `registry.ts:636`, `registry.ts:815` and `release_approval.ts:222`.

**Mechanism (C)** on the admin side. On the gateway it is core code, not a broker.

**RPC surface** (Q5):
- `email.queue [{ template, to, token? }]`, validated by the handle (`mail-queue.ts:188-219`). A template is reviewed manifest data: plain-text paragraphs and one link.
- `email.unsubscribeLink [{ recipientId: uuid }]`.
- `email.send`: not offered in the first PR (Q5 A).

**Gateway half.** For an external plugin holding the receipt, the public host attaches the queue-only handle (`makePluginEmail(..., publicSide: true)`, `capabilities.ts:229`) for the declared blocks. It does this today only for shipped plugins (`capabilities.ts:179-211` returns before).

**Activation.** `approve_installation` and `finalize_installation` run `unmetHostRequirement`, so an external plugin that needs mail cannot go live without a transport.

**Risks.** A spam or phishing relay on the site's sending domain is closed by templates only and the outbox caps. Header injection is closed because templates are plain text and the host builds every header. Enumeration of addresses is closed because nothing about delivery comes back (`mail-queue.ts:15-16`).

**Tests.** Integration: a worker queues a template and the drain delivers it within the caps; a visitor subscribe through the double opt-in block of an external plugin queues the confirmation. Adversarial: an undeclared template; a recipient with CR/LF; 1 000 queued mails to one address (the per-recipient cap); `send` absent from `ctx`. **Size M.**

**Implemented (Phase B2).**
- **The broker.** `email.queue` and `email.unsubscribeLink` join `sandboxMethod` and the child's `ctx.email`; there is no `email.send` on the wire, and the host handle of an installed plugin refuses one too. The broker parses one strict object per call; the handle checks the template is the plugin's own, the address and the token. `mailTemplates` and `mailUnsubscribe` reach the definition (`externalDeclarations`), which is where the outbox drain and the link signer read them. The handle is attached on every admin-side origin from the receipt.
- **Gateway half.** For an installed plugin holding the receipt, the public host attaches the queue-only handle for its declared mail blocks; no plugin code runs there.
- **Activation.** `approve_installation` (before any receipt is written) and `finalize_installation` run `unmetHostRequirement`, so an installed plugin that `requires: ["email"]` (or `visitor-ai`) is not approved without a transport that delivers.
- **Who may mail, for every plugin (Q2 A).** `queue` and `send` throw on a render, a page-output observer, a batch job and a chat call: a mail reaches a person before Publish live and cannot be taken back. A render also never mints an unsubscribe link. Workers, system calls, the Owner panel, approved tool calls and visitor requests mail as before. No shipped plugin changed: the newsletter sends from its worker, and every `queue` is a declared block on the gateway ([mail-outbox.md](./mail-outbox.md)).
- **Approval card.** The Owner reads every template the package can send (subject, paragraphs, button), next to the requested access.
- **Follow-up:** a capped `send` for every plugin (option B of Q5) is #1735.
- **Tests.** `capabilities-brokered-calls.test.ts` (no send for an installed plugin on either side, the origin rule for both provenances, a foreign template, a CR/LF recipient, no link from a render), `sandbox-ai-email.test.ts` (no `send` in the child, a forged `email.send` line refused by the wire and the broker, a sender or another plugin's name refused), the parity smoke, `external-plugin-ai-email.integration.test.ts` (not approved without a transport, a worker's template delivered by the drain, 30 mails to one address capped at the per-recipient limit, another plugin's template and a chat call refused, a link token that does not verify for another plugin, the double opt-in queueing the plugin's template) and `apps/api-gateway/src/external-plugin-mail.integration.test.ts` (a visitor's sign-up through the gateway, with its real identity, queues the installed plugin's confirmation).

### 7.4 `snapshots`

**Today.** No shipped plugin uses it. `ctx.snapshots.emit` writes a snapshot row of any entity kind, id and payload (`capabilities.ts:848-877`), always on main (no branch is passed). The snapshot kinds include pages, modules, templates and content instances (`packages/admin-core/src/snapshots/emit.ts:44-74`), and a revert restores a snapshot's payload into core data.

**What is impossible.** A safe general broker. A plugin that may emit a snapshot of `page/<id>` with a payload it chose could plant a state that `revert_page` or `revert_site` later writes into core data, past every validator. It would also put a chat's change on main.

**Design (implemented in Phase A).** The capability is withdrawn (Q6): every write a plugin makes is already snapshotted by the operation that makes it (`plugin_storage.*` writes `plugin_row_snapshots`; core ops snapshot themselves). `snapshots` is removed from `pluginCapability`, `PLUGIN_CAPABILITY_INFO`, `PluginContextTier1.snapshots` and `PluginHostInfra.emitSnapshot`. Pre-1.0 the repo deletes rather than migrates (CLAUDE.md §2, no fallbacks). The parity test then has nothing to check for it. **Size S.**

---

## 8. Order

| PR | What | Depends on | Decisions | Size | Why at this place |
|---|---|---|---|---|---|
| 0 | Status record, refusal at submission, parity test (§4.1, §4.2) | | | S | The issue's first two acceptance criteria. It stops approvals of artifacts that cannot load. |
| 1 | Registration seam, runtime pools, budgets, bundle cache (§4.3, §4.4), `background_workers` | 0 | Q1, Q10 | M | 7 shipped users; the issue's third criterion. The seam makes every later PR smaller. |
| 2 | Withdraw `snapshots` | 0 | Q6 | S | No user; it removes a hole. |
| 3 | `list_types` | 1 | | S | Pure data. |
| 4 | `cms_admin` with the read/write marker | 1 | Q2, Q9 | M-L | 6 shipped users. Needed by `change_journal` (core kinds) and by most real plugins. It also closes a §14.13 item for every plugin. |
| 5 | `ai_provider` | 1 | Q8 | M | 5 shipped users. |
| 6 | `email` (queue, unsubscribe link, gateway half, activation check) | 1 | Q5 | M | 3 shipped users. |
| 7 | `change_journal` | 1 (own tables), 4 (core kinds) | Q11, Q12 | M | 2 shipped users. |
| 8 | Render-point runtime (chunking, render budget, reserved entries, §4.5) and `list_sources` | 1 | Q2, Q3 | M | The base for PRs 9 to 14. |
| 9 | `head_contributions` and share images | 8 | Q2 | S-M | |
| 10 | `link_resolve` | 8 | | S-M | |
| 11 | `list_resolve` | 8, 10 | | M | |
| 12 | `content_variants` | 8, 10 | Q2 | M | |
| 13 | `client_assets`: deferrals, then build assets | 8 | Q4 | M + L | The widest blast radius, so it comes after the value checks are proven on simpler points. |
| 14 | `url_slots` (host and path prefix as data) | 4, 8 | Q7 | L | Low value outside international-site. |

**Sizes:** S is about a day and one or two packages. M is several days across the SDK, the plugin host and admin-core, possibly with a migration. L is a week or more, with a new protocol or data model, or changes to shipped plugins.

Each PR also opens the capability's own issue (replacing #1729 in the status record), updates the CMS_REQUIREMENTS §14.13 bullet "Runtime-installed plugins can be granted only …", updates this document's status line, and, where operators see a change (the approval card, Settings → Plugins), fills in `## User docs affected` (CLAUDE.md §10).

---

## 9. Open questions

Each question lists options and a recommendation. The PR that needs a decision is listed in §8.

**Q1. What may an external plugin do in a call that acts for nobody** (worker, journal batch, rebuild, observer, batch)? Today it gets no private storage, files or media there (§2.3); a shipped plugin gets everything it requested.
- **Decided: A**, with an `$onActivate` entry (implemented in Phase A).
- A: Private storage (and the other author handles it was granted) on main, as the plugin actor, through `plugin_storage.*`, audited and snapshotted. This is the shipped behaviour and the branch-storage decision "worker writes go to main". A journal batch on a branch writes on that branch.
- B: The same, but acting for the Owner who approved the artifact, re-checking that person's `content.write` on each run. If they lose it, the plugin's background work stops loudly.
- C: No private storage outside human calls (status quo). Workers touch only public tables, collections and config.
- **Recommendation: A.** The Owner's grant of `background_workers` or `change_journal` is the decision that the plugin works unattended. C makes workers nearly useless (newsletter-style sending needs private storage), and B ties a plugin's operation to one person's account. The same PR should add an `$onActivate` entry, so an external plugin can seed its defaults the way shipped plugins do in `onActivate` (`loader.ts:1524-1550`).

**Q2. Do the rules this design adds for external plugins bind shipped plugins in the same PR?** These are the head-entry vocabulary, the value checks (§4.5), read-only `ctx.cms` on render, and the email caps.
- **Decided: A.** The new rules bind shipped plugins in the same PR; shipped plugins they break are fixed there.
- A: Yes. The check lives in the shared handle (principle 1), and each PR fixes the shipped plugins it trips.
- B: External plugins only. The parity test records each difference with an issue.
- **Recommendation: A.** B lets a shipped plugin do what an external one cannot, which is the gap this issue is about, and some of the holes (visitor text in a list source, raw values in chrome) exist for shipped plugins too. Where a shipped plugin would break (international-site's richtext translations under §4.5), the PR says so and the fix lands in the same PR.

**Q3. How does a composition point name its operation for an external plugin?**
- **Decided: A**, reserved entry names; no shipped manifest changes.
- A: Reserved entry names (`$contributions`, `$listSources`, `$linkResolve`, …) that the sandbox child resolves from the plugin's own definition, like `$staticRender`. The manifest keeps its `has…` booleans, and `$inspect` checks each one.
- B: New manifest string fields naming the operation. The shipped manifests change too, so international-site, comments and the others wait for the Owner's approval of a changed manifest after the upgrade (#1332).
- **Recommendation: A.** The name adds nothing to what the Owner reviews, and A changes no shipped manifest. Data the host itself needs (`linkResolveReads`, URL tables, placeholders, client files) becomes manifest fields under either option.

**Q4. What does `client_assets` mean for an external plugin?**
- **Decided: B**, and the shipped users move to this model.
- A: Not offered (`withdrawn`, or `planned` with an issue).
- B: Static files inside the reviewed artifact plus a JSON data object per build, own-origin network only, third-party origins by approval, consent-gated start (§6.7).
- C: Parity with shipped plugins: any JS and CSS generated at build time.
- **Recommendation: B**, and move the four shipped users to B afterwards (one plugin model). C lets data become code on every visitor's page. A blocks the common plugin that needs a small client script.

**Q5. Does an external plugin get `email.send` (any HTML to any address)?**
- **Decided: A.** A capped `send` for every plugin follows as its own issue.
- A: No. Only `queue` (templates) and `unsubscribeLink`.
- B: Yes, through a send ledger (per recipient, site-wide, and a per-plugin daily cap from the receipt), only from worker and approved origins, and with the HTML held to the mail rules.
- C: Only for content and a recipient list bound to an approval (an approved campaign digest).
- **Recommendation: A in PR 6. Then B as its own issue, applied to every plugin**, because shipped `send` is uncapped today (`mail-queue.ts:145-163`). A newsletter-style external plugin needs B or C.

**Q6. What happens to `snapshots`?**
- **Decided: A** (implemented in Phase A).
- A: Remove the capability (§7.4).
- B: Keep it for shipped plugins only, marked `withdrawn` for external plugins, with an issue.
- C: Broker it, restricted to the plugin's own row kind.
- **Recommendation: A.** Nobody uses it, C duplicates what `plugin_storage.*` already does, and B is the kind of difference the issue exists to remove.

**Q7. How far does `url_slots` go for external plugins?**
- **Decided: A.**
- A: `host` and `path-prefix` as declared tables the host reads (§6.8); `slug-format` and `full-path` not offered.
- B: Not offered at all until someone needs it (`planned` with an issue).
- C: Full parity through sandboxed `encode` calls, batched before every composing transaction.
- **Recommendation: A, scheduled last.** B is acceptable if the maintainer prefers to wait for a real need. C means restructuring every URL-composing write around a sandbox call.

**Q8. AI spend cap for external plugins.**
- **Decided: A**, shown on the approval card.
- A: The receipt's `maxDailyCostMicrocents` is required for an external plugin requesting `ai_provider`, is shown on the approval card and is enforced as the lower of it and the Owner's `ai_cost_cap`.
- B: The Owner must set `plugins.ai_cost_cap` before activation.
- C: No plugin cap; the site and per-person budgets only (the shipped default).
- **Recommendation: A.** The cap is part of the artifact the Owner approves, and the Owner can still lower it.

**Q9. How fine is the `cms_admin` grant?**
- **Decided: A.**
- A: The named-operation allowlist the installation policy already requires, shown grouped by domain and by read or write, plus the new `pluginAccess` marker so that a render is read-only for every plugin.
- B: Per-domain read and write grants as written in CMS_REQUIREMENTS §14.5, with no operation list.
- **Recommendation: A.** It is stricter than B, already enforced at staging and already stored in the receipt. B can be derived from it for display.

**Q10. Time budgets and sandbox pools.** Proposed values:
- **Decided:** the table below, revisited with scale-gate numbers (implemented in Phase A).

| Kind | Budget per invocation | Pool |
|---|---|---|
| Chat, panel, approved tool call | 30 s; 240 s with `ai_provider` or `image_generation` | interactive |
| Editor preview, per composition point and chunk | 5 s | interactive |
| Build, per composition point and chunk | 60 s | interactive |
| Worker run | 240 s (inside the 5-minute lease) | background |
| Journal batch | 60 s | background |
| Rebuild chunk | 120 s | background |

Interactive pool: 4 children, waiting at most 2 s for a slot. Background pool: 2 children, waiting at most 30 s. **Recommendation:** adopt these values and revisit them with numbers from the scale gate ([scale-gate.md](./scale-gate.md)) after PR 8.

**Q11. How does a change-consumer rebuild fit the sandbox?**
- **Decided: A.**
- A: Resumable chunks, `rebuild({ cursor? }) → { done?, cursor? }`, for every plugin. Today's answers count as done.
- B: An external rebuild runs as a batch in a job container (#1646), which requires the `batch_jobs` grant as well.
- **Recommendation: A.** It needs no second grant, and it also helps shipped rebuilds on large sites.

**Q12. May journal-driven calls write public tables?** A main-line batch sees staged content; copying it into a `published` table shows it to visitors before Publish live.
- **Decided: A.**
- A: Refuse public-table writes from journal batches and rebuilds, for every plugin, as observers and batches already are (`capabilities.ts:407-415`).
- B: Also refuse them from workers of plugins holding `cms_admin`.
- C: Leave it to the grant.
- **Recommendation: A.** No shipped consumer writes public tables. B would break legitimate derived rows (aggregates) for plugins that also read core data. The remaining path (a worker that reads staged core data through `ctx.cms` and publishes it) is stated on the approval card of a plugin holding both `background_workers` and `cms_admin`.

---

## 10. Related gaps found while writing this

These are not capabilities. The maintainer included them in #1729 where confirmed:

- `externalPluginDefinition` dropped `listExt`, `visitorProjection`, `consentProvider` and `component` from the manifest. **Phase A:** `listExt`, `visitorProjection` (provisioned with its republish triggers, read-only on the gateway for declared public operations) and `component` now reach the definition (`externalDeclarations`). `consentProvider` was checked and is not a gap: the consent provider is consent-manager by slug (`VISITOR_CONSENT_PROVIDER_SLUG`, `packages/plugin-host/src/visitor-consent.ts`), which no installed plugin can replace.
- `loadTier2Row` did not seed a declared `config`. **Confirmed and fixed in Phase A** by the registration seam; `external-plugin-seam.integration.test.ts` reads the seeded value.
- External plugins had no `onActivate`. **Added in Phase A** (`hasOnActivate`, `$onActivate`, Q1).
- `metaSignature` / `metaSignatureBatch` are not available to external plugins, so their baked output misses the data-change cache bust (`index.ts:2680-2690`). **Checked in Phase B3b: not a gap of its own.** An installed plugin has no baked output for a signature to bust: the bake pass asks only release-signed plugins (`staticRenderPlugins` filters `tier === 1`, `plugin-host/src/build-services.ts`), so an installed plugin's `staticRender` never reaches a published page, silently, although the host carries it. Baking it needs a batched entry (the pass calls `staticRender` once per page, a sandbox spawn per page) and a rule for the HTML it may put on a public page (CLAUDE.md §2 "No raw HTML on pages", close to §6.7); the signature then rides that entry as `$metaSignatureBatch`. Tracked in #1737. A data signature built now would have no caller. **Interim refusal (maintainer, 2026-11-26, on #1737), implemented:** until the batched entry and the HTML rule exist, no runtime-installed plugin may declare `hasStaticRender`. The rule is a second record next to the capability status, `EXTERNAL_UNAVAILABLE_DECLARATIONS` (`plugin-sdk/src/external-capabilities.ts`: declarations that need no grant but that nothing would run for an installed plugin), read by the same refusal path: `validateInstallationPolicy` (staging, approval, finalization), the submission check of `plugins.submit` / `plugins.revalidate` (`validate.ts`), the installations page and `submit_plugin`'s text (`externallyUnavailableDeclarations`), and every load (`externalPluginDefinition`). An installed plugin an older release approved with one stops at its next load with `ExternalDeclarationUnavailableError`: recorded as a plugin error of phase `verify`, class `plugin` (the artifact's state, not a Caelo defect, so no bug-intake report), its status left as the Owner set it (#1008), the reason in Settings → Plugins and `get_plugin`, the message naming the fix (drop the static render, render from the plugin's Web Component, submit the corrected version). The external definition no longer carries a `staticRender`; the sandbox child still answers `$staticRender` for the follow-up. Shipped plugins bake as before. Tests: the parity test (refused at review and submission, a tier-1 manifest unaffected), `external-static-render-refusal.integration.test.ts` (staging refused; an active installed plugin stops loudly at its next load with the recorded error).

---

## 11. References

- CLAUDE.md §2 (plugin invariants), §11 and §11.A (gated operations), §11.B Tier 5 (the tick, no background timers), §12 (AI SDK shapes; `generateObject`).
- CMS_REQUIREMENTS §14.2-§14.7 (one plugin model, execution, grants, data zones, writes never straight to live), §14.13 (status), §17.3-§17.4 (AI cost controls and restrictions).
- [branch-aware-plugin-storage.md](../branch-aware-plugin-storage.md), [plugin-public-surface.md](../plugin-public-surface.md), [plugin-batches.md](../plugin-batches.md), [lists.md](../lists.md), [internal-links.md](../internal-links.md).
- [scheduler-tick.md](./scheduler-tick.md), [state-and-changes.md](./state-and-changes.md), [ai-spend-ledger.md](./ai-spend-ledger.md), [mail-outbox.md](./mail-outbox.md), [public-admin-boundary.md](./public-admin-boundary.md), [site-security-headers.md](./site-security-headers.md).
