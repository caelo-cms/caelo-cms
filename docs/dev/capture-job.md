# The capture job: browser renders outside the admin

Issue #1217, part of #1209. Every server-side browser render Caelo does — `screenshot_page` when no operator browser is attached (MCP, subagents, the timeout fallback), `screenshot_external_page`, `inspect_external_page`, the selector modes of `query_page_html`, `map_external_page_types`, and the site-import crawl with its ground-truth pass — needs a headless Chromium. One render costs 300–700 MB. Inside the 2 GiB admin container that was the most plausible cause of the OOM kill of 2026-10-28, and the old preview path made it worse by loading `/_caelo/preview-screenshot/<id>` back from the same admin.

So on a GCP install no Chromium runs in the admin. CLAUDE.md §11.B Tier 5 lists this as the second exception to "background work shares the admin", next to the quality audit's Lighthouse runs (#875).

## Where a render runs

| Install | Backend | Code |
|---|---|---|
| `gcp`, `gcp-firebase` | One execution of the Cloud Run job `caelo-<env>-capture` per render | `admin-core/src/capture/` (admin side), `capture/capture-task.ts` (job side) |
| self-hosted, dev | One in-process Chromium, shared, **one render at a time** | `ai/tools/_external-screenshotter.ts`, `capture/capture-slot.ts` |
| `aws`, `azure` | None yet: every server-side render is refused with the tracking issue (#749 / #750) | `capture/capture-backend.ts` |

A cloud install whose job is not configured is refused too, never rendered in-process instead (no fallbacks pre-1.0): the in-process render is exactly the spike that killed the admin.

All callers get their screenshotter from `getExternalScreenshotter()`; on GCP it returns a `Screenshotter` whose `capture` / `renderHtml` / `query` each start one execution (`capture/job-screenshotter.ts`), so the tools did not change.

## How the job reaches a branch preview

The admin sits behind Google IAP. The job renders untrusted pages — third-party sites for the external tools, AI-authored module scripts in a preview — so a browser exploit in the job must not hold anything that passes IAP. We therefore did **not** give the job an IAP-admitted identity or a route back into the admin. Instead the admin hands the job everything a preview render needs (`capture/preview-capture.ts`):

1. The admin renders the preview document itself through the Query API (`pages.render_preview` on the chat's branch, as the caller; fonts inlined as `data:` URIs) — the same document `/_caelo/preview-screenshot/<id>` serves.
2. For every `/_caelo/media/...` URL in it, it looks the variant up (`media.get`) and signs a **V4 read URL** for that object in the media bucket.
3. It writes `{ html, media }` to `in/<captureId>.json` in the capture bucket and starts the job with a signed URL of that object in the order (`CAELO_CAPTURE_ORDER`).
4. The job fetches the input, serves the document and the media to its browser under the made-up origin `https://preview.caelo.invalid`, and aborts every other request (site-importer `handleServedRoute`) — the same fail-closed policy the in-process capture applies to its loopback origin. It writes `out/<captureId>.json`.
5. The admin reads the result and deletes both objects.

Signed URLs live 5 minutes, name one object each and point at nothing once the capture ended (the input is deleted), so one URL is good for one capture. The job fetches only `https://storage.googleapis.com/` signed URLs and follows no redirect. External captures need no input at all; a selector query hands its HTML over the same way as a preview (an env var holds 32 KB at most).

The admin signs as its own service account through IAM `signBlob` (Cloud Run holds no key): it gets `roles/iam.serviceAccountTokenCreator` on **its own** account only, which adds nothing it could not already do through the metadata server.

Alternatives we rejected:

- **A job identity IAP admits** (like `caelo-mcp`) and a signed endpoint on the admin: the job would hold a credential that passes the admin's first line of defence while rendering hostile pages, and every render would again load the admin.
- **The job reading the media bucket with its own identity** (as the audit job reads the staged build): every draft and reference image of the site would be readable from a container that runs third-party JavaScript.
- **Media inlined into the document as `data:` URIs**: an image-heavy page would put tens of MB of base64 through the admin's memory, the cost this issue removes.

## Trust boundary

| Principal | Grants (capture-job-setup.ts) |
|---|---|
| Job SA `caelo-<env>-capture` | `roles/storage.objectCreator` on the capture bucket, IAM-conditioned to `out/`; `roles/logging.logWriter`. Nothing else: no read right anywhere, no secrets, no Cloud SQL, no VPC, no IAP. `CAPTURE_FORBIDDEN_ROLES` and the setup test hold that line. |
| Admin run SA | `roles/run.jobsExecutorWithOverrides` + `roles/run.viewer` on the job; `roles/storage.objectUser` on the capture bucket; tokenCreator on itself. |
| Upgrader SA | `actAs` on the job SA, so the app-roll can move the job's image (`upgrade/admin-image-jobs.ts`). |

Like the audit job, the admin may run the job with overrides (it passes the order). A compromised admin can make the job render other URLs, but the job holds nothing worth taking. The admin validates every result with Zod (`capture-protocol.ts`) and treats it as untrusted data.

## Lifecycle

- The job runs the admin image (Chromium is bundled, #428) — no image of its own. The job refuses an order from an admin on another version.
- Created by the wizard after `pulumi up` and by every `cms-provision upgrade` converge (infrastructure contract 14), not by the stacks: `upgrade` never runs Pulumi.
- Each app-roll moves the job onto the admin's new image; a rollback moves it back.
- The capture bucket deletes anything older than a day; the admin deletes each capture's objects as it ends.
- Admin env: `CAELO_CAPTURE_JOB`, `CAELO_CAPTURE_BUCKET`, `CAELO_MEDIA_BUCKET` (stack-contract.ts).

## Cost and latency

An execution starts in roughly 5–20 s and renders at 1 vCPU / 2 GiB: about $0.001 per render, a 50-page site import about $0.05, mostly within the free tier (`wizards/gcp-cost.ts`). The admin waits up to 120 s per render (`CAPTURE_TIMEOUT_MS`). On the admin side a render costs the document, the signed media map and the PNG: measured ~2 MB for a viewport capture and ~20 MB for a 4 MB full-page PNG, against 300–700 MB for an in-process Chromium.

## Self-hosted: one browser, carefully

- One shared Chromium, idle-closed after 60 s without renders; a queued render keeps it open.
- One render at a time across all callers (`IN_PROCESS_CAPTURE_SLOTS = 1`): the crawl's workers, a chat screenshot and a selector query queue instead of each opening a page.
- `screenshot_page` captures the viewport unless the AI passes `fullPage: true`.
- Chromium runs with `SCREENSHOT_MEMORY_ARGS` (site-importer `screenshot.ts`): no `/dev/shm` (a small tmpfs in containers), no GPU process, at most two renderers, a 512 MB V8 heap per renderer, no disk or media cache. The profile lives in the OS temp dir, which on the compose install is the container's disk (no tmpfs is mounted), and without caches it stays a few files.

## Troubleshooting

- **"server-side screenshots are not set up on this install (CAELO_CAPTURE_JOB … missing)"** or **"could not start the capture job"**: the job is missing. Run `cms-provision upgrade`; its "Ensuring the capture job" step says what failed.
- **"the capture job runs Caelo X but the admin runs Y"**: the app-roll could not move the job's image. The next upgrade moves it; by hand: `gcloud run jobs update caelo-<env>-capture --image=<the admin's image>`.
- **"the capture job ended without a result"**: the execution crashed; its log in Cloud Run (job `caelo-<env>-capture`, the execution named in the message) says why.
- **"the capture input answered HTTP 403"**: the signed URL expired before the job started (more than 5 minutes) — usually a Cloud Run quota or a cold region; retry.
