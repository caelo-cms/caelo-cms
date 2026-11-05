// SPDX-License-Identifier: MPL-2.0

/**
 * What the CLI-owned backend services on `gcp` (the MCP-Auth-Proxy's and the
 * staging gateway's) need so a serverless NEG can be added to them.
 *
 * `gcloud compute backend-services create --protocol=HTTPS` sets the port
 * name to `https`, and `add-backend` then refuses the NEG: "Port name is not
 * supported for a backend service with Serverless network endpoint groups".
 * The stack's backends carry `protocol: HTTPS` with the port name `http`,
 * which Google accepts; the flags below give these two the same shape.
 */

import type { GcloudRunner } from "./gcloud-retry.js";

/** The `backend-services create` flags of a backend that will hold a serverless NEG. */
export const SERVERLESS_BACKEND_CREATE_FLAGS: readonly string[] = [
  "--protocol=HTTPS",
  "--port-name=http",
];

/**
 * Repair a backend an earlier run created with the `https` port name, so
 * `add-backend` can succeed. No call for any other backend.
 *
 * @returns whether it repaired the backend; `error` says what gcloud answered
 */
export async function repairServerlessBackendPort(
  run: GcloudRunner,
  backend: { readonly name: string; readonly portName: string | undefined },
  project: string,
): Promise<{ readonly repaired: boolean; readonly error?: string }> {
  if (backend.portName !== "https") return { repaired: false };
  const set = await run([
    "compute",
    "backend-services",
    "update",
    backend.name,
    "--global",
    project,
    "--port-name=http",
    "--quiet",
  ]);
  return set.ok
    ? { repaired: true }
    : { repaired: false, error: `set ${backend.name}'s port name: ${set.stderr.trim()}` };
}
