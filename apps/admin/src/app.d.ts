// SPDX-License-Identifier: MPL-2.0

import type { ExecutionContext } from "@caelo/shared";

declare global {
  namespace App {
    interface Locals {
      /** Null when the request is unauthenticated. */
      user: {
        readonly id: string;
        readonly email: string;
        readonly roles: readonly string[];
        readonly permissions: ReadonlySet<string>;
        /** Long-lived per-session secret, server-only. Forms use a derived
         * per-render token via {@link signCsrfToken}; never expose this. */
        readonly csrfSecret: string;
        /** P6.6b — null until the user finishes the first-login tour. */
        readonly onboardedAt: string | null;
      } | null;
      /** ExecutionContext used by Query API ops in this request. */
      ctx: ExecutionContext;
    }
  }
}
