// SPDX-License-Identifier: MPL-2.0

/**
 * Firebase Hosting as far as Stage and Publish live use it, in memory:
 * versions, batched populateFiles, uploads (read in full and kept by hash
 * only), preview channels with their lifetimes, releases. Shared by the
 * Stage scale bench (#1003) and the build-memory test (#1271); no network,
 * so upload time is CPU and memory only.
 */

import { FakeChannelLifetimes } from "./firebase-channel-lifetime.js";

const API = "https://firebasehosting.googleapis.com/v1beta1/";
const UPLOAD = "https://upload.fake-hosting/";

export class FakeFirebaseHosting {
  readonly versions = new Map<string, Record<string, string>>();
  readonly channels = new Map<string, string>();
  readonly lifetimes = new FakeChannelLifetimes();
  /** Hashes Hosting holds (bodies are read in full, then dropped). */
  readonly blobs = new Set<string>();
  /** Every hash uploaded, in order. */
  readonly uploaded: string[] = [];
  /** Gzipped bytes received over every upload. */
  uploadedBytes = 0;
  /** `populateFiles` calls, with how many files each named. */
  readonly populateSizes: number[] = [];
  #seq = 0;

  /**
   * @param site the Hosting site the publisher addresses (`CAELO_FIREBASE_SITE`).
   * @param passThrough what answers any other URL (the real fetch).
   */
  constructor(
    readonly site: string,
    readonly passThrough: typeof fetch,
  ) {}

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(API) && !url.startsWith(UPLOAD)) return this.passThrough(input, init);
    const method = init?.method ?? "GET";
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.startsWith(UPLOAD)) {
      // Read the body as Hosting does: a streamed media upload is sent only
      // while the server reads it.
      this.uploadedBytes += (await new Response(init?.body ?? null).arrayBuffer()).byteLength;
      const hash = url.split("/").pop() ?? "";
      this.uploaded.push(hash);
      this.blobs.add(hash);
      return json({});
    }
    const parsed = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const [route = "", query = ""] = url.slice(API.length).split("?");
    const params = new URLSearchParams(query);
    const site = this.site;
    if (method === "POST" && route === `sites/${site}/versions`) {
      const id = `v${++this.#seq}`;
      this.versions.set(id, {});
      return json({ name: `sites/${site}/versions/${id}` });
    }
    const populate = route.match(/versions\/([^/:]+):populateFiles$/);
    if (populate) {
      const id = populate[1] ?? "";
      const files = parsed.files as Record<string, string>;
      this.populateSizes.push(Object.keys(files).length);
      // Calls add up (the publisher populates in batches, as firebase-tools does).
      this.versions.set(id, { ...this.versions.get(id), ...files });
      return json({
        uploadRequiredHashes: [...new Set(Object.values(files))].filter((h) => !this.blobs.has(h)),
        uploadUrl: `${UPLOAD}${id}`,
      });
    }
    if (method === "PATCH" && /versions\/[^/]+$/.test(route)) return json({});
    if (method === "POST" && route === `sites/${site}/channels`) {
      const id = params.get("channelId") ?? "";
      const channelUrl = `https://${site}--${id}.web.app`;
      this.channels.set(id, channelUrl);
      this.lifetimes.create(id, parsed.ttl);
      return json({ name: `sites/${site}/channels/${id}`, url: channelUrl });
    }
    if (method === "GET" && route === `sites/${site}/channels`) {
      return json({
        channels: [...this.channels.keys(), "live"].map((id) => ({
          name: `sites/${site}/channels/${id}`,
          expireTime: this.lifetimes.expireTime(id),
        })),
      });
    }
    const channel = route.match(/^sites\/[^/]+\/channels\/([^/]+)$/);
    if (method === "DELETE" && channel) {
      this.channels.delete(channel[1] ?? "");
      this.lifetimes.forget(channel[1] ?? "");
      return new Response("", { status: 200 });
    }
    if (method === "GET" && channel) {
      if (!this.channels.has(channel[1] ?? "")) return new Response("{}", { status: 404 });
      return json({ name: url, expireTime: this.lifetimes.expireTime(channel[1] ?? "") });
    }
    if (method === "PATCH" && channel) {
      return this.lifetimes.patch(site, channel[1] ?? "", params.get("updateMask"), parsed);
    }
    if (method === "POST" && /channels\/[^/]+\/releases$/.test(route)) return json({});
    if (method === "POST" && route === `sites/${site}/releases`) return json({});
    throw new Error(`unhandled ${method} ${url}`);
  };
}
