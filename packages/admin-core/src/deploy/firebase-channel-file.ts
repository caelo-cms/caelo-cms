// SPDX-License-Identifier: MPL-2.0

/**
 * #1088 — read one file of a Firebase Hosting build back from the channel
 * that serves it (see firebase-built-file.ts). No imports of the publisher,
 * so the publisher itself can read live files (#1155).
 */

/** A file a channel served, or why there is none. */
export type FirebaseBuiltFile =
  | { readonly found: true; readonly body: Buffer }
  | { readonly found: false; readonly status: number };

/**
 * Fetch `key` (a build path without leading slash, e.g. `about/index.html`)
 * from a channel origin.
 *
 * @param origin - the channel's URL (`https://<site>--<channel>.web.app`).
 * @param fetchImpl - injectable for tests.
 * @throws when the origin cannot be reached at all (network failure).
 */
export async function readFirebaseBuiltFile(
  origin: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FirebaseBuiltFile> {
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  const res = await fetchImpl(new URL(key, base), { redirect: "manual" });
  if (res.status !== 200) {
    // Drain the body so the connection is released.
    await res.arrayBuffer().catch(() => undefined);
    return { found: false, status: res.status };
  }
  return { found: true, body: Buffer.from(await res.arrayBuffer()) };
}
