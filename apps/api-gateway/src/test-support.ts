// SPDX-License-Identifier: MPL-2.0

/**
 * Test support for the gateway's integration suites.
 *
 * Live origin (#1326): the gateway takes plugin posts only from a live
 * site origin the admin published. The integration suites register one
 * public domain, so the next projection publish carries
 * {@link TEST_LIVE_ORIGIN}, and send it as `Origin`. A domains row, not the
 * base URL: the test preload truncates `domains` per file but keeps
 * `site_defaults`, so nothing leaks into another suite.
 */

import { SQL } from "bun";

/** The `Origin` the suites post with. */
export const TEST_LIVE_ORIGIN = "https://localhost";

/** Register `localhost` as a public domain in cms_admin (idempotent). */
export async function registerTestLiveOrigin(adminUrl: string): Promise<void> {
  const sql = new SQL(adminUrl);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO domains (hostname, kind) VALUES ('localhost', 'public')
               ON CONFLICT (hostname) DO NOTHING`;
    });
  } finally {
    await sql.end();
  }
}

/**
 * Run `fn` and return it with everything it logged through `console.error`:
 * since #1326 a visitor's error answer is `{ kind, requestId }`, and the
 * details the suites assert live in the gateway's log under that id.
 */
export async function withErrorLog<T>(fn: () => Promise<T>): Promise<{ value: T; log: string }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), log: lines.join("\n") };
  } finally {
    console.error = original;
  }
}
