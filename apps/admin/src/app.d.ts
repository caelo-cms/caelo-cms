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
        readonly csrfToken: string;
      } | null;
      /** ExecutionContext used by Query API ops in this request. */
      ctx: ExecutionContext;
    }
  }
}
