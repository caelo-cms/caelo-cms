// SPDX-License-Identifier: MPL-2.0

/**
 * `cms-provision attach --project <id>` (#696): make an install whose state
 * lives in its ops bucket manageable from this machine (a new laptop, Cloud
 * Shell). It reads `gs://<project>-caelo-ops/install/install.json`, checks
 * it, and mirrors install.json + progress.json into `~/.caelo-<id>/`. No
 * secret is copied, because none exists outside the operator's Google
 * login: Pulumi reaches the state and its KMS key with that login.
 *
 * Refuses rather than overwrites: an install directory here that holds this
 * install's local state (it was never migrated) or another backend.
 */

import { existsSync, mkdirSync } from "node:fs";
import { opsBucketName, parseStateBackend } from "./state-backend.js";
import { GcsStateStore, LocalStateStore, type SyncGcloud } from "./state-store.js";

export type AttachResult =
  | {
      readonly ok: true;
      readonly installId: string;
      readonly domain: string;
      readonly status: "attached" | "refreshed";
    }
  | { readonly ok: false; readonly error: string };

/** Install ids are `<provider>-<slug>` (install-state.ts deriveInstallId). */
const INSTALL_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Attach the install in `projectId` to this machine.
 *
 * @param deps.run gcloud runner (tests pass a fake bucket)
 * @param deps.rootFor `~/.caelo-<id>` for an install id
 * @param deps.hasLocalState whether a dir holds a local Pulumi stack
 */
export function attachInstall(
  projectId: string,
  deps: {
    run: SyncGcloud;
    rootFor: (installId: string) => string;
    hasLocalState: (root: string) => boolean;
  },
): AttachResult {
  const bucket = opsBucketName(projectId);
  let text: string | null;
  try {
    // Peek: the directory to mirror into isn't known (or checked) yet.
    text = new GcsStateStore(bucket, "/nonexistent", deps.run).peek("install.json");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (text === null) {
    return {
      ok: false,
      error: `gs://${bucket} holds no install.json. If this install's state is still on the machine that installed it, run \`bunx @caelo-cms/provisioning state migrate\` there first.`,
    };
  }
  let remote: {
    installId?: unknown;
    domain?: unknown;
    projectId?: unknown;
    stateBackend?: unknown;
  };
  try {
    remote = JSON.parse(text) as typeof remote;
  } catch {
    return { ok: false, error: `gs://${bucket}/install/install.json is not valid JSON.` };
  }
  const installId = typeof remote.installId === "string" ? remote.installId : "";
  if (!INSTALL_ID.test(installId) || remote.projectId !== projectId) {
    return {
      ok: false,
      error: `gs://${bucket}/install/install.json does not describe an install in project ${projectId}; refusing to attach.`,
    };
  }
  let backend: ReturnType<typeof parseStateBackend>;
  try {
    backend = parseStateBackend(remote.stateBackend);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (backend?.kind !== "gcs") {
    return {
      ok: false,
      error: `${installId}'s state was moved back to a machine (state migrate --to local); there is nothing in gs://${bucket} to attach to. Run \`state migrate --to remote\` on that machine first.`,
    };
  }
  if (backend.bucket !== bucket) {
    return {
      ok: false,
      error: `install.json in gs://${bucket} names another bucket (${backend.bucket}); refusing to attach.`,
    };
  }

  const root = deps.rootFor(installId);
  const localText = new LocalStateStore(root).read("install.json");
  // Local Pulumi state blocks the attach whether or not an install.json
  // sits next to it: attaching would hide it.
  if (deps.hasLocalState(root)) {
    return {
      ok: false,
      error: `${root} holds a local Pulumi state of this install. Attaching would hide it; run \`bunx @caelo-cms/provisioning state migrate --install ${installId}\` instead, or move ${root} aside if that state is stale.`,
    };
  }
  let status: "attached" | "refreshed" = "attached";
  if (localText !== null) {
    const local = JSON.parse(localText) as { stateBackend?: unknown };
    const localBackend = parseStateBackend(local.stateBackend);
    if (localBackend?.kind === "gcs" && localBackend.bucket === bucket) {
      status = "refreshed";
    } else {
      return {
        ok: false,
        error: `${root}/install.json exists and names another backend. Move ${root} aside, then re-run attach.`,
      };
    }
  }
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const store = new GcsStateStore(bucket, root, deps.run);
  // read() mirrors each document into the install dir.
  store.read("install.json");
  store.read("progress.json");
  return {
    ok: true,
    installId,
    domain: typeof remote.domain === "string" ? remote.domain : installId,
    status,
  };
}
