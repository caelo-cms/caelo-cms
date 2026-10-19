// SPDX-License-Identifier: MPL-2.0

import { z } from "zod";

/**
 * Where a task reads the staged build when the page URL is one only the
 * admin can open (a loopback origin over the private staging bucket): the
 * task serves the same build on its own loopback port and re-addresses
 * `url` from `baseUrl` to it.
 */
export const stagedBuildSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("gcs-staging"),
      /** The deploy run whose files the staging bucket holds under `<runId>/`. */
      runId: z.string().uuid(),
      /** The origin `url` is addressed on. */
      baseUrl: z.string().url(),
    })
    .strict(),
]);

export type StagedBuildSource = z.infer<typeof stagedBuildSourceSchema>;
