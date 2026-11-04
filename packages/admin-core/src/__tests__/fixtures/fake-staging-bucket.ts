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

/**
 * A fresh, empty fake staging bucket. `keepBodies: false` stores only
 * manifests (a memory test must not count the fake's own copies).
 */
export function fakeStagingBucket(opts: { keepBodies?: boolean } = {}): FakeStagingBucket {
  const keep = (name: string) => opts.keepBodies !== false || name.endsWith(".manifest.json");
  const objects = new Map<string, Buffer>();
  const generations = new Map<string, number>();
  let generation = 0;
  const writes: string[] = [];
  const stored = (name: string, body: Buffer) => {
    objects.set(name, body);
    generations.set(name, ++generation);
  };
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
        generations.delete(name);
        return [{}];
      },
      async getMetadata() {
        if (!objects.has(name)) {
          throw Object.assign(new Error(`No such object: ${name}`), { code: 404 });
        }
        return [{ generation: String(generations.get(name)) }];
      },
      async save(body: string | Buffer | Uint8Array) {
        writes.push(name);
        stored(name, keep(name) ? Buffer.from(body) : Buffer.alloc(0));
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
            stored(name, keep(name) ? Buffer.concat(chunks) : Buffer.alloc(0));
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
