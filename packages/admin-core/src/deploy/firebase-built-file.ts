// SPDX-License-Identifier: MPL-2.0

/**
 * #1088 — read one file of a Firebase Hosting build back.
 *
 * Firebase Hosting has no API that returns a version's file contents (the
 * REST API only lists hashes and takes uploads), so the only place a built
 * file can be read is the channel that serves it: a staging run's preview
 * channel, or the live channel for the site visitors get. The Firebase
 * publisher sets no `cleanUrls`, so every build file is served at exactly
 * its key; a redirect or a 404 therefore means the build has no such file.
 */

import { firebaseFetch, siteName } from "./static-publisher-firebase.js";

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

/** The URL of the site's live channel (what visitors are served). */
export async function firebaseLiveChannelUrl(): Promise<string> {
  const channel = await firebaseFetch<{ url?: string }>(`sites/${siteName()}/channels/live`);
  if (!channel.url) {
    throw new Error(
      `firebase-hosting: the live channel of site ${siteName()} reported no url — nothing has been published live yet`,
    );
  }
  return channel.url;
}
