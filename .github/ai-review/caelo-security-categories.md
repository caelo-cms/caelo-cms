# Caelo CMS — house security categories

These categories EXTEND the default Claude Code Security Reviewer audit
(injection, auth, secrets, crypto, validation, etc.). They do NOT replace it.

When you find a violation of any rule below, **cite the source** in the
finding's explanation — for example *"violates CLAUDE.md §2 invariant: raw
SQL detected"*. Contributors learn this codebase's rules from the citations,
so they matter as much as the finding itself.

**Caelo data-access invariants (CLAUDE.md §2 — "no raw SQL anywhere"):**
- Raw SQL outside the Query API is a CRITICAL finding. All database access
  in this repo MUST flow through the Query API → Validator → Adapter chain.
  Flag any direct `pg.query`, `client.query`, `db.execute`, or `sql\`...\``
  template-literal call outside `packages/query-api/`. Inside the Query API
  itself, flag string-concatenated WHERE clauses, dynamic table names, or
  any SQL string built by interpolation — those are injection sinks even
  inside the trusted boundary.
- RLS bypass is a HIGH finding: code that runs as `admin_role` against rows
  another role should own, that drops `SET row_security = on`, that grants
  `BYPASSRLS`, or that adds a table without an `ENABLE ROW LEVEL SECURITY`
  policy. RLS is enforced on every table in both `cms_admin` and
  `cms_public`, FORCEd for owners too.
- Cross-role privilege grants are CRITICAL: `admin_role` and `public_role`
  are isolated. Code that lets the API Gateway hold `admin_role`
  credentials, or grants any cross-database role, breaks the two-database
  split in CMS_REQUIREMENTS §12.

**Caelo page + content invariants (CLAUDE.md §2):**
- Raw HTML on pages is HIGH: pages are assembled from module references
  only. Any code that lets a user submit, store, or render raw HTML in the
  page body (outside a Module's bounded rendering scope) lands here.
- Raw HTML into `<head>` is HIGH: SEO is structured fields only. Any code
  path that injects user-controlled markup into the document head violates
  §2 and is also an XSS sink in many cases.
- Missing-translation fallbacks are MEDIUM: missing translations MUST
  clean-404, never silently fall back to the default locale. A fallback
  path leaks duplicate content under different URLs (SEO regression).
- Pre-1.0 silent fallbacks are MEDIUM: any "if data missing, use default"
  branch at read time (not the create-time resolver) violates the
  no-fallbacks-pre-1.0 invariant. Caelo wants loud failures pointing at
  missing data, not silently-degraded renders.

**Caelo plugin permission model (CLAUDE.md §2, CMS_REQUIREMENTS §14):**
Every plugin — shipped in `packages/plugins/<slug>/` or installed at
runtime, human- or AI-written — is held to the same rules. Authorship or
a release signature never justifies a wider permission.
- Sandbox bypass is CRITICAL: plugin backend code must run in the Deno
  subprocess (`--no-read --no-write --no-net --no-env`), be validated by
  the oxc-parser validator before load, bundle nothing but its own entry
  and the SDK, and use Shadow DOM on every Web Component. Disabling or
  widening any of these is a security regression.
- Capability without a grant is CRITICAL: a plugin reaching anything
  beyond its base (own `cms_public.<slug>` tables, theme, visitor id,
  captcha, own public api) without an Owner-approved grant bound to its
  artifact digest; or a grant check that can be skipped or replayed.
- Direct data access is CRITICAL: a plugin (or the host code brokering
  for it) touching core data other than through the named Query API
  operations of a granted domain, touching another plugin's data, or
  issuing raw SQL.
- Live authoring write is HIGH: a plugin write to `cms_admin` — core
  data or the plugin's own private storage — that bypasses validation,
  audit and snapshots, or that lands on live instead of the originating
  chat's branch. Visitor writes into the plugin's own public tables via a
  declared `publicOperation` are the only live writes allowed.
- Credential exposure is CRITICAL: a plugin receiving a session token,
  API key, connection or other bearer credential.

**Caelo propose / execute pattern (CLAUDE.md §11.A):**
- Auto-approve on gated ops is CRITICAL. Hard-to-revert ops (locales,
  layouts, plugin activation, site_defaults, snapshot revert, large
  redirect deletes, deploy promote / rollback) follow the two-step
  `<domain>.propose_<action>` then human-only
  `<domain>.execute_proposal({proposalId})` flow. Flag any code path that
  lets a non-human actor call `execute_proposal` directly, or that
  auto-approves a queued proposal on a timer / repeat-yes basis.
- Missing actor-scope rejection is HIGH: `execute_proposal` handlers MUST
  reject non-human actors at the Validator. A handler that trusts an
  `actor.kind` claim from a request body, instead of consulting the
  Validator's scope registration, is bypass-able.

**Caelo boundary validation + code-quality (CLAUDE.md §4 + §7):**
- Missing Zod at a boundary is HIGH: HTTP request bodies, Query API op
  inputs, plugin SDK surfaces, and AI tool-call argument shapes MUST be
  Zod-validated before the handler runs. A handler that casts
  `req.body as Foo` without parsing through a schema is the finding.
- `any` / `@ts-ignore` without a "why" comment is MEDIUM. Per CLAUDE.md §4
  these are banned except when commented with what unblocks their removal.
- Public-write endpoints without CAPTCHA / rate limit / honeypot are HIGH.
  Any unauthenticated POST handler in the API Gateway that lacks all three
  belongs here. Plugin-authored endpoints are NOT exempt.
- Missing audit-log entry on a write is MEDIUM. Every Query API op that
  mutates state emits an audit-log row; handlers that return success
  without logging silently break observability.
- Missing snapshot emission on a write is MEDIUM. Every mutating op MUST
  emit a snapshot (CMS_REQUIREMENTS §5). Reverting a site snapshot must
  restore both pages and modules — a write that skips snapshot emission
  breaks site-wide revert.

**Caelo secret handling (CLAUDE.md §7):**
- Secret in source is CRITICAL: any API key, password, OAuth client
  secret, or service-account JSON found inline in a committed file —
  including `.env.example` and fixture data. Recommend rotation in the
  remediation note.
- Secret as env-literal in CI / IaC is HIGH: workflow YAMLs, Pulumi
  configs, or docker-compose files that set a secret to a literal string
  instead of reading from the cloud-native secret manager / GitHub Secrets.

**Severity calibration for Caelo findings:**
- CRITICAL — RLS bypass, secret in source, sandbox bypass, propose/execute
  bypass, raw SQL outside the Query API, cross-role privilege grant.
- HIGH — boundary validation missing, raw HTML rendered to page or head,
  public-write endpoint without anti-abuse, plugin authoring write to live,
  missing actor-scope rejection, secret as env-literal.
- MEDIUM — `any` without "why" comment, fallback-on-read paths, missing
  translation fallback, missing snapshot emission, missing audit log.

If you are unsure whether a finding violates a specific CLAUDE.md section,
cite the closest section anyway and explain your reasoning. Over-citation
is fine; silent uncited findings are not.
