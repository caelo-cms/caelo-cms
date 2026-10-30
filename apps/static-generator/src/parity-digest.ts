// SPDX-License-Identifier: MPL-2.0

/**
 * #650 / #1271 — the content digests Publish live's parity guard compares
 * (admin-core deploy/build-parity.ts), taken by the generator while it
 * writes each file, from the bytes it already holds.
 *
 * Before #1271 the admin read every file of a finished build again to hash
 * it — a third read of the whole site after the generator's write and the
 * publisher's upload, and with media in the build, every image. Now:
 *   - a page or other written file is digested in memory as it is written;
 *   - a referenced media or font file contributes its stored content hash
 *     (the same value a read of its bytes would give);
 *   - the few small files written by other passes are read at the end.
 *
 * Two manifests per build: `plain` (the bytes as written — what a live
 * rebuild is compared with), and, for a build rendered with another origin
 * than the stored site URL (a Stage on a provider with its own staging host),
 * `normalised`: every file with that origin swapped back to the live one, the
 * manifest the Stage records for Publish live to compare against.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type AssetReference, BUILD_INTERNAL_FILES, PARITY_FILE } from "./asset-references.js";

/**
 * Build artefacts that legitimately differ between two builds of the same
 * content: robots.txt follows the target's robots policy, and the deploy
 * manifest carries the target, environment, run id and build time.
 */
export const PER_BUILD_FILES: ReadonlySet<string> = new Set([
  "robots.txt",
  "routing-manifest.json",
]);

/** `relative path → content hash`. Paths use `/` and no leading slash. */
export type BuildManifest = Record<string, string>;

/** A pure text transform applied to a staging file before hashing. */
export type ContentNormaliser = (content: string) => string;

function hostOf(origin: string): string {
  return new URL(origin).host;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The normaliser that turns staging-host content into live-host content:
 * every occurrence of the staging origin becomes the live origin, and
 * every other bare staging host (inside JSON-escaped or URL-encoded
 * URLs, `og:url` without a scheme, …) becomes the live host.
 *
 * Content is handled as latin1 so every byte maps to one char and back —
 * binary files pass through unchanged unless they literally contain the
 * host bytes.
 *
 * @example
 *   hostNormaliser("https://staging.example.com", "https://www.example.com")(
 *     '<link rel="canonical" href="https://staging.example.com/a/">')
 *   // → '<link rel="canonical" href="https://www.example.com/a/">'
 */
export function hostNormaliser(stagingUrl: string, liveUrl: string): ContentNormaliser {
  const stagingOrigin = originOf(stagingUrl);
  const liveOrigin = originOf(liveUrl);
  const stagingHost = hostOf(stagingUrl);
  const liveHost = hostOf(liveUrl);
  if (stagingHost === liveHost) {
    throw new Error(
      `the staging host and the live host are both ${liveHost} — staging must have its own host (staging.<domain>) for a host-swapped build to differ from live`,
    );
  }
  // ONE pass over the content, origin before bare host at each position,
  // so a replacement is never reprocessed: chained replaces turned staging
  // `example.com` → live `www.example.com` into `www.www.example.com`.
  // A bare host directly after `.` or `-` is part of a longer name (e.g.
  // `mail.example.com` when staging is `example.com`) and stays as it is.
  const pattern = new RegExp(
    `${escapeRegExp(stagingOrigin)}|(?<![.\\-])${escapeRegExp(stagingHost)}`,
    "g",
  );
  return (content) =>
    content.replace(pattern, (match) => (match === stagingOrigin ? liveOrigin : liveHost));
}

/** The parity hash of some bytes (sha256, base64url, 32 chars). */
export function parityHash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("base64url").slice(0, 32);
}

/** {@link parityHash} of a file known by its stored sha256 (hex) — equal to hashing its bytes. */
export function parityHashOfSha256(sha256Hex: string): string {
  return Buffer.from(sha256Hex, "hex").toString("base64url").slice(0, 32);
}

const parityFileSchema = z
  .object({
    plain: z.record(z.string(), z.string()),
    normalised: z.record(z.string(), z.string()).nullable(),
  })
  .strict();

/** The parsed {@link PARITY_FILE}. */
export type BuildParity = z.infer<typeof parityFileSchema>;

/**
 * Collects the parity digests of one build. {@link record} takes a file's
 * content as it is written; {@link finish} adds the referenced assets and
 * whatever was written without passing through here, then writes
 * {@link PARITY_FILE}.
 */
export class ParityRecorder {
  readonly #normalise: ContentNormaliser | null;
  readonly #plain = new Map<string, string>();
  readonly #normalised = new Map<string, string>();

  /** @param normalise staging → live swap for a build with its own staging host, else null. */
  constructor(normalise: ContentNormaliser | null) {
    this.#normalise = normalise;
  }

  /** Digest one file the build writes (`content` exactly as written). */
  record(relPath: string, content: string | Uint8Array): void {
    if (PER_BUILD_FILES.has(relPath) || BUILD_INTERNAL_FILES.has(relPath)) return;
    this.#plain.set(relPath, parityHash(content));
    if (this.#normalise) {
      const latin1 =
        typeof content === "string"
          ? Buffer.from(content, "utf8").toString("latin1")
          : Buffer.from(content).toString("latin1");
      this.#normalised.set(relPath, parityHash(Buffer.from(this.#normalise(latin1), "latin1")));
    }
  }

  /** Whether `relPath` was recorded. */
  has(relPath: string): boolean {
    return this.#plain.has(relPath);
  }

  /**
   * Add the referenced assets (by stored hash; never host-dependent) and
   * read the build files in `unrecorded` (the small files other passes
   * wrote), then write the digests to the build.
   */
  async finish(args: {
    readonly buildDir: string;
    readonly assets: readonly AssetReference[];
    readonly unrecorded: readonly string[];
  }): Promise<void> {
    for (const a of args.assets) {
      const h = parityHashOfSha256(a.contentSha256);
      this.#plain.set(a.path, h);
      if (this.#normalise) this.#normalised.set(a.path, h);
    }
    for (const rel of args.unrecorded) {
      if (this.has(rel)) continue;
      this.record(rel, await readFile(join(args.buildDir, rel)));
    }
    const sorted = (m: Map<string, string>) =>
      Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const parity: BuildParity = {
      plain: sorted(this.#plain),
      normalised: this.#normalise ? sorted(this.#normalised) : null,
    };
    await writeFile(join(args.buildDir, PARITY_FILE), JSON.stringify(parity), "utf8");
  }
}

/**
 * Read a build's parity digests. A build without them is not one this
 * generator produced: fail loudly rather than skip the guard.
 */
export async function readBuildParity(buildDir: string): Promise<BuildParity> {
  let raw: string;
  try {
    raw = await readFile(join(buildDir, PARITY_FILE), "utf8");
  } catch (e) {
    throw new Error(
      `${join(buildDir, PARITY_FILE)} is missing (${(e as Error).message}). The static generator writes it on every build; re-run the build.`,
    );
  }
  return parityFileSchema.parse(JSON.parse(raw));
}
