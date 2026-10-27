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

export { readFirebaseBuiltFile } from "./firebase-channel-file.js";
export { firebaseLiveChannelUrl } from "./static-publisher-firebase.js";
