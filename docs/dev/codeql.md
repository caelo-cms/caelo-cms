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

The allow-list mirrors the `--onlyAllow` set in `package.json`'s `license:check`
script. **Keep the two in lockstep** — `scripts/codeql-workflow.test.ts` fails
CI if they diverge. We use the non-deprecated `allow-licenses` option (not
`deny-licenses`); anything outside the set (GPL/AGPL/SSPL/proprietary) fails.

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
