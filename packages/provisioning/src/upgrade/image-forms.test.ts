// SPDX-License-Identifier: MPL-2.0

/**
 * #1025: every digest a release image is known by, read from the signed
 * manifest or from the content-checked index in the fixed mirror. Run
 * against the v0.10.64 indexes exactly as the mirror serves them.
 */

import { describe, expect, it } from "bun:test";
import {
  ADMIN_AMD64,
  ADMIN_ATTESTATION,
  ADMIN_INDEX,
  fakeRegistryFetch,
  GATEWAY_AMD64,
  GATEWAY_INDEX,
  LIVE_INDEXES,
} from "./__tests__/live-indexes.js";
import { createReleaseImageForms, formsFromIndexJson, platformDigestsOf } from "./image-forms.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const MIRROR = "https://europe-west1-docker.pkg.dev/v2/caelo-website/caelo-cms-images";

describe("the fixtures", () => {
  it("are the bytes of the indexes they are named after", async () => {
    for (const [digest, bytes] of Object.entries(LIVE_INDEXES)) {
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      expect(`sha256:${Buffer.from(hash).toString("hex")}`).toBe(digest);
    }
  });
});

describe("createReleaseImageForms().ofIndex", () => {
  it("regression #1025: the v0.10.64 admin index lists its linux/amd64 manifest, not the attestation", async () => {
    const calls: string[] = [];
    const forms = createReleaseImageForms(fakeRegistryFetch(calls));
    const r = await forms.ofIndex("admin", ADMIN_INDEX);
    expect(r).toEqual({ ok: true, digests: [ADMIN_INDEX, ADMIN_AMD64], amd64: ADMIN_AMD64 });
    expect(r.ok && r.digests.includes(ADMIN_ATTESTATION)).toBe(false);
    // Fetched by digest from the fixed mirror.
    expect(calls).toEqual([`${MIRROR}/admin/manifests/${ADMIN_INDEX}`]);
    expect(await forms.ofIndex("gateway", GATEWAY_INDEX)).toEqual({
      ok: true,
      digests: [GATEWAY_INDEX, GATEWAY_AMD64],
      amd64: GATEWAY_AMD64,
    });
  });

  it("reads each index once per instance", async () => {
    const calls: string[] = [];
    const forms = createReleaseImageForms(fakeRegistryFetch(calls));
    await forms.ofIndex("admin", ADMIN_INDEX);
    await forms.ofIndex("admin", ADMIN_INDEX);
    expect(calls).toHaveLength(1);
  });

  it("refuses bytes that do not hash to the digest asked for (a tampering registry)", async () => {
    const forged = new TextEncoder().encode(
      JSON.stringify({
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [{ digest: D("6"), platform: { os: "linux", architecture: "amd64" } }],
      }),
    );
    const forms = createReleaseImageForms(fakeRegistryFetch([], { tampered: forged }));
    const r = await forms.ofIndex("admin", ADMIN_INDEX);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.transient).toBe(false);
    expect(r.ok ? "" : r.message).toContain("does not match its digest");
  });

  it("an outage is transient, a missing index is not", async () => {
    for (const [opts, transient] of [
      [{ status: 503 }, true],
      [{ status: 429 }, true],
      [{ unreachable: true }, true],
      [{ status: 404 }, false],
    ] as const) {
      const r = await createReleaseImageForms(fakeRegistryFetch([], opts)).ofIndex(
        "admin",
        ADMIN_INDEX,
      );
      expect(r.ok ? null : r.transient).toBe(transient);
    }
  });

  it("follows the registry's anonymous Bearer challenge", async () => {
    const calls: string[] = [];
    const inner = fakeRegistryFetch(calls);
    const challenged = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://token.example/")) {
        return Response.json({ token: "anon" });
      }
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer anon") {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="https://token.example/t",service="x"' },
        });
      }
      return inner(input, init);
    }) as typeof fetch;
    const r = await createReleaseImageForms(challenged).ofIndex("admin", ADMIN_INDEX);
    expect(r.ok && r.amd64).toBe(ADMIN_AMD64);
  });
});

describe("createReleaseImageForms().of", () => {
  it("takes the signed platform digests without a registry round trip", async () => {
    const calls: string[] = [];
    const forms = createReleaseImageForms(fakeRegistryFetch(calls));
    const m = {
      version: "0.10.66",
      digests: { admin: D("a"), gateway: D("b"), ops: D("c") },
      platformDigests: { admin: D("1"), gateway: D("2"), ops: D("3") },
    };
    expect(await forms.of(m, "gateway")).toEqual({
      ok: true,
      digests: [D("b"), D("2")],
      amd64: D("2"),
    });
    expect(calls).toEqual([]);
  });

  it("reads the index for a release signed before the field", async () => {
    const forms = createReleaseImageForms(fakeRegistryFetch([]));
    const m = {
      version: "0.10.64",
      digests: { admin: ADMIN_INDEX, gateway: GATEWAY_INDEX, ops: D("c") },
    };
    expect(await forms.of(m, "admin")).toMatchObject({ ok: true, amd64: ADMIN_AMD64 });
  });
});

describe("formsFromIndexJson", () => {
  it("a plain image manifest is its own platform form", () => {
    const plain = { mediaType: "application/vnd.oci.image.manifest.v1+json", config: {} };
    expect(formsFromIndexJson(D("7"), plain)).toEqual({
      ok: true,
      digests: [D("7")],
      amd64: D("7"),
    });
  });

  it("an index without a linux/amd64 manifest has no amd64 form", () => {
    const arm = {
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{ digest: D("8"), platform: { os: "linux", architecture: "arm64" } }],
    };
    expect(formsFromIndexJson(D("7"), arm)).toEqual({
      ok: true,
      digests: [D("7"), D("8")],
      amd64: null,
    });
  });

  it("an unreadable shape is a non-transient error", () => {
    const r = formsFromIndexJson(D("7"), { manifests: [{ digest: "nope" }] });
    expect(r.ok ? null : r.transient).toBe(false);
  });
});

describe("platformDigestsOf", () => {
  it("reads the linux/amd64 form of both indexes", async () => {
    const forms = createReleaseImageForms(fakeRegistryFetch([]));
    expect(await platformDigestsOf({ admin: ADMIN_INDEX, gateway: GATEWAY_INDEX }, forms)).toEqual({
      ok: true,
      platformDigests: { admin: ADMIN_AMD64, gateway: GATEWAY_AMD64 },
    });
  });

  it("prefers the manifest's signed forms when it signs these very indexes", async () => {
    const calls: string[] = [];
    const forms = createReleaseImageForms(fakeRegistryFetch(calls));
    const m = {
      version: "0.10.66",
      digests: { admin: D("a"), gateway: D("b"), ops: D("c") },
      platformDigests: { admin: D("1"), gateway: D("2"), ops: D("3") },
    };
    expect(await platformDigestsOf({ admin: D("a"), gateway: D("b") }, forms, m)).toEqual({
      ok: true,
      platformDigests: { admin: D("1"), gateway: D("2") },
    });
    expect(calls).toEqual([]);
  });

  it("says why when an index cannot be read", async () => {
    const forms = createReleaseImageForms(fakeRegistryFetch([], { status: 503 }));
    const r = await platformDigestsOf({ admin: ADMIN_INDEX, gateway: GATEWAY_INDEX }, forms);
    expect(r.ok ? "" : r.message).toContain("HTTP 503");
  });
});
