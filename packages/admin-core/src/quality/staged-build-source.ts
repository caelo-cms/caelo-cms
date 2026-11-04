// SPDX-License-Identifier: MPL-2.0

import { z } from "zod";

/**
 * Where a task reads the staged build when the page URL is one only the
 * admin can open (a loopback origin over the private staging bucket): the
 * task serves the same build on its own loopback port and re-addresses
 * `url` from `baseUrl` to it. Plugin calls are answered with the staging
 * stub there (staged-origin.ts), never forwarded.
 */
export const stagedBuildSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      /** #1330 — the run's complete files in a slot of the private staging bucket. */
      kind: z.literal("staging-slot"),
      /** The slot (`_slots/a`); the task refuses it when it holds another run. */
      location: z.string().regex(/^_slots\/[ab]$/),
      runId: z.string().uuid(),
      /** The origin `url` is addressed on. */
      baseUrl: z.string().url(),
    })
    .strict(),
]);

export type StagedBuildSource = z.infer<typeof stagedBuildSourceSchema>;
