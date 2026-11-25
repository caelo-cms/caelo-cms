<!-- SPDX-License-Identifier: MPL-2.0 -->

# Brokering every capability to runtime-installed plugins: design

**Status:** proposal for review (issue #1729). Nothing here is implemented yet. Once it is approved, each section ships as its own PR in the order of §8, and each PR updates this document and the CMS_REQUIREMENTS §14.13 list.

CLAUDE.md §2 says "A shipped plugin may do nothing a runtime-installed plugin with the same grants could not" (also CMS_REQUIREMENTS §14.2). Today a runtime-installed (external) plugin can be granted 12 of the 26 capabilities in `pluginCapability` (`packages/plugin-sdk/src/index.ts:174-201`). This document designs a broker for each of the other 14, groups them by mechanism, proposes an order, and lists the decisions the maintainer has to make (§9).

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
| `snapshots` | none | `ctx.snapshots.emit` (`index.ts:2176-2184`) | `makePluginSnapshots` calls the snapshot emitter with any entity kind, id and payload, on main (`capabilities.ts:848-877`) | Attached when requested (`capabilities.ts:241-243`) |
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

An external plugin gets private storage, private files, images, fonts and site media only for an authoring origin (`chat`, `owner-panel`, `approved`) and only when the human it acts for holds `content.write` (`capabilities.ts:179-211`, `:282-292`). A worker (`worker`), a change-consumer batch (`system`, or `chat` without a human), an observer and a batch get none of them. A shipped plugin's worker gets every handle it requested (`capabilities.ts:213-279`). Q1 decides this.

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

A new `packages/plugin-sdk/src/external-capabilities.ts`, typed as a `Record` over the enum, so a new capability does not compile without an entry (the pattern of `PLUGIN_CAPABILITY_INFO`, `packages/plugin-sdk/src/capability-info.ts:17`):

```ts
export type ExternalCapabilityStatus =
  | { readonly status: "brokered" }
  | { readonly status: "planned"; readonly issue: number }
  | { readonly status: "withdrawn"; readonly reason: string };

export const EXTERNAL_CAPABILITY_STATUS: Readonly<Record<PluginCapability, ExternalCapabilityStatus>> = { … };
```

- The 12 brokered capabilities start as `brokered`; the 14 as `planned` with issue 1729 until each gets its own issue.
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

`registerLoadedPlugin` and `loadTier2Row` share one function, `registerPluginSurfaces(lp, def, infra)`, extracted from `loader.ts:1484-1622`: URL slots, config seed, `onActivate`, list types, tools, list sources, prompt context, workers and skills. Each surface registers only when the definition carries it; the capability gates in `loader.ts:1096-1231` stay in front of it. Each broker PR then adds the manifest-to-definition mapping in `externalPluginDefinition` and the broker, and gets the registration for free. The external path's own steps (approval, `$inspect`, schema provisioning) stay where they are. Size **M**; it ships inside the `background_workers` PR, which needs it first.

### 4.4 Sandbox runtime changes

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

All composition points that return values go through one host function, `checkPluginValue(field, value)`. Today the template engine does no escaping (`template-engine.ts:117-121`):

- `text`, `select`, `icon`: HTML-escaped by the host before rendering. A plugin value is data, never markup.
- `link`: `linkValueSchema` (`fields.ts:225-230`), plus a refusal of any scheme but `https:`, `http:`, `mailto:`, `tel:` and of protocol-relative `//host`.
- `richtext`: CLAUDE.md §1A says richtext is prose. The value is parsed with `htmlparser2` (already a dependency of `plugin-host`) and refused if it contains an element outside an inline and block prose allowlist (`p`, `a`, `strong`, `em`, `ul`, `ol`, `li`, `h2`-`h6`, `blockquote`, `code`, `br`, `span`), any `on*` attribute, `style`, or a URL attribute that fails the `link` rule. It is refused, not cleaned: a cleaned value would be a silent fallback (CLAUDE.md §2), and the refusal names the element and the field.
- `media`: `caelo:media/<id>`, and the asset must exist and be `library` (not `reference`) on the render's branch.

Q2 decides whether this binds shipped plugins in the same PR.

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

### 6.3 `list_sources`

**Today.** See §2.2. Entries are validated against the node's fields, ids are stable and unique, and an answer for a page that was not asked about is refused (`list-source-resolution.ts:16-25`).

**Mechanism (B)**, entry `$listSources`; the names come from the manifest's `listSources`, which `externalPluginDefinition` carries.

**Added for external plugins.** Value checks per field (§4.5), a 1 MB chunked answer within the existing 4 MB total, names claimed site-wide as today (a name a shipped plugin holds cannot be taken).

**Risk closed.** Stored XSS. A list source fed from an inbox table (visitor text) would put visitor HTML on every page whose module iterates it, because nothing escapes it today (§2.2).

**Tests.** Adversarial: an entry label `<img src=x onerror=…>` renders escaped; a `richtext` entry with `<script>` is refused with the field named; an answer of 5 MB is refused before it is walked; an entry for a page not asked about. **Size M**, including the shared render-point runtime (chunking, render budget, reserved entries, `checkPluginValue`), which ships in this PR because it is the first point to need it.

### 6.4 `link_resolve`

**Today.** The answer is a page partition (`variant` token, `group`), and core maps every `caelo:page/<id>` reference (`link-resolve.ts:1-45`). It is asked about every page in the render's scope. With `linkResolveReads` declared, core keeps the answer per scope and asks only about deltas (#1269).

**Mechanism (B)**, entry `$linkResolve`.

**Added for external plugins.** `linkResolveReads` becomes manifest data and is **required** for an external contributor. Without it, every preview would ask a sandbox about every page of the site, which breaks O(request) (CLAUDE.md §2) and costs a sandbox spawn per 1 MB chunk. The page ids are chunked.

**Risks.** Misdirected links stay inside the site, and a target with no member in the variant fails loudly (by design). The low injection risk comes from the token regex (`index.ts:747-757`).

**Tests.** Integration: links on a page of variant `de` resolve to the `de` member; a second preview asks no question after an unrelated write; a write to a declared table asks again only about the pages it names. Adversarial: an answer for a page not asked about; two plugins claiming one page. **Size S-M.**

### 6.5 `list_resolve`

**Today.** See §2.2: overlays replace values and hide entries, never add, remove or reorder (`list-resolve.ts:1-36`).

**Mechanism (B)**, entry `$listResolve`. The arguments' `scope` lists (up to 50 000 ids each, `index.ts:569-582`) and the answer are chunked. Values go through §4.5 against the field their address names.

**Depends on** `link_resolve` (the variants come from its partition). **Tests** as for list sources, plus an overlay that tries to add an entry or set a structural `module` value (refused and reported to the plugin's error channel, as today). **Size M.**

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

### 6.8 `url_slots`

**Today.** Slots are claimed by pure, synchronous `encode`/`decode` functions (`index.ts:1941-1981`). Core calls them while composing `pages.current_path` inside write transactions (`compose-paths.ts:235-310`, `url-composition.ts:214-298`), after collecting annotations through `urlAnnotationsOperation`, also inside the transaction (`compose-paths.ts:243-244`). international-site's `decode` reads a process-global locale cache refreshed by a worker (`packages/plugins/international-site/src/index.ts:3084-3115`).

**What is impossible.** Plugin code on the URL path. A sandbox call cannot run inside a held transaction (`dispatch.ts:619-633`), and one spawn per composed page would make a slug change cost seconds.

**Mechanism (D)**, manifest data the host reads itself (Q7):
- `urlSlots.host` and `urlSlots.pathPrefix` declare where the data lives: a table of the plugin's private storage, its page column and its value column (the per-page annotation), and a second table mapping each value to a path segment or a host. The host reads both through `plugin_storage.*` within the composing transaction, on the writer's branch, so derived URLs follow the branch as they do now ([branch-aware-plugin-storage.md](../branch-aware-plugin-storage.md) §4).
- The host checks that the mapping is one-to-one (that is what makes `decode` possible), that segments are valid slugs and do not collide with reserved paths (`_caelo`, `api`), and that every host is a domain this install serves (the domain list). An off-site host would point canonicals and hreflang at someone else's domain.
- A write to a declared URL table is refused except from an `approved` invocation. A URL-shape change is §11.A-gated (CLAUDE.md §11.A, "pages: move_pages / … ≥ 10 URLs" and the international-site locale config). Activation shows the URL diff on the approval card.
- `slug-format` and `full-path` map unbounded input and cannot be a table. They stay unavailable to external plugins (`withdrawn` or `planned` with an issue; Q7).

**Tests.** Integration: a prefix table produces `/de/…` paths on the branch and 301s at Stage; decoding a prefixed path finds the page; a host outside the install's domains is refused; a chat write to the URL table is refused. Adversarial: a mapping with two values for one segment; a segment `_caelo`. **Size L.** Value is low: the slots are exclusive and international-site holds both. This is why it comes last.

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

### 7.4 `snapshots`

**Today.** No shipped plugin uses it. `ctx.snapshots.emit` writes a snapshot row of any entity kind, id and payload (`capabilities.ts:848-877`), always on main (no branch is passed). The snapshot kinds include pages, modules, templates and content instances (`packages/admin-core/src/snapshots/emit.ts:44-74`), and a revert restores a snapshot's payload into core data.

**What is impossible.** A safe general broker. A plugin that may emit a snapshot of `page/<id>` with a payload it chose could plant a state that `revert_page` or `revert_site` later writes into core data, past every validator. It would also put a chat's change on main.

**Design.** The capability is withdrawn (Q6): every write a plugin makes is already snapshotted by the operation that makes it (`plugin_storage.*` writes `plugin_row_snapshots`; core ops snapshot themselves). `snapshots` is removed from `pluginCapability`, `PLUGIN_CAPABILITY_INFO`, `PluginContextTier1.snapshots` and `PluginHostInfra.emitSnapshot`. Pre-1.0 the repo deletes rather than migrates (CLAUDE.md §2, no fallbacks). The parity test then has nothing to check for it. **Size S.**

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
- A: Private storage (and the other author handles it was granted) on main, as the plugin actor, through `plugin_storage.*`, audited and snapshotted. This is the shipped behaviour and the branch-storage decision "worker writes go to main". A journal batch on a branch writes on that branch.
- B: The same, but acting for the Owner who approved the artifact, re-checking that person's `content.write` on each run. If they lose it, the plugin's background work stops loudly.
- C: No private storage outside human calls (status quo). Workers touch only public tables, collections and config.
- **Recommendation: A.** The Owner's grant of `background_workers` or `change_journal` is the decision that the plugin works unattended. C makes workers nearly useless (newsletter-style sending needs private storage), and B ties a plugin's operation to one person's account. The same PR should add an `$onActivate` entry, so an external plugin can seed its defaults the way shipped plugins do in `onActivate` (`loader.ts:1524-1550`).

**Q2. Do the rules this design adds for external plugins bind shipped plugins in the same PR?** These are the head-entry vocabulary, the value checks (§4.5), read-only `ctx.cms` on render, and the email caps.
- A: Yes. The check lives in the shared handle (principle 1), and each PR fixes the shipped plugins it trips.
- B: External plugins only. The parity test records each difference with an issue.
- **Recommendation: A.** B lets a shipped plugin do what an external one cannot, which is the gap this issue is about, and some of the holes (visitor text in a list source, raw values in chrome) exist for shipped plugins too. Where a shipped plugin would break (international-site's richtext translations under §4.5), the PR says so and the fix lands in the same PR.

**Q3. How does a composition point name its operation for an external plugin?**
- A: Reserved entry names (`$contributions`, `$listSources`, `$linkResolve`, …) that the sandbox child resolves from the plugin's own definition, like `$staticRender`. The manifest keeps its `has…` booleans, and `$inspect` checks each one.
- B: New manifest string fields naming the operation. The shipped manifests change too, so international-site, comments and the others wait for the Owner's approval of a changed manifest after the upgrade (#1332).
- **Recommendation: A.** The name adds nothing to what the Owner reviews, and A changes no shipped manifest. Data the host itself needs (`linkResolveReads`, URL tables, placeholders, client files) becomes manifest fields under either option.

**Q4. What does `client_assets` mean for an external plugin?**
- A: Not offered (`withdrawn`, or `planned` with an issue).
- B: Static files inside the reviewed artifact plus a JSON data object per build, own-origin network only, third-party origins by approval, consent-gated start (§6.7).
- C: Parity with shipped plugins: any JS and CSS generated at build time.
- **Recommendation: B**, and move the four shipped users to B afterwards (one plugin model). C lets data become code on every visitor's page. A blocks the common plugin that needs a small client script.

**Q5. Does an external plugin get `email.send` (any HTML to any address)?**
- A: No. Only `queue` (templates) and `unsubscribeLink`.
- B: Yes, through a send ledger (per recipient, site-wide, and a per-plugin daily cap from the receipt), only from worker and approved origins, and with the HTML held to the mail rules.
- C: Only for content and a recipient list bound to an approval (an approved campaign digest).
- **Recommendation: A in PR 6. Then B as its own issue, applied to every plugin**, because shipped `send` is uncapped today (`mail-queue.ts:145-163`). A newsletter-style external plugin needs B or C.

**Q6. What happens to `snapshots`?**
- A: Remove the capability (§7.4).
- B: Keep it for shipped plugins only, marked `withdrawn` for external plugins, with an issue.
- C: Broker it, restricted to the plugin's own row kind.
- **Recommendation: A.** Nobody uses it, C duplicates what `plugin_storage.*` already does, and B is the kind of difference the issue exists to remove.

**Q7. How far does `url_slots` go for external plugins?**
- A: `host` and `path-prefix` as declared tables the host reads (§6.8); `slug-format` and `full-path` not offered.
- B: Not offered at all until someone needs it (`planned` with an issue).
- C: Full parity through sandboxed `encode` calls, batched before every composing transaction.
- **Recommendation: A, scheduled last.** B is acceptable if the maintainer prefers to wait for a real need. C means restructuring every URL-composing write around a sandbox call.

**Q8. AI spend cap for external plugins.**
- A: The receipt's `maxDailyCostMicrocents` is required for an external plugin requesting `ai_provider`, is shown on the approval card and is enforced as the lower of it and the Owner's `ai_cost_cap`.
- B: The Owner must set `plugins.ai_cost_cap` before activation.
- C: No plugin cap; the site and per-person budgets only (the shipped default).
- **Recommendation: A.** The cap is part of the artifact the Owner approves, and the Owner can still lower it.

**Q9. How fine is the `cms_admin` grant?**
- A: The named-operation allowlist the installation policy already requires, shown grouped by domain and by read or write, plus the new `pluginAccess` marker so that a render is read-only for every plugin.
- B: Per-domain read and write grants as written in CMS_REQUIREMENTS §14.5, with no operation list.
- **Recommendation: A.** It is stricter than B, already enforced at staging and already stored in the receipt. B can be derived from it for display.

**Q10. Time budgets and sandbox pools.** Proposed values:

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
- A: Resumable chunks, `rebuild({ cursor? }) → { done?, cursor? }`, for every plugin. Today's answers count as done.
- B: An external rebuild runs as a batch in a job container (#1646), which requires the `batch_jobs` grant as well.
- **Recommendation: A.** It needs no second grant, and it also helps shipped rebuilds on large sites.

**Q12. May journal-driven calls write public tables?** A main-line batch sees staged content; copying it into a `published` table shows it to visitors before Publish live.
- A: Refuse public-table writes from journal batches and rebuilds, for every plugin, as observers and batches already are (`capabilities.ts:407-415`).
- B: Also refuse them from workers of plugins holding `cms_admin`.
- C: Leave it to the grant.
- **Recommendation: A.** No shipped consumer writes public tables. B would break legitimate derived rows (aggregates) for plugins that also read core data. The remaining path (a worker that reads staged core data through `ctx.cms` and publishes it) is stated on the approval card of a plugin holding both `background_workers` and `cms_admin`.

---

## 10. Related gaps found while writing this

These are not capabilities and are outside #1729. Each needs a check and, if confirmed, its own issue:

- `externalPluginDefinition` drops `listExt`, `visitorProjection`, `consentProvider` and `component` from the manifest (`external-plugin.ts:73-132`). `consent_provider` is brokered, but without the `consentProvider` declaration the gateway cannot compute the consent rule for an external provider.
- `loadTier2Row` does not seed a declared `config` (`loader.ts:568-664`; the seed runs only at `loader.ts:1499-1522`), although the SDK says missing stored configuration is an error, never a silent default (`index.ts:2327`). The registration seam (§4.3) fixes it, if confirmed.
- External plugins have no `onActivate` (see Q1).
- `metaSignature` / `metaSignatureBatch` are not available to external plugins, so their baked output misses the data-change cache bust (`index.ts:2680-2690`).

---

## 11. References

- CLAUDE.md §2 (plugin invariants), §11 and §11.A (gated operations), §11.B Tier 5 (the tick, no background timers), §12 (AI SDK shapes; `generateObject`).
- CMS_REQUIREMENTS §14.2-§14.7 (one plugin model, execution, grants, data zones, writes never straight to live), §14.13 (status), §17.3-§17.4 (AI cost controls and restrictions).
- [branch-aware-plugin-storage.md](../branch-aware-plugin-storage.md), [plugin-public-surface.md](../plugin-public-surface.md), [plugin-batches.md](../plugin-batches.md), [lists.md](../lists.md), [internal-links.md](../internal-links.md).
- [scheduler-tick.md](./scheduler-tick.md), [state-and-changes.md](./state-and-changes.md), [ai-spend-ledger.md](./ai-spend-ledger.md), [mail-outbox.md](./mail-outbox.md), [public-admin-boundary.md](./public-admin-boundary.md), [site-security-headers.md](./site-security-headers.md).
