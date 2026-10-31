// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — where the files of a build go.
 *
 * Self-hosted serves the build directory (`current/` is its mirror), so the
 * build is written to disk ({@link DiskOutput}). An uploading publisher
 * (Firebase, GCS) does not need the files on the admin's disk at all, and on
 * Cloud Run that disk is memory (tmpfs): a 50,000-page build written there
 * first would take gigabytes. So the generator hands each file to the admin
 * as it is written ({@link StreamOutput}, over the generator's stdio), the
 * admin's publisher puts it into the provider's staging version right away,
 * and only the build's description stays local: the asset references and
 * the parity digests (`BUILD_INTERNAL_FILES`).
 *
 * Every pass writes through the one output, so the parity digests and the
 * list of served paths are complete by construction.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** One file the build writes. */
export interface BuildFileWrite {
  /** Build-relative, `/`-separated — the served path. */
  readonly relPath: string;
  readonly content: string | Uint8Array;
  /**
   * The Content-Type a provider must serve it with when its extension does
   * not say (a bare-slug page in the `no-extension` URL style).
   */
  readonly contentType?: string;
}

/** Where the build's served files go. */
export interface BuildOutput {
  /** True when the files land in the build directory (self-hosted). */
  readonly local: boolean;
  /** Write one served file. Resolves once the destination accepted it. */
  write(file: BuildFileWrite): Promise<void>;
}

/** Writes every file into the build directory. */
export class DiskOutput implements BuildOutput {
  readonly local = true;
  constructor(readonly buildDir: string) {}

  async write(file: BuildFileWrite): Promise<void> {
    const path = resolve(this.buildDir, file.relPath);
    if (!path.startsWith(`${this.buildDir}/`)) {
      throw new Error(`static-generator: output path "${file.relPath}" escapes build directory`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
}

/** A file event sent to the admin, and its answer. */
export interface StreamedFile {
  readonly kind: "file";
  readonly id: number;
  readonly relPath: string;
  /** base64 of the bytes. */
  readonly body: string;
  readonly contentType?: string;
}

/**
 * Hands each file to the admin over the generator's stdio and waits for the
 * admin's acknowledgement (the publisher accepted it). At most
 * {@link StreamOutput.WINDOW} files are in flight, so the bytes in the pipe
 * and in both processes stay bounded whatever the size of the site.
 */
export class StreamOutput implements BuildOutput {
  /** Files sent but not yet acknowledged. */
  static readonly WINDOW = 64;
  readonly local = false;
  readonly #send: (event: StreamedFile) => void;
  readonly #pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  readonly #waiting: (() => void)[] = [];
  #nextId = 0;
  /** Why the channel closed, once it did. */
  #closed: string | null = null;

  /** @param send writes one event line to the admin. */
  constructor(send: (event: StreamedFile) => void) {
    this.#send = send;
  }

  async write(file: BuildFileWrite): Promise<void> {
    while (this.#closed === null && this.#pending.size >= StreamOutput.WINDOW) {
      await new Promise<void>((r) => this.#waiting.push(r));
    }
    if (this.#closed !== null) throw new Error(this.#closed);
    const id = ++this.#nextId;
    const bytes =
      typeof file.content === "string"
        ? Buffer.from(file.content, "utf8")
        : Buffer.from(file.content);
    const done = new Promise<void>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#send({
      kind: "file",
      id,
      relPath: file.relPath,
      body: bytes.toString("base64"),
      ...(file.contentType ? { contentType: file.contentType } : {}),
    });
    await done;
  }

  /** The admin's answer to file `id`. */
  acknowledge(id: number, error: string | null): void {
    const waiter = this.#pending.get(id);
    if (!waiter) return;
    this.#pending.delete(id);
    if (error === null) waiter.resolve();
    else waiter.reject(new Error(error));
    this.#waiting.shift()?.();
  }

  /** The admin went away: fail everything in flight. */
  close(reason: string): void {
    this.#closed = reason;
    for (const w of this.#pending.values()) w.reject(new Error(reason));
    this.#pending.clear();
    for (const w of this.#waiting.splice(0)) w();
  }
}
