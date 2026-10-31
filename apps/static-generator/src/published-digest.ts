// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — the digests a published file is known by, computed once and
 * stored, so no build has to read a media or font file to name it.
 *
 *   - `contentSha256` — sha256 of the bytes. Its first
 *     `MEDIA_CONTENT_HASH_HEX_LENGTH` hex chars are the content hash in the
 *     published name (`_assets/<slug>.<hash>.<ext>`, #667), and the
 *     self-hosted and GCS publishers know a file by its content-hashed path.
 *   - `gzipSha256` / `gzipSize` — sha256 and length of the bytes gzipped the
 *     way the Firebase Hosting publisher uploads them. Hosting keys every
 *     file by that hash (`populateFiles`), so the publisher can ask which
 *     media it lacks without reading them, and upload a missing one as a
 *     stream with a known length.
 *   - `profile` — which gzip produced the gzip digests. The same input
 *     gzips to the same bytes only under the same zlib and settings; a Bun
 *     or zlib upgrade may change them, and a stored gzip hash from before
 *     would then name bytes the publisher can no longer produce. Rows whose
 *     profile differs from {@link digestProfile} are digested again before
 *     the next build (`media.rebuild_digests`), never trusted.
 *
 * ONE gzip for both sides: {@link hostingGzip} is what the digests are
 * taken over and what the Firebase publisher streams to Hosting.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, type Gzip } from "node:zlib";

/** The digests of one published file (see the file header). */
export interface PublishedDigest {
  readonly contentSha256: string;
  readonly size: number;
  readonly gzipSha256: string;
  readonly gzipSize: number;
  readonly profile: string;
}

/** Chunk size the gzip is fed with — fixed so every caller feeds it alike. */
const CHUNK_BYTES = 64 * 1024;

/** The gzip every published file is digested and uploaded with. */
export function hostingGzip(): Gzip {
  return createGzip({ level: 9 });
}

/** `bytes` as a stream of {@link CHUNK_BYTES} chunks (the shape a file read has). */
export function chunkedStream(bytes: Uint8Array): Readable {
  let at = 0;
  return new Readable({
    read() {
      if (at >= bytes.byteLength) {
        this.push(null);
        return;
      }
      const end = Math.min(at + CHUNK_BYTES, bytes.byteLength);
      this.push(Buffer.from(bytes.buffer, bytes.byteOffset + at, end - at));
      at = end;
    },
  });
}

/** A file read in {@link CHUNK_BYTES} chunks. */
export function chunkedFileStream(path: string): Readable {
  return createReadStream(path, { highWaterMark: CHUNK_BYTES });
}

/**
 * Digest a stream: the bytes are hashed as they pass and gzipped on the
 * way, nothing is kept. Memory stays at a few chunks whatever the size.
 */
export async function digestStream(source: Readable): Promise<PublishedDigest> {
  const content = createHash("sha256");
  const gzipped = createHash("sha256");
  let size = 0;
  let gzipSize = 0;
  const gzip = hostingGzip();
  const tap = new Writable({
    write(chunk: Buffer, _enc, done) {
      gzipped.update(chunk);
      gzipSize += chunk.byteLength;
      done();
    },
  });
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      content.update(chunk);
      size += chunk.byteLength;
      done(null, chunk);
    },
  });
  await pipeline(source, count, gzip, tap);
  return {
    contentSha256: content.digest("hex"),
    size,
    gzipSha256: gzipped.digest("hex"),
    gzipSize,
    profile: await digestProfile(),
  };
}

/** {@link digestStream} over in-memory bytes (a variant the pipeline just made). */
export function digestBytes(bytes: Uint8Array): Promise<PublishedDigest> {
  return digestStream(chunkedStream(bytes));
}

/** {@link digestStream} over a file on disk (a stored media file, a cached font). */
export function digestFile(path: string): Promise<PublishedDigest> {
  return digestStream(chunkedFileStream(path));
}

/** A fixed sample whose gzip fingerprints the running gzip (text + binary-ish bytes). */
function profileSample(): Uint8Array {
  const out = new Uint8Array(3 * CHUNK_BYTES + 777);
  let x = 0x2545f491;
  for (let i = 0; i < out.length; i += 1) {
    // Half text-like (compressible), half pseudo-random (incompressible).
    if ((i >> 12) % 2 === 0) out[i] = 32 + (i % 90);
    else {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = x & 0xff;
    }
  }
  return out;
}

let profile: Promise<string> | null = null;

/**
 * The fingerprint of this process's {@link hostingGzip}: the first 16 hex
 * chars of the sha256 of a fixed sample gzipped with it. Equal profiles
 * gzip every input to the same bytes.
 */
export function digestProfile(): Promise<string> {
  profile ??= (async () => {
    const hash = createHash("sha256");
    const tap = new Writable({
      write(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        done();
      },
    });
    await pipeline(chunkedStream(profileSample()), hostingGzip(), tap);
    return `gzip9-${hash.digest("hex").slice(0, 16)}`;
  })();
  return profile;
}
