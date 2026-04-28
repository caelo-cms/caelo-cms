// SPDX-License-Identifier: MPL-2.0

/**
 * P6.6 closing pass — Zod schemas for the auth-side forms (setup,
 * login). Lives in @caelo/shared so the SvelteKit route's inline
 * client-side validation helper (`bindZodForm`) and the server-side
 * `users.create_first_owner` / `auth.login` handlers can both
 * consume the same source-of-truth.
 *
 * Kept separate from `content.ts` because auth shape is independent
 * of content-layer evolution; bumping a min-password requirement here
 * shouldn't churn the page schemas.
 */

import { z } from "zod";

export const setupFormSchema = z
  .object({
    displayName: z.string().min(1, "required").max(128),
    email: z.string().email("must be a valid email").max(254),
    password: z.string().min(8, "min 8 characters").max(256),
  })
  .strict();

export const loginFormSchema = z
  .object({
    email: z.string().email("must be a valid email").max(254),
    password: z.string().min(1, "required").max(256),
  })
  .strict();

export type SetupFormInput = z.infer<typeof setupFormSchema>;
export type LoginFormInput = z.infer<typeof loginFormSchema>;
