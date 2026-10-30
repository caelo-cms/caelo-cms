// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1254 — no op holds a transaction across sharp, storage or a mail
 * provider. `media.regenerate_variants`, `themes.set_asset` (favicon
 * rendition), `themes.ensure_favicon_rendition` and
 * `email_config.send_test` used to run that work inside their op
 * transaction, so every slow bucket read, resize or SMTP/HTTP round trip
 * pinned a pooled connection idle-in-transaction.
 *
 * The probe: the storage adapter and `fetch` stand-ins open a cms_admin
 * transaction of their own from inside the slow step. The adapter's pool
 * guard (#1210) refuses that with `NestedPoolCheckoutError` while the
 * calling chain holds a transaction, so a probe that succeeds proves the
 * op held none at that moment. The ops' results, rows and audit rows stay
 * what they were.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, FAVICON_VARIANT } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { LocalVolumeAdapter, type MediaStorageAdapter, setMediaStorage } from "../media/storage.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "media-io-outside-tx",
};
/** Unique per run (hex of the clock): themes and media outlive a file reset. */
const RUN = Date.now().toString(16);
const SHA_PREFIX = `1254${RUN}`;
const THEME_SLUG = `io1254-theme-${RUN}`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let storageRoot = "";
let previousActiveSlug: string | null = null;

/** Every probe's outcome: "free" or the error a held transaction raised. */
const probes: string[] = [];

/** Open a transaction of our own; refused while the caller's chain holds one. */
async function probe(): Promise<void> {
  try {
    await adapter.withAdminTransaction(SYS, (t) => t.execute(sql`SELECT 1`), {
      holder: "io1254.probe",
    });
    probes.push("free");
  } catch (e) {
    probes.push(`${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`);
  }
}

/** Local storage whose every read and write first probes for a held transaction. */
function probingStorage(inner: MediaStorageAdapter): MediaStorageAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === "get" || prop === "put") && typeof value === "function") {
        return async (...args: unknown[]) => {
          await probe();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL!);
  try {
    return (await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
  } finally {
    await db.end();
  }
}

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A PNG asset with only its original stored. */
async function origOnlyPng(n: number, width: number): Promise<string> {
  const sha = `${SHA_PREFIX}${String(n).padStart(60 - RUN.length, "0")}`;
  const bytes = new Uint8Array(
    await sharp({
      create: { width, height: width, channels: 3, background: { r: 10, g: 90, b: 160 } },
    })
      .png()
      .toBuffer(),
  );
  const storageKey = `${sha}/orig.png`;
  await new LocalVolumeAdapter(storageRoot).put(storageKey, bytes, "image/png");
  const r = await op<{ assetId: string }>("media.upload", {
    sha256: sha,
    originalName: `io1254-${n}.png`,
    mime: "image/png",
    sizeBytes: bytes.byteLength,
    width,
    height: width,
    alt: "",
    storageKey,
    variants: [
      {
        variant: "orig",
        format: "png",
        width,
        height: width,
        sizeBytes: bytes.byteLength,
        storageKey,
      },
    ],
  });
  return r.assetId;
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), "caelo-io1254-"));
  setMediaStorage(probingStorage(new LocalVolumeAdapter(storageRoot)), "local");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await op("themes.duplicate", {
    sourceSlug: "site-default",
    newSlug: THEME_SLUG,
    newDisplayName: "IO outside tx",
  });
  const active = await asSystem(
    (tx) =>
      tx`SELECT slug FROM themes WHERE is_active = true LIMIT 1` as Promise<{ slug: string }[]>,
  );
  previousActiveSlug = active[0]?.slug ?? null;
  await asSystem(async (tx) => {
    await tx`UPDATE themes SET is_active = false WHERE is_active = true`;
    await tx`UPDATE themes SET is_active = true WHERE slug = ${THEME_SLUG}`;
  });
});

afterAll(async () => {
  if (previousActiveSlug) {
    await asSystem(async (tx) => {
      await tx`UPDATE themes SET is_active = false WHERE is_active = true`;
      await tx`UPDATE themes SET is_active = true WHERE slug = ${previousActiveSlug}`;
    });
  }
  await adapter.close();
  rmSync(storageRoot, { recursive: true, force: true });
});

describe("slow media and mail work holds no transaction (#1254)", () => {
  it("media.regenerate_variants reads, resizes and stores between short transactions", async () => {
    const assetId = await origOnlyPng(1, 1800);
    probes.length = 0;
    const out = await op<{ results: { status: string; addedVariants: string[] }[] }>(
      "media.regenerate_variants",
      { assetIds: [assetId] },
    );
    expect(out.results[0]?.status).toBe("regenerated");
    expect(out.results[0]?.addedVariants.length).toBeGreaterThan(0);
    expect(probes.length).toBeGreaterThan(1);
    expect(probes.filter((p) => p !== "free")).toEqual([]);
    const rows = await asSystem(
      (tx) =>
        tx`SELECT variant FROM media_variants WHERE asset_id = ${assetId}::uuid ORDER BY variant` as Promise<
          { variant: string }[]
        >,
    );
    expect(rows.map((r) => r.variant)).toEqual(
      ["orig", ...(out.results[0]?.addedVariants ?? [])].sort(),
    );
  });

  it("two concurrent regenerations of one asset record each variant once", async () => {
    const assetId = await origOnlyPng(2, 1800);
    const [a, b] = await Promise.all([
      op<{ results: { addedVariants: string[] }[] }>("media.regenerate_variants", {
        assetIds: [assetId],
      }),
      op<{ results: { addedVariants: string[] }[] }>("media.regenerate_variants", {
        assetIds: [assetId],
      }),
    ]);
    const added = [...(a.results[0]?.addedVariants ?? []), ...(b.results[0]?.addedVariants ?? [])];
    expect(new Set(added).size).toBe(added.length);
    const rows = await asSystem(
      (tx) =>
        tx`SELECT variant FROM media_variants WHERE asset_id = ${assetId}::uuid` as Promise<
          { variant: string }[]
        >,
    );
    expect(rows.length).toBe(added.length + 1);
  });

  it("themes.set_asset makes the favicon rendition outside its transaction, and the Stage's ensure op too", async () => {
    const faviconId = await origOnlyPng(3, 512);
    probes.length = 0;
    await op("themes.set_asset", { slot: "favicon", mediaId: faviconId });
    expect(probes.length).toBeGreaterThan(1);
    expect(probes.filter((p) => p !== "free")).toEqual([]);
    const rendition = () =>
      asSystem(
        (tx) =>
          tx`SELECT 1 FROM media_variants WHERE asset_id = ${faviconId}::uuid AND variant = ${FAVICON_VARIANT}` as Promise<
            unknown[]
          >,
      );
    expect((await rendition()).length).toBe(1);

    // A favicon bound before the rendition rule: the Stage's step makes it.
    await asSystem(
      (tx) =>
        tx`DELETE FROM media_variants WHERE asset_id = ${faviconId}::uuid AND variant = ${FAVICON_VARIANT}`,
    );
    probes.length = 0;
    const ensured = await op<{ created: boolean; mediaId: string }>(
      "themes.ensure_favicon_rendition",
      {},
    );
    expect(ensured).toEqual({ created: true, mediaId: faviconId });
    expect(probes.length).toBeGreaterThan(1);
    expect(probes.filter((p) => p !== "free")).toEqual([]);
    expect((await rendition()).length).toBe(1);
    const audits = await asSystem(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM audit_events
            WHERE operation = 'themes.ensure_favicon_rendition' AND entity_id = ${faviconId}::uuid` as Promise<
          { n: number }[]
        >,
    );
    expect(audits[0]?.n).toBe(1);
    // In place now: nothing more to make, nothing written.
    expect(await op("themes.ensure_favicon_rendition", {})).toEqual({
      created: false,
      mediaId: faviconId,
    });
  });

  it("email_config.send_test calls the provider with no transaction held", async () => {
    const before = await op<{
      config: { transport: string; fromAddress: string; config: Record<string, unknown> };
    }>("email_config.get", {});
    const realFetch = globalThis.fetch;
    probes.length = 0;
    globalThis.fetch = (async () => {
      await probe();
      return new Response(JSON.stringify({ id: "io1254-message" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      await op("email_config.set", {
        transport: "resend",
        fromAddress: "Site <noreply@example.com>",
        config: { apiKey: "re_io1254_key" },
      });
      const sent = await op<{ messageId: string; transport: string }>("email_config.send_test", {
        to: "team@example.com",
      });
      expect(sent).toEqual({ messageId: "io1254-message", transport: "resend" });
      expect(probes).toEqual(["free"]);
      const audits = await asSystem(
        (tx) =>
          tx`SELECT succeeded FROM audit_events
              WHERE operation = 'email_config.send_test' AND request_id = ${SYS.requestId}` as Promise<
            { succeeded: boolean }[]
          >,
      );
      expect(audits.map((a) => a.succeeded)).toContain(true);
    } finally {
      globalThis.fetch = realFetch;
      await op("email_config.set", {
        transport: before.config.transport,
        fromAddress: before.config.fromAddress,
        config: before.config.config,
      });
    }
  });
});
