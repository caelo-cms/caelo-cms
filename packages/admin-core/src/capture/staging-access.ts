// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1330 — the admin's own renders of the protected staging site.
 *
 * Staging answers nothing without the gate, on any host (epic #763 E8). A
 * capture the AI asks for on the staging host (`screenshot_external_page`,
 * `inspect_external_page`, …) gets a short-lived per-run token from here,
 * scoped to `capture` and valid for {@link CAPTURE_TOKEN_TTL_SECONDS}: the
 * browser sends it ONLY with requests to the staging origin (never to a
 * host the page embeds, never across a redirect off the origin;
 * site-importer `originHeaders`). Neither the capture job nor the in-process
 * browser ever holds the gate key or a crawler credential.
 *
 * The Lighthouse runs of the quality audit do not come here: they load the
 * staged build on a loopback origin, so the gateway never skews a score
 * (#875; decision 2026-11-04, D4).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { STAGING_RUN_TOKEN_HEADER, signStagingRunToken } from "@caelo-cms/shared";
import type { OriginHeaders } from "@caelo-cms/site-importer";
import { SYSTEM_ACTOR_ID } from "../audit.js";
import { readStagingHost, stagingGateSecret } from "../deploy/staging-domain.js";

/** How long a capture's staging token lives: a render plus its retries. */
export const CAPTURE_TOKEN_TTL_SECONDS = 10 * 60;

/** The headers a render of `url` sends to its origin, or null when it is not the staging site. */
export type StagingCaptureAccess = (url: string) => Promise<OriginHeaders | null>;

/**
 * The staging access of this admin: reads the staging host on every call
 * (an Owner's change applies at once) and mints a token per render.
 *
 * @throws when `url` is on the staging host but the admin has no gate key
 *   (`CAELO_STAGING_GATE_SECRET`), naming the fix.
 */
export function stagingCaptureAccess(
  adapter: DatabaseAdapter,
  env: Readonly<Record<string, string | undefined>> = process.env,
): StagingCaptureAccess {
  return async (url) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return null;
    }
    const host = await adapter.withAdminTransaction(
      { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "staging-capture-access" },
      (tx) => readStagingHost(tx),
    );
    if (!host || origin !== `https://${host}`) return null;
    const now = Math.floor(Date.now() / 1000);
    const token = await signStagingRunToken(
      stagingGateSecret(env),
      "capture",
      randomUUID(),
      now + CAPTURE_TOKEN_TTL_SECONDS,
      now,
    );
    return { origin, headers: { [STAGING_RUN_TOKEN_HEADER]: token } };
  };
}
