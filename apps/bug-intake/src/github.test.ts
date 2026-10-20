// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 (#903) — the GitHub client's contract with the rest of the
 * intake: App JWT verifies with the App's public key (GitHub issues PKCS#1
 * keys), installation tokens are reused until shortly before expiry, and a
 * write that lost a race reports `conflict` instead of throwing.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { appJwt, GitHubClient, GitHubError } from "./github.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const auth = { appId: "12345", privateKeyPem: pem, installationId: "678" };

function fakeGitHub(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
    calls.push(key);
    if (key.endsWith("/access_tokens")) {
      return Response.json(
        { token: "inst-token", expires_at: "2026-10-20T11:00:00Z" },
        { status: 201 },
      );
    }
    const route = routes[key];
    if (!route) return new Response("{}", { status: 404 });
    return route(init ?? {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("GitHub client", () => {
  it("signs an RS256 App JWT from a PKCS#1 key", () => {
    const jwt = appJwt(auth, Date.parse("2026-10-20T10:00:00Z"));
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({ iss: "12345" });
    expect(
      verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, "base64url")),
    ).toBe(true);
  });

  it("reuses the installation token and maps write races to conflict", async () => {
    const { calls, fetchImpl } = fakeGitHub({
      "PUT /repos/o/data/contents/a.json": () => new Response("{}", { status: 201 }),
      "PUT /repos/o/data/contents/b.json": () => new Response("{}", { status: 409 }),
      "PUT /repos/o/data/contents/c.json": () => new Response('{"message":"sha"}', { status: 422 }),
      "PUT /repos/o/data/contents/d.json": () => new Response("{}", { status: 403 }),
    });
    const gh = new GitHubClient(auth, { fetchImpl, now: () => Date.parse("2026-10-20T10:00:00Z") });
    expect(await gh.putJson("o/data", "a.json", {}, null, "m")).toBe("ok");
    expect(await gh.putJson("o/data", "b.json", {}, "sha", "m")).toBe("conflict");
    expect(await gh.putJson("o/data", "c.json", {}, null, "m")).toBe("conflict");
    await expect(gh.putJson("o/data", "d.json", {}, null, "m")).rejects.toBeInstanceOf(GitHubError);
    expect(calls.filter((c) => c.endsWith("/access_tokens")).length).toBe(1);
  });

  it("reads JSON files and treats a missing one as null", async () => {
    const { fetchImpl } = fakeGitHub({
      "GET /repos/o/data/contents/x.json": () =>
        Response.json({ content: Buffer.from('{"v":1}').toString("base64"), sha: "s1" }),
    });
    const gh = new GitHubClient(auth, { fetchImpl, now: () => Date.parse("2026-10-20T10:00:00Z") });
    expect(await gh.getJson("o/data", "x.json")).toEqual({ value: { v: 1 }, sha: "s1" });
    expect(await gh.getJson("o/data", "missing.json")).toBeNull();
  });

  it("lists only published, final releases without the v prefix", async () => {
    const { fetchImpl } = fakeGitHub({
      "GET /repos/o/pub/releases": () =>
        Response.json([
          {
            tag_name: "v0.11.0",
            published_at: "2026-10-25T00:00:00Z",
            draft: false,
            prerelease: false,
          },
          {
            tag_name: "v0.12.0-rc.1",
            published_at: "2026-10-26T00:00:00Z",
            draft: false,
            prerelease: true,
          },
          { tag_name: "v0.12.0", published_at: null, draft: true, prerelease: false },
        ]),
    });
    const gh = new GitHubClient(auth, { fetchImpl, now: () => Date.parse("2026-10-20T10:00:00Z") });
    expect(await gh.releases("o/pub")).toEqual([
      { version: "0.11.0", publishedAt: "2026-10-25T00:00:00Z" },
    ]);
  });
});
