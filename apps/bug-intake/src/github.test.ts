// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 (#903) — the GitHub client's contract with the rest of the
 * intake: App JWT verifies with the App's public key (GitHub issues PKCS#1
 * keys), installation tokens are reused until shortly before expiry, and
 * every call stays on the Issues/Releases API (no repository contents, #980).
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

  it("reuses the installation token and surfaces refusals as GitHubError", async () => {
    const { calls, fetchImpl } = fakeGitHub({
      "POST /repos/o/pub/issues": () =>
        Response.json(
          { number: 7, html_url: "https://github.com/o/pub/issues/7" },
          { status: 201 },
        ),
      "PATCH /repos/o/pub/issues/7": () => new Response('{"message":"nope"}', { status: 403 }),
    });
    const gh = new GitHubClient(auth, { fetchImpl, now: () => Date.parse("2026-10-20T10:00:00Z") });
    const issue = { title: "t", body: "b", labels: [] };
    expect(await gh.createIssue("o/pub", issue)).toEqual({
      number: 7,
      url: "https://github.com/o/pub/issues/7",
    });
    await gh.createIssue("o/pub", issue);
    await expect(gh.updateIssue("o/pub", 7, { body: "x" })).rejects.toBeInstanceOf(GitHubError);
    expect(calls.filter((c) => c.endsWith("/access_tokens")).length).toBe(1);
  });

  it("touches only issue and release endpoints, so the App needs no Contents permission (#980)", async () => {
    const issueJson = {
      number: 7,
      html_url: "https://github.com/o/pub/issues/7",
      state: "open",
      state_reason: null,
      closed_at: null,
      labels: [],
    };
    const { calls, fetchImpl } = fakeGitHub({
      "POST /repos/o/pub/issues": () => Response.json(issueJson, { status: 201 }),
      "PATCH /repos/o/pub/issues/7": () => Response.json(issueJson),
      "GET /repos/o/pub/issues/7": () => Response.json(issueJson),
      "POST /repos/o/pub/issues/7/comments": () => Response.json({}, { status: 201 }),
      "GET /repos/o/pub/issues/7/comments": () => Response.json([{ body: "hi" }]),
      "GET /repos/o/pub/releases": () => Response.json([]),
    });
    const gh = new GitHubClient(auth, { fetchImpl, now: () => Date.parse("2026-10-20T10:00:00Z") });
    await gh.createIssue("o/pub", { title: "t", body: "b", labels: [] });
    await gh.updateIssue("o/pub", 7, { state: "open" });
    await gh.getIssue("o/pub", 7);
    await gh.addComment("o/pub", 7, "c");
    expect(await gh.recentCommentBodies("o/pub", 7)).toEqual(["hi"]);
    await gh.releases("o/pub");
    const repoCalls = calls.filter((c) => !c.endsWith("/access_tokens"));
    expect(repoCalls.length).toBe(6);
    for (const c of repoCalls) expect(c).toMatch(/ \/repos\/o\/pub\/(issues|releases)(\/|$)/);
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
