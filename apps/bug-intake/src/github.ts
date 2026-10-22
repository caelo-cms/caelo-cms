// SPDX-License-Identifier: MPL-2.0

/**
 * Minimal GitHub REST client for the bug intake, authenticated as a GitHub
 * App installation. Only the calls the intake makes, all against the public
 * tracker: issues and their comments (Issues: write) and the public release
 * list (readable by any installation token on a public repository, so the
 * App needs no Contents permission at all — #980). Storage lives in
 * Firestore; this client must never grow a repository-contents call.
 *
 * Installation tokens live one hour; this client refreshes them five
 * minutes early. The App JWT is signed with node:crypto because GitHub
 * hands out PKCS#1 keys, which Web Crypto cannot import.
 */

import { createPrivateKey, sign } from "node:crypto";

const API = "https://api.github.com";

/** A GitHub answer the intake cannot act on (rate limit, outage, missing permission). */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubAppAuth {
  appId: string;
  privateKeyPem: string;
  installationId: string;
}

export interface IssueState {
  number: number;
  url: string;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | "duplicate" | "reopened" | null;
  closedAt: string | null;
  labels: string[];
}

export interface ReleaseInfo {
  version: string;
  publishedAt: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** RS256 JWT identifying the App itself (10-minute lifetime, 60 s clock allowance). */
export function appJwt(auth: GitHubAppAuth, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: auth.appId }));
  const key = createPrivateKey(auth.privateKeyPem);
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

export class GitHubClient {
  readonly #auth: GitHubAppAuth;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #token: { value: string; refreshAt: number } | null = null;

  constructor(auth: GitHubAppAuth, opts: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
    this.#auth = auth;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? Date.now;
  }

  async #installationToken(): Promise<string> {
    if (this.#token && this.#now() < this.#token.refreshAt) return this.#token.value;
    const res = await this.#fetch(
      `${API}/app/installations/${this.#auth.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${appJwt(this.#auth, this.#now())}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!res.ok) {
      throw new GitHubError(
        res.status,
        `installation token: HTTP ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    this.#token = { value: body.token, refreshAt: Date.parse(body.expires_at) - 5 * 60_000 };
    return body.token;
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.#installationToken()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text === "" ? null : JSON.parse(text) };
  }

  #fail(what: string, r: { status: number; json: unknown }): never {
    throw new GitHubError(r.status, `${what}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  }

  async createIssue(
    repo: string,
    issue: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number; url: string }> {
    const r = await this.#request("POST", `/repos/${repo}/issues`, issue);
    if (r.status !== 201) this.#fail("create issue", r);
    const j = r.json as { number: number; html_url: string };
    return { number: j.number, url: j.html_url };
  }

  async updateIssue(
    repo: string,
    number: number,
    patch: { body?: string; state?: "open" | "closed" },
  ): Promise<void> {
    const r = await this.#request("PATCH", `/repos/${repo}/issues/${number}`, patch);
    if (r.status !== 200) this.#fail(`update issue #${number}`, r);
  }

  async getIssue(repo: string, number: number): Promise<IssueState> {
    const r = await this.#request("GET", `/repos/${repo}/issues/${number}`);
    if (r.status !== 200) this.#fail(`read issue #${number}`, r);
    const j = r.json as {
      number: number;
      html_url: string;
      state: "open" | "closed";
      state_reason: IssueState["stateReason"];
      closed_at: string | null;
      labels: Array<{ name: string } | string>;
    };
    return {
      number: j.number,
      url: j.html_url,
      state: j.state,
      stateReason: j.state_reason,
      closedAt: j.closed_at,
      labels: j.labels.map((l) => (typeof l === "string" ? l : l.name)),
    };
  }

  async addComment(repo: string, number: number, body: string): Promise<void> {
    const r = await this.#request("POST", `/repos/${repo}/issues/${number}/comments`, { body });
    if (r.status !== 201) this.#fail(`comment on #${number}`, r);
  }

  /** The newest comments' bodies (GitHub's "Close as duplicate" writes one naming the original). */
  async recentCommentBodies(repo: string, number: number): Promise<string[]> {
    const r = await this.#request(
      "GET",
      `/repos/${repo}/issues/${number}/comments?per_page=30&sort=created&direction=desc`,
    );
    if (r.status !== 200) this.#fail(`list comments on #${number}`, r);
    return (r.json as Array<{ body: string }>).map((c) => c.body);
  }

  /** Published, non-prerelease releases, newest first. */
  async releases(repo: string): Promise<ReleaseInfo[]> {
    const r = await this.#request("GET", `/repos/${repo}/releases?per_page=30`);
    if (r.status !== 200) this.#fail("list releases", r);
    return (
      r.json as Array<{
        tag_name: string;
        published_at: string | null;
        draft: boolean;
        prerelease: boolean;
      }>
    )
      .filter((x) => !x.draft && !x.prerelease && x.published_at)
      .map((x) => ({
        version: x.tag_name.replace(/^v/, ""),
        publishedAt: x.published_at as string,
      }));
  }
}
