# AI tool texts and AI-facing errors

How Caelo writes what the AI reads about a tool: its description, its
schema blurbs, and the errors it gets back (#1277). Read this before you
add a tool or change a tool's text.

## The cost model

Tool definitions are cached, but not free: every new chat (and every
cache miss or compaction) writes the whole catalogue into the cache
again, and every request reads it. A failed call costs one extra turn,
and with #1275 that turn is a small patch (`retry_tool_call`) instead of
a resend of the whole call — so a complete error is cheap, and a rule in
the description is paid on every request.

## The rule

A rule stays in a tool description only if it

- (a) prevents a mistake the server **cannot detect** (naming, reuse
  before mint, routing to the right tool, a policy such as "only with the
  operator's consent"), or
- (b) prevents a **frequent** mistake, roughly 1 in 5 to 1 in 10 calls of
  that tool, and then in at most one line.

Every rarer mistake the server detects lives **only in the error**, and
that error must meet the bar below. The description does not mention it.
A rule block shared by several tools is written once, never copied
(`INTERNAL_LINK_CONTRACT` is one line per tool; the `data-caelo-ui` kit
markup lives once, on `build_page`'s `modules[].js`). A description cut
lands in the same change that makes the error it relies on meet the bar.

Frequencies are estimates until a per-tool / per-error-path failure
count exists (follow-up of #1275, from `chat_tool_results`). Write the
estimate in the PR.

These stay in the descriptions regardless: semantic field naming and
lists instead of numbered fields, "`fields` is the WHOLE list", reuse
before mint, title vs shortTitle vs slug, USE FOR / DO NOT USE FOR.

Every touched tool must shrink. Measure description + schema size of the
core tools before and after (`CORE_TOOL_NAMES`, `createDefaultToolRegistry().catalogue()`).

Style rules for the text itself (routing first, details on the property,
no restating the JSON Schema, no version history, telegram style) are
unchanged.

## The error bar

An AI-facing error is complete and patchable:

- **Structured.** A failed `ToolResult` carries `failureKind` (a
  `QueryError` kind, `InvalidArguments`, `UnknownTool`, or `internal`)
  and `errors: ErrorDetail[]` — `{ path, message, allowed?, next? }` with
  `path` an absolute segment path into the tool's own arguments, Zod
  `issue.path` form (`["modules", 3, "content", "values", "hero_title"]`).
  Ops build it with `handlerErrorFromDetails` (`@caelo-cms/query-api`);
  tools return it with `toolError(error, text)` (`ai/tools/_describe-error.ts`).
- **One path format.** Text renders paths with `formatErrorPath`
  (`modules[3].content.values.hero_title`); the text is rendered from
  the same entries, so text and structure agree.
- **All at once.** Every problem found before the next write is
  reported in one result: `build_page` collects its pre-write checks and
  every failing entry; bulk ops run every item (`runEveryItem`,
  `ops/_bulk.ts`) and report every failing index.
- **Says what to change**, never "resend", "re-call" or "resend the
  whole batch" (`no-resend-wording.test.ts` enforces it).
- **No Postgres internals.** No SQLSTATE, constraint, table or SQL text:
  `thrownToQueryError` / `describePgFailure` describe a violation by the
  caller's value (`` `slug` "hero-3" already exists ``); an RLS denial is
  a sentence about what to check. The raw fields stay on `pgDetail` and in
  the log.
- **Labels, not bare ids**, and every "not found" names the tool that
  lists the valid ids (`describeError` adds it when the op did not).
- **Defects are `internal`.** A throw that is not a constraint violation,
  or an `insert … returning` without a row (`internalError`), is
  `failureKind: "internal"`: never offered for a patch, reported to the
  bug intake.
