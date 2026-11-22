# Plugin batch operations

Epic #1644, R5 (issue #1646). With the `batch_jobs` grant, a plugin declares operations that run outside the admin, in a job container started from the release's own signed image. The work is too big for a request: aggregating a month of counts, or re-deriving data from storage.

```ts
batchOperations: [
  {
    operation: "learn",
    description: "Folds the last 30 days of counted searches into candidates and insights.",
    triggers: ["schedule", "operator"],
    schedule: "17 3 * * *",
    maxRunSeconds: 900,
  },
],
```

## Triggers

- `activation`: once per plugin version, when it loads. Boot loads on other instances add nothing.
- `operator`: a person or the AI starts it (`start_plugin_batch`, `plugin_batches.start`).
- `stage`: after every successful Stage. The run gets the Stage in `args.stageRunId`.
- `schedule`: on its cron, from the scheduler tick (task `plugin-batch:<slug>/<op>`).

At most one run of one operation is queued or running; a second start is refused with the running one. At most 4 batch operations per plugin. `maxRunSeconds` is at most an hour.

## How it runs

Each run is a row in `plugin_batch_runs` and an attempt of the `plugin_batch` reporting job (`caelo-<env>-plugin-batch`; in-process on self-hosted installs, one at a time). The job holds no database credential and no secret:

1. `order`: the run moves to running. The job learns the operation, its arguments, which handles the plugin's context carries, and an installed plugin's artifact, verified against its approval.
2. The operation runs. An installed plugin (Tier 2) runs in the same Deno sandbox as everywhere else. A shipped plugin runs from the image's verified copy, or the host's definition in-process.
3. `call`: every SDK call is a report. The admin answers it on the context it builds for the plugin (origin `batch`), with the plugin's own grants. Nothing the job sends can widen them.
4. `done` or `failed` ends the run. The result is kept (at most 64 KB).

A stopped run (`stop_plugin_batch`), or a plugin disabled or updated meanwhile, ends the attempt at its next report. The launcher starts a plugin_batch job only while an active plugin holds `batch_jobs`. The scheduler tick's backstop starts a queued run whose start was lost.

## What a batch sees

`ctx.query` (public tables: reads; writes are refused, as for observers), `ctx.adminQuery` and `ctx.privateFiles` (shipped plugins with the grant), `ctx.config`, `ctx.collections` (writes go to the next Stage's index), `ctx.api`. It gets no mail, no AI and no network. An installed plugin's private storage is author data and reaches only a call made for an author, so its batch gets configuration and collections.

The AI's tools: `start_plugin_batch`, `list_plugin_batches`, `stop_plugin_batch`. `get_plugin` lists a plugin's batches with their triggers. Source: `packages/admin-core/src/plugin-batches/`, provisioning in `packages/provisioning/src/reporting-job-catalog.ts`.
