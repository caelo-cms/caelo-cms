// SPDX-License-Identifier: MPL-2.0

/**
 * The v0.10.64 admin + gateway image indexes exactly as the release mirror
 * serves them (fixtures/, byte for byte), and a fake `fetch` that serves
 * them by digest — the shapes of #1025: each index lists its linux/amd64
 * manifest plus one buildx attestation manifest, and Cloud Run records the
 * linux/amd64 digest for a serving revision.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

/** v0.10.64 admin: the index the signed manifest names, and what it lists. */
export const ADMIN_INDEX =
  "sha256:bcda1725a5390c910c56cfedb6f55bc4f38cebb0231e9e9b4297bb5c08aec3e0";
export const ADMIN_AMD64 =
  "sha256:2e75b714662ec6b17d32666b546378e2850920950076c4e911deddc05596e656";
export const ADMIN_ATTESTATION =
  "sha256:06f9defdb92e8252e9faab8fcb8fb340d3949d5cdec09e06b42905ade7ba30c0";
/** v0.10.64 gateway. */
export const GATEWAY_INDEX =
  "sha256:fbb0be7a106f75c25e44bca1898fd56af27d11fa599659afe55e4f6ffaeca4a3";
export const GATEWAY_AMD64 =
  "sha256:d24f2675d43e7891f217938c74475e9c31a64ffda0c96cf4fbb0a3f73e31367e";

/** The index bytes, by digest. */
export const LIVE_INDEXES: Readonly<Record<string, Uint8Array<ArrayBuffer>>> = {
  [ADMIN_INDEX]: fixture("admin-0.10.64-index.json"),
  [GATEWAY_INDEX]: fixture("gateway-0.10.64-index.json"),
};

/** How the fake registry answers. */
export interface FakeRegistryOptions {
  /** Answer every request with this HTTP status instead. */
  readonly status?: number;
  /** Throw (network failure) instead of answering. */
  readonly unreachable?: boolean;
  /** Serve these bytes for every digest (a tampering registry). */
  readonly tampered?: Uint8Array<ArrayBuffer>;
  /** Index bytes to serve besides {@link LIVE_INDEXES}. */
  readonly extra?: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
}

/** A `fetch` serving the mirror's `/v2/<repo>/manifests/<digest>`; records each URL in `calls`. */
export function fakeRegistryFetch(calls: string[], opts: FakeRegistryOptions = {}): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (opts.unreachable) throw new Error("getaddrinfo ENOTFOUND");
    if (opts.status) return new Response("", { status: opts.status });
    const digest = url.split("/manifests/")[1] ?? "";
    const bytes = opts.tampered ?? opts.extra?.[digest] ?? LIVE_INDEXES[digest];
    if (!bytes) return new Response("", { status: 404 });
    return new Response(bytes, { status: 200 });
  };
  return impl as typeof fetch;
}
