// SPDX-License-Identifier: MPL-2.0

/**
 * #1330 — an in-memory staging bucket with exactly the Cloud Storage calls
 * the staging slots make (staging-slots.ts, the Firebase publisher's slot
 * uploads, the audit's slot source), for tests that must not reach GCS.
 */

import { Writable } from "node:stream";
import type { Bucket, File } from "@google-cloud/storage";

/** The fake and what was written into it. */
export interface FakeStagingBucket {
  readonly bucket: Bucket;
  readonly objects: Map<string, Buffer>;
  readonly writes: string[];
}

/** A fresh, empty fake staging bucket. */
export function fakeStagingBucket(): FakeStagingBucket {
  const objects = new Map<string, Buffer>();
  const writes: string[] = [];
  const file = (name: string): File =>
    ({
      name,
      async exists() {
        return [objects.has(name)];
      },
      async download() {
        const body = objects.get(name);
        if (!body) throw Object.assign(new Error(`No such object: ${name}`), { code: 404 });
        return [body];
      },
      async delete() {
        objects.delete(name);
        return [{}];
      },
      async save(body: string | Buffer | Uint8Array) {
        writes.push(name);
        objects.set(name, Buffer.from(body));
        return [{}];
      },
      createWriteStream() {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _enc, done) {
            chunks.push(Buffer.from(chunk));
            done();
          },
          final(done) {
            writes.push(name);
            objects.set(name, Buffer.concat(chunks));
            done();
          },
        });
      },
    }) as unknown as File;
  const bucket = {
    name: "fake-staging",
    file,
    async getFiles({ prefix }: { prefix?: string } = {}) {
      return [[...objects.keys()].filter((k) => k.startsWith(prefix ?? "")).map((k) => file(k))];
    },
  } as unknown as Bucket;
  return { bucket, objects, writes };
}
