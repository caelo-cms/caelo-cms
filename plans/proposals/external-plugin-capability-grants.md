# Proposal: Owner-approved capability parity for external plugins

Status: proposed for review; no runtime or policy changes in this PR.

Tracking: [#469](https://github.com/caelo-cms/caelo-cms/issues/469).
Companion services proposal: [#470](https://github.com/caelo-cms/caelo-cms/issues/470).

Baseline inspected: `6d4d2dd9debba856286ff769b62cd2c17584cac3`.

## Outcome and decision requested

An Owner installs an externally developed plugin, reviews its requested access,
and grants each permission before activation. External plugins can request every
SDK capability available to bundled plugins. Shipping in the Caelo repository is
no longer a prerequisite for building a complete authoring feature.

The first consumer is [Pictbook](https://github.com/caelo-cms/pictbook): an external
plugin for creating illustrated books through the CMS chat, with print export.
It needs private authoring data, AI tools and skills, media generation, resumable
work, and preview rendering. It must ship independently of Caelo releases.

This explicitly proposes replacing the provenance ceiling in
`CLAUDE.md` §2 and `CMS_REQUIREMENTS.md` §§14.1–14.4, 14.8, 14.10. It does not
silently override those rules. Merging this proposal records the design for
implementation review; the current policy remains effective until the matching
implementation, tests, and authoritative-spec amendments land together.

## What exists, and what does not

| Source | Observed behavior |
| --- | --- |
| `packages/plugin-sdk/src/index.ts` | One SDK; capabilities, private schema, tools, skills, events and composition declarations exist. |
| `packages/plugin-sandbox/src/validate.ts` | Runtime-authored manifests cannot request elevated functionality. |
| `packages/plugin-host/src/capabilities.ts` | Runtime-authored provenance independently forces the base context. |
| `packages/plugin-host/src/loader.ts` | Active database-loaded Tier 2 plugins receive `executionStub: true`. |
| `packages/plugin-host/src/dispatch.ts` | Those operations return `Tier2RuntimePending`; the Deno execution path still needs to ship. |

Documentation describing a working subprocess/SDK bridge must not be mistaken for
an implemented execution path. Changing the manifest validator alone cannot
deliver this feature.

Related work: [#380](https://github.com/caelo-cms/caelo-cms/issues/380),
[#44](https://github.com/caelo-cms/caelo-cms/issues/44),
[data lists #447](https://github.com/caelo-cms/caelo-cms/pull/447), and
[client assets and visitor dispatch #456](https://github.com/caelo-cms/caelo-cms/pull/456).
These were open at inspection time. Adopt their final merged contracts; they are
not capabilities already available on the inspected main branch.

## Separate origin, execution, and permission

- **Origin** identifies bundled, external-package, or runtime-authored code and
  records publisher verification. It is evidence displayed during installation,
  not an authorization decision.
- **Execution** is in-process for existing audited bundled code and isolated for
  external/runtime-authored code. Equal SDK functionality does not require equal
  access to the host process, credentials, filesystem, or network.
- **Permission** is a host-owned grant bound to an installation and exact artifact.
  A manifest requests permissions; it cannot confer them.

Use the same capability catalog and authorization evaluator for all origins.
Do not add a second, permanently smaller external SDK. New SDK capabilities must
include an external-runtime implementation and parity tests before being declared
generally available. If a host version cannot bridge a requested capability,
installation fails with `UnsupportedCapability` and an upgrade instruction.

## Installation contract

1. Fetch an immutable package version or accept a local bundle/source submission.
   Initial delivery is a bundle upload or pinned HTTPS artifact; a marketplace
   and arbitrary package-manager install scripts are unnecessary.
2. Validate without executing plugin code. Produce a digest over the manifest,
   executable bundle, assets, schema/migrations, and companion skills. Resolve
   and include dependencies in that reviewed bundle; never execute mutable remote
   imports or install hooks on the CMS host. Bound archive size, expansion,
   paths, entrypoints, and SDK compatibility. Reject traversal and symlinks.
3. Present publisher/origin, exact version/digest, requested access with reasons,
   private/public schema changes, tools, skills, workers, browser assets and URL
   effects. Each capability has an explicit grant control; no elevated capability
   is preselected. Reasons from the plugin are displayed as untrusted text.
4. The authenticated Owner selects permissions and activates in one review flow.
   The existing in-chat approval card and security panel use the same server-side
   proposal/execute operation. Approval is bound to the reviewed digest and grant
   set, never merely to a slug or the AI's assertion that approval occurred.
5. Verify the exact artifact again, validate required grants and contribution
   conflicts, provision declared schemas, and stage registrations. Mark the
   installation active only after every required step succeeds. On failure,
   unregister staged effects and preserve the previous working installation.

All requests are required in the first version: declining one prevents activation
and explains which feature needs it. Optional capabilities and graceful feature
degradation can be added later with an explicit feature dependency declaration.

Keep current standalone-skill approval behavior. Plugin-owned skills are included
in the plugin review and go live/archive with the plugin without another click.
Runtime activation remains separate from publishing a website.

## Grant model and enforcement

Illustrative host-owned records (API names and storage schema are proposed):

```text
plugin_installation_versions:
  installation_id, artifact_digest, manifest_digest, sdk_api_version,
  origin, publisher_identity, verification_result, staged_at

plugin_capability_grants:
  installation_id, artifact_digest, capability, constraints,
  approved_by, approved_at, revoked_at, grant_revision
```

The host authenticates `approved_by`; plugin/AI/visitor callers cannot write these
records. Approval receipts use the existing audit machinery and survive restart.

At each dispatch and each privileged bridge call:

```text
effective permission = declared request
                     ∩ active Owner grants for this exact artifact
                     ∩ initiating actor's authority or approved worker scope
                     ∩ invocation audience and branch scope
                     ∩ host policy and resource limits
```

Do not let the plugin set its actor, site, installation, branch, audience, grant
revision, or an approval receipt. These come from the host invocation context.
Missing/stale grants fail closed at both registration and execution, including
cached tools, resumed chats, scheduled tasks, rendering and event delivery.

| Capability/contribution | Grant meaning and runtime path |
| --- | --- |
| `cms_admin` | Named Query API operations and resource scopes; normal actor checks and per-action approval remain. No raw SQL or unrestricted execution under a system actor. |
| `cms_admin_schema` | Host provisions the declared plugin-private schema with forced RLS. The broker exposes only this plugin's declared tables. |
| `snapshots` | Host-mediated authoring history within the initiating branch; cannot forge another plugin's entity or invoke an unapproved site-wide revert. |
| `ai_provider` | Host invokes configured providers within approved operations and budgets. Secrets never cross the bridge. |
| `chat_runner_tools` | Host registers namespaced, schema-validated operation descriptors. Tool approval cannot be removed by invoking the underlying operation through another route. |
| `background_workers` | Host schedules declared operations with bounded CPU/time/concurrency and explicit service authority. No arbitrary timers/process creation. |
| `domain_events` | Authorized event subscriptions only; validate payloads and cursors and filter inaccessible authoring data. |
| `email` | Broker sends under approved sender/recipient constraints and quotas. Existing per-action campaign approval stays effective. |
| `head_contributions` | Structured head/sitemap values with validation, size limits and conflict checks. |
| URL slots | Explicit reviewed claims with conflict checks and a preview of affected paths. Introduce a named grant for this currently provenance-gated declaration. |
| Skills | Reviewed bodies/tool allowlists tied to artifact and activation; not a route to grant new capabilities. |
| Data lists/client assets | Incorporate #447/#456 after merge, exposing the same reviewed descriptors to external plugins. Browser assets are shown explicitly in the install review. |

Operation scope constraints are enforced by the broker as well as Query API/RLS.
For example, access to media generation must not imply access to provider secrets
or security configuration. A grant to edit content is not a grant to publish it.

## Isolated runtime and invocation boundaries

Implement the currently missing Deno execution path using a versioned, typed,
size-bounded request/response protocol over host-owned pipes. SDK handles become
RPC clients; the host checks method schemas, grants and invocation identity before
calling existing services. Never serialize service objects, database handles or
credentials. Bound memory, wall time, output size, pending calls and concurrency;
terminate failed invocations and clean up their temporary resources.

Load only the verified bundle and SDK bootstrap. No plugin filesystem access,
environment access, arbitrary networking, subprocess spawning or mutable imports.
The runtime/bootstrap mechanism must be verified against the selected Deno
version; this proposal does not claim existing command-line flags implement it.

Owner installation approval authorizes capabilities, not arbitrary execution of
privileged plugin code inside the Bun host. Existing bundled execution is retained
for compatibility, with dispatch using the same grants and actor checks.

**Visitor dispatch is a separate audience.** Adopt #456's default-deny operation
exposure before enabling external authoring capabilities. An explicitly public
operation receives only public/visitor authority even if the plugin installation
also has private authoring grants. Background and authoring operations cannot be
reached by naming their operation in a public request. The public gateway never
receives admin database credentials; privileged broker work belongs in the admin
execution boundary.

Browser code has a separate boundary: Shadow DOM isolates styling, not script
authority. Visitor assets must not mount in the authenticated admin document.
Any future third-party editor UI requires a sandboxed iframe and a narrowly
validated message protocol. The first authoring UI uses host-rendered tool results
and previews; it does not need arbitrary third-party admin JavaScript.

## Updates, revocation, and recovery

- Every new artifact, even with unchanged permissions, needs an Owner review.
  Show code, schema, skill and permission diffs. Keep the approved version running
  while an update awaits review; never swap source under a retained grant.
- Grants are version/digest-bound. Rollback also needs an explicit Owner action;
  old approvals do not silently revive revoked access.
- Revoking any required grant stops new privileged calls, removes registrations,
  and disables the affected version. Mark revocation authoritative before draining
  caches/workers across host processes. Recheck the grant revision before committing
  writes. No new effects may commit after revocation wins that transaction boundary;
  already-dispatched external requests may complete and must remain visible in audit.
- Schema changes are host-managed and declarative. Keep the previous version
  runnable through additive migrations; incompatible/destructive migrations need
  a separate preview and recovery plan. A DB transaction cannot roll back an email
  or remote AI request, so activation hooks must not perform such effects.
- Disable preserves content, revisions, exports and audit records. Destructive
  uninstall is a separate explicit action with an export path.

## Compatibility and required spec edits

Retain legacy `tier` as a migration discriminator until callers are migrated;
never map an external grant to a forged `release-signed` provenance. Add explicit
origin/execution/grant records and stop using `tier` as authorization.

Existing active bundled plugins receive recorded compatibility grants for their
already-declared capabilities; inactive bundled plugins stay inactive. Existing
runtime-authored plugins retain base permissions only. Missing elevated approvals
are never inferred during migration. New bundled installations use the same
capability review surface; release signature verification remains in place.

Amend `CMS_REQUIREMENTS.md` §14, `CLAUDE.md` §2, `ARCHITECTURE.md`,
`CONTRIBUTING.md`, and both plugin-authoring docs alongside the implementation.
Reconcile their existing disagreement about automatic bundled activation with the
current hard activation behavior, explicitly in review.

## Implementation slices and acceptance evidence

1. **Policy and persistence:** manifest v2, immutable artifacts, grant receipts,
   migration and Owner review UI; no elevated external execution yet.
2. **Runnable sandbox:** validated bundle invocation plus base SDK bridge;
   remove `Tier2RuntimePending` only when actual execution tests pass.
3. **Capability parity:** broker private data, CMS, AI, snapshots, tools, skills,
   workers, events, email and composition. Each slice includes grant enforcement,
   audience restrictions and revocation. Do not advertise parity until all pass.
4. **Independent consumer:** install a Pictbook bundle built outside the monorepo,
   activate, create a private draft through chat, restart, resume, then disable.

Required unit/adversarial tests: forged receipts/digests, undeclared RPC methods,
bundle substitution, path traversal, oversized messages, tool-name collisions,
missing required grants, invalid outputs and timeouts. Maintain a shared fixture
that exercises each catalog capability through bundled and external runtimes.

Required real-Postgres integration tests: grant persistence, RLS across plugins,
actor/branch identity, rollback on failed activation, atomic authoring history,
concurrent revocation vs writes, queued work after update/restart and audit trails.

Required Playwright tests: review each permission, decline prevents activation,
approve makes tools usable, update awaits a fresh review, permission revocation
stops work, private operations remain unavailable to visitors, and disabled
plugins preserve data without continuing to execute.

Review must settle the manifest API version, the exact operation/resource scope
syntax, the migration of active bundled installations, and the supported bundle
format before implementation. The recommended decisions above are concrete
defaults for that review, not existing APIs.
