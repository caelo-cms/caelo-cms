# Plugin admin panels

A plugin's pages in the admin are **data**, declared in its manifest as
`adminPanels` (`packages/plugin-sdk/src/admin-panels.ts`). No plugin ships
admin UI code. The admin renders every panel with one generic renderer at
`/plugins/<plugin-slug>/<panel-slug>` and lists the panels under **Plugins**
in the side navigation.

## Why declarative

- **Activation is a hard state** (CLAUDE.md §2). The renderer and the nav read
  the running host's loaded plugins (`loadedPlugins`); an inactive plugin is
  not loaded, so its pages do not exist (404, no nav entry). There is no
  per-plugin route that could outlive a deactivation.
- **One plugin model.** A shipped plugin and a runtime-installed one declare
  panels the same way and get the same pages. The panels are part of the
  manifest, so they are covered by the release signature or the artifact
  digest the Owner approves, and the installation review lists them in
  readable form (who may open each page, which operations it runs).
- **Plugin data is untrusted** (#635). Every value is rendered as text; the
  renderer never interprets plugin output as markup.

## Vocabulary

A panel has a `slug`, `title`, `description`, `icon` (from a fixed set), a
`permission` from the admin's catalog, and sections:

| Kind | What it does |
|---|---|
| `table` | Rows from an operation (`rowsKey`), declared `columns` (formats: text, multiline, code, datetime, number, badge, list, json), select `filters`, cursor `paging`, `rowActions` (optional `when` conditions and an optional `review` step), `bulkActions` on selected rows, toolbar `actions`, and a CSV `download`. |
| `stats` | Labelled numbers, either named `items` or `{label, value}` entries the operation labels itself. |
| `form` | A blank form submitted once to an operation (e.g. "draft a campaign"). |
| `settings` | A form pre-filled by `readOperation` and saved by `writeOperation`. |

A row action's `review` shows the operator exactly what the action will act
on and submits exactly those values (the newsletter's "send exactly this"),
so the operation can refuse data that changed after the review.

## Guarantees the admin enforces

- The panel's `permission` is checked on the page load, on every form action
  and on the CSV download.
- Only what the declaration names can run: actions are looked up by section
  and action id; their operation and fixed `args` come from the declaration.
  Fixed arguments are applied last, so a posted value never replaces them,
  and posted argument objects must have exactly the declared keys.
- The manifest schema checks every referenced operation exists, ids are
  unique, and no argument is both fixed and operator-supplied.
- Operations run as `owner-panel` invocations by the signed-in person.

## Adding a panel

Declare `adminPanels` in the plugin definition next to `operations`. If a page
needs data the operations do not expose, add an operation; do not add a
section kind for one plugin. See `packages/plugins/{comments,forms,newsletter,ratings}`
for examples.
