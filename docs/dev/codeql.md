# CodeQL, dependency review + secret scanning — the security gates

These three GitHub-native gates (issue #26) sit alongside the AI security review
(#24). The AI review is heuristic and informational; these are structured,
deterministic, and — for CodeQL — merge-blocking. All are free on public repos.

## CodeQL — static analysis

[CodeQL](https://codeql.github.com) runs in `.github/workflows/codeql.yml` on
every PR, on every push to `main`, and weekly (Mondays). It finds
class-of-vulnerability bugs — SQL injection, XSS, command injection, auth
bypass, prototype pollution — that pattern-matching reviewers miss.

This is **advanced setup** (a committed workflow) rather than GitHub's
default setup, chosen so the configuration lives in-repo under review and the
required-status wiring has a stable check to point at.

### What it analyses

A two-language matrix:

- **`javascript-typescript`** — the whole product tree (`apps/`, `packages/`,
  `scripts/`) in one pass.
- **`actions`** — the workflow files themselves, for script injection via
  untrusted `${{ }}`, over-broad `permissions:`, and unpinned action refs.

Both run the **`security-extended`** query suite. If first-run noise on the
existing tree is too high, downgrade to the default `security` suite by editing
the single `queries:` line in the workflow — that is the noise lever.

### Action pinning policy (`actions/unpinned-tag`)

The `actions` analysis flags actions that aren't pinned to an immutable ref.
The repo convention (issue #113):

- **Third-party actions** (anything outside the `actions/*` and `github/*`
  GitHub-owned namespaces — e.g. `oven-sh/setup-bun`, `docker/*`,
  `sigstore/cosign-installer`, `google-github-actions/auth`,
  `softprops/action-gh-release`) are pinned to a **full 40-character commit
  SHA** with a trailing `# vN` comment, e.g.
  `uses: oven-sh/setup-bun@0c5077e…21857d6 # v2`. The SHA is the security
  boundary; the comment lets Dependabot's `github-actions` ecosystem keep the
  pin current.
- **First-party `actions/*` and `github/*`** stay on a **major tag** (`@v4`).
  CodeQL does not flag these (GitHub's own trust model), and
  `codeql.yml` / `dependency-review.yml` pin `github/codeql-action` and
  `actions/*` this way.

`scripts/codeql-workflow.test.ts` encodes this split and fails CI if a
third-party action regresses to a floating tag, if a SHA pin loses its version
comment, or if a least-privilege job loses its `permissions:` block. Resolve a
new `actions/missing-workflow-permissions` alert by adding the narrowest
`permissions:` block the job needs (usually `contents: read`, or `{}` when the
job touches no GitHub API).

### Triaging + dismissing alerts

Prefer **fix-at-source**. Dismiss (Security tab → the alert → *Dismiss*) only
for a genuine false positive or test-only finding, and always **with a written
rationale** — never mute wholesale (CLAUDE.md §4). Example: the
`js/file-access-to-http` findings in the operator-run provisioning/release
scripts (`packages/provisioning/*`, `scripts/apply-rulesets.ts`) are dismissed
because the data is operator-controlled config / IaC output, not untrusted
request-path input. A dismissal without a rationale is a review failure.

#### Fixed false-positive class: `js/clear-text-logging` via the Query-API dispatcher

CodeQL's name heuristic treats the auth op *definitions* (`changePasswordOp`,
`adminSetPasswordOp`, `requestPasswordResetOp`, `resetPasswordOp`) as
sensitive values. `execute()` used to answer an unknown op name with
`if (isErr(opLookup)) return opLookup;` — and because CodeQL does not narrow
the `Result` union, it saw the registry's `ok(op)` (carrying an op definition
in `value`) flow out of *every* `execute(...)` call. Any id later read from an
op result — e.g. a `chatSessionId` — was then "password data", which produced
a cascade of `js/clear-text-logging` (high) alerts on unrelated
observability logs: the chat-runner's loop/streaming/dispatch/catalogue/
passive-turn/budget-gate diagnostics and `ai/auto-recovery.ts`.

The cure is structural: `execute()` re-wraps the lookup error
(`return err(opLookup.error)`), so no op definition can reach an op result
(`packages/query-api/src/__tests__/execute.test.ts` pins the shape). Do not
reintroduce a pass-through of a `Result` whose `ok` arm holds something other
than what the caller should receive.

If a NEW `js/clear-text-logging` alert appears, read its data-flow path in the
alert (or the analysis SARIF) before anything else: a path that starts at an
auth op and ends in a log is a real finding — fix it at source, never by
dismissing. Keeping PRs small also keeps CodeQL's per-diff attribution precise.

#### Values from HTTP answers written to disk (`js/http-to-file-access`)

The provisioning CLI records some values it reads from the admin (e.g. the
staging host from `staging-domain enable`) in `install.json`. CodeQL accepts a
fully anchored, wildcard-free regex test as a sanitizer, but only on the
branch where the test *passed* — a `if (!re.test(x)) process.exit(1)` guard
does not count, because CodeQL does not know `process.exit` never returns.
Route such values through an allow-list helper that returns the value only
from the passing branch (`recordableStagingHost()` in
`packages/provisioning/src/install-state.ts`) and write its result.

### Where findings surface

The repo **Security tab → Code scanning alerts**. The `analyze` step uploads
SARIF automatically via the job-scoped `security-events: write` permission.

### Merge blocking

The `CodeQL` check is a required status check in the `main-protection` ruleset
(`.github/rulesets/main.json`), so it blocks merge. The severity threshold that
fails the check — i.e. "high-or-higher findings block merge" — is configured in
repo **Settings → Code security → Protection rules**, not in the workflow.

> **Gotcha (plan R1):** the exact context string GitHub reports for the
> code-scanning check must be confirmed against a real CodeQL run before running
> `bun run rulesets:apply`. The ruleset ships the most-likely name (`CodeQL`)
> with a caution note; applying a non-existent required check would block *all*
> merges. Confirm with `gh pr checks` on a PR that has a completed CodeQL run,
> then correct `main.json` if needed.

## Dependency review

`.github/workflows/dependency-review.yml` runs `actions/dependency-review-action`
on every PR and **fails** it when the diff introduces a dependency that:

- has a known advisory of **`high`** severity or higher (`fail-on-severity:
  high`), in either the `runtime` **or** `development` scope (`fail-on-scopes`),
  or
- carries a license outside the MPL-2.0-compatible **allow-list**
  (`allow-licenses`, per CLAUDE.md §3).

The allow-list mirrors `ALLOWED_LICENSES` in `scripts/license-check.ts`, the
gate behind `bun run license:check`. **Keep the two in lockstep** —
`scripts/codeql-workflow.test.ts` fails CI if they diverge. We use the
non-deprecated `allow-licenses` option (not `deny-licenses`); anything outside
the set (GPL/AGPL/SSPL/proprietary) fails.

**`bun run license:check` (installed tree).** Dependency review only sees
dependencies a PR adds or changes, so `scripts/license-check.ts` checks the
whole installed tree in CI: every workspace, dev dependencies included, private
`@caelo-cms/*` workspaces skipped. It evaluates SPDX expressions properly
(every `AND` operand must be allowed, one `OR` operand suffices) and fails when
fewer than `MIN_PACKAGES` packages were examined, because a broken scan (the
old `--production` flag resolved 0 packages under bun workspaces) must not read
as a pass.

**Per-package exceptions.** `LICENSE_EXCEPTIONS` in `scripts/license-check.ts`
lists each reviewed exception with its exact licence string and a reason; an
unused entry fails the gate. The workflow exempts the same packages by purl
(`allow-dependencies-licenses`), never via `allow-licenses`.
`scripts/license-check.test.ts` pins the list and keeps the workflow in
lockstep; `scripts/font-license-exception.test.ts` guards the font rule.

- **OFL-1.1, fonts only** (#778): the admin's self-hosted brand fonts
  (`@fontsource-variable/schibsted-grotesk`, `@fontsource/ibm-plex-mono`). To
  add another font, add it to both lists.
- **LGPL-3.0-or-later, `@img/sharp-libvips-*` only** (#794): the prebuilt
  libvips that `sharp` loads at runtime as a separate shared library. The admin
  and gateway images redistribute it, so their Dockerfiles run
  `scripts/libvips-notice.ts` against the final `/app` tree to write
  `/app/THIRD_PARTY_NOTICES.txt` (package and bundled library versions, the
  `lovell/sharp-libvips` release for corresponding source, and the LGPL-3.0 and
  GPL-3.0 texts from `licenses/`).
- **CC-BY-3.0** for the SPDX data packages `spdx-exceptions` and
  `spdx-ranges`: data files, not code, under an attribution-only licence.
  `spdx-ranges` is dev-only (licence checker); `spdx-exceptions` also ships in
  the provisioning closure through Pulumi, with its attribution intact in its
  README. **Zlib** for `pako`, and `@logdna/tail-file` 2.2.0, whose
  LICENSE file is the MIT text but whose `package.json` reports no SPDX id.

On failure it posts a single summary comment on the PR
(`comment-summary-in-pr: on-failure`).

## Secret scanning + push protection

Enabled at the repo level so a push containing a detected secret pattern is
rejected at `git push` before it ever lands — the mechanical backstop for
CLAUDE.md §7 ("secrets never in code"). These are repo *settings*, not files;
like the branch-protection ruleset they are managed as config-as-code by a
maintainer with repo-admin scope:

```bash
bun run security:check    # report drift: are both flags enabled?
bun run security:enable   # enable secret scanning + push protection (idempotent)
```

The script (`scripts/enable-security-features.ts`) PATCHes the repo's
`secret_scanning` and `secret_scanning_push_protection` flags via the GitHub
API. Enabling needs a token with **repo-admin** scope; a non-admin token gets a
clear 403.

If push protection blocks a legitimate push (a value that only looks like a
secret), follow the unblock prompt GitHub prints at the push — never bypass it
for a real credential.
