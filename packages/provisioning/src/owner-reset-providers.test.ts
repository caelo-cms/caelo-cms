// SPDX-License-Identifier: MPL-2.0

/**
 * #770 — `owner-reset` beyond gcp-firebase: plain gcp reaches the admin on
 * `admin.<domain>` behind the load balancer's IAP, self-hosted reaches it
 * through `docker compose exec` with nothing secret in the process
 * arguments, aws / azure refuse naming #952 — and on no provider does the
 * reset link (or the token in it) reach a log line.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GcloudResult } from "./gcloud.js";
import {
  describeOwnerReset,
  OWNER_RESET_SCOPE,
  ownerResetTarget,
  requestOwnerReset,
} from "./owner-reset.js";
import { writeInternalSecret } from "./self-hosted-internal-secret.js";
import type { CommandResult, HostRunner, HostRunOptions } from "./self-hosted-release.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const TOKEN = "tok/with+chars";
const ISSUED = {
  ok: true,
  email: "owner@example.com",
  token: TOKEN,
  expiresAt: "2026-10-15T12:52:56.000Z",
};

/** gcloud for a gcp install: no Cloud Run lookup is expected (the LB host is the URL). */
function fakeGcloud(seen: string[][]): (args: string[]) => Promise<GcloudResult> {
  const answers: Record<string, GcloudResult> = {
    "auth list": ok("operator@example.com\n"),
    "secrets versions access": ok("s".repeat(40)),
    "auth print-access-token": ok("ya29.operator\n"),
    "services enable iamcredentials.googleapis.com": ok(),
  };
  return async (args) => {
    seen.push(args);
    const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
    return (key && answers[key]) || fail(`unexpected gcloud ${args.join(" ")}`);
  };
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function fakeFetch(admin: () => Response) {
  const seen: Seen[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    if (url.startsWith("https://iamcredentials.googleapis.com/")) {
      return Response.json({ signedJwt: "iap.jwt.signed" });
    }
    return admin();
  }) as typeof fetch;
  return { doFetch, seen };
}

/** A host whose `docker compose exec` answers `reply` and records every call. */
function fakeHost(reply: CommandResult) {
  const calls: { argv: readonly string[]; opts?: HostRunOptions }[] = [];
  const host: HostRunner = {
    run: async (argv, opts) => {
      calls.push({ argv, ...(opts ? { opts } : {}) });
      return reply;
    },
  };
  return { host, calls };
}

const answered = (status: number, body: unknown): CommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ status, text: JSON.stringify(body) }),
  stderr: "",
});

describe("owner-reset on gcp (IAP on the load balancer)", () => {
  it("calls admin.<domain> with a JWT for that origin and builds the link there", async () => {
    const gcloudCalls: string[][] = [];
    const { doFetch, seen } = fakeFetch(() => Response.json(ISSUED));
    const r = await requestOwnerReset(
      { provider: "gcp", projectId: "proj", domain: "example.com" },
      {},
      { run: fakeGcloud(gcloudCalls), fetch: doFetch, now: () => 1_000 },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        email: "owner@example.com",
        resetUrl: "https://admin.example.com/reset?token=tok%2Fwith%2Bchars",
        expiresAt: "2026-10-15T12:52:56.000Z",
      },
    });
    const sign = seen[0];
    expect(sign?.url).toContain("caelo-mcp%40proj.iam.gserviceaccount.com:signJwt");
    expect(JSON.parse(String(sign?.body?.payload))).toMatchObject({
      aud: "https://admin.example.com/*",
      iat: 1_000,
    });
    const call = seen[1];
    expect(call?.url).toBe("https://admin.example.com/api/internal/owner-reset");
    expect(call?.headers.authorization).toBe("Bearer iap.jwt.signed");
    expect(call?.body).toEqual({ requestedBy: "operator@example.com" });
    // The run.app URL is not reachable from outside the LB; nothing looks it up.
    expect(gcloudCalls.some((a) => a[0] === "run")).toBe(false);
  });

  it("points an unreachable admin host at its DNS record and certificate", async () => {
    const r = await requestOwnerReset(
      { provider: "gcp", projectId: "proj", domain: "example.com" },
      {},
      {
        run: fakeGcloud([]),
        fetch: (async (input: RequestInfo | URL) => {
          if (String(input).startsWith("https://iamcredentials")) {
            return Response.json({ signedJwt: "j" });
          }
          throw new TypeError("getaddrinfo ENOTFOUND admin.example.com");
        }) as typeof fetch,
      },
    );
    expect(r.ok ? "" : r.error).toContain("dig +short admin.example.com");
  });
});

describe("owner-reset on self-hosted (docker compose exec)", () => {
  let dir: string;
  const SECRET = "x".repeat(96);
  const target = () => ({
    provider: "self-hosted" as const,
    caeloDir: dir,
    adminUrl: "https://admin.example.com",
  });
  const localUser = () => ({ user: "michael", host: "box.lan" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caelo-owner-reset-"));
    writeInternalSecret(dir, SECRET);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs one exec into caelo-admin with the token and body on stdin only", async () => {
    const { host, calls } = fakeHost(answered(200, ISSUED));
    const r = await requestOwnerReset(
      target(),
      { email: "owner@example.com" },
      {
        host,
        localUser,
      },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        email: "owner@example.com",
        resetUrl: "https://admin.example.com/reset?token=tok%2Fwith%2Bchars",
        expiresAt: "2026-10-15T12:52:56.000Z",
      },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.argv.slice(0, 9)).toEqual([
      "docker",
      "compose",
      "-f",
      join(dir, "docker-compose.yml"),
      "exec",
      "-T",
      "caelo-admin",
      "bun",
      "-e",
    ]);
    const stdin = JSON.parse(call?.opts?.stdinText ?? "{}") as {
      endpoint: string;
      token: string;
      body: unknown;
    };
    expect(stdin.endpoint).toBe("/api/internal/owner-reset");
    expect(stdin.body).toEqual({
      email: "owner@example.com",
      requestedByHostUser: "michael@box.lan",
    });
    const [message] = stdin.token.split(".");
    expect(Buffer.from(message ?? "", "base64url").toString()).toEndWith(`:${OWNER_RESET_SCOPE}`);
    // `ps` shows argv to every user of the host: neither the secret nor the
    // token may be in it.
    const argv = call?.argv.join(" ") ?? "";
    expect(argv).not.toContain(SECRET);
    expect(argv).not.toContain(stdin.token);
  });

  it("tells an install whose running admin lacks the secret to run `up`", async () => {
    const { host } = fakeHost(answered(401, { ok: false, error: "missing-secret" }));
    const r = await requestOwnerReset(target(), {}, { host, localUser });
    expect(r.ok ? "" : r.error).toContain("missing-secret");
    expect(r.ok ? "" : r.error).toMatch(/Run `bunx @caelo-cms\/provisioning@\S+ up`/);
  });

  it("names a missing secret file and a stopped admin with the fix", async () => {
    rmSync(join(dir, "internal-secret.json"));
    const none = await requestOwnerReset(
      target(),
      {},
      { host: fakeHost(answered(200, ISSUED)).host, localUser },
    );
    expect(none.ok ? "" : none.error).toContain("internal-secret.json does not exist");

    writeInternalSecret(dir, SECRET);
    const stopped = await requestOwnerReset(
      target(),
      {},
      {
        host: fakeHost({ exitCode: 1, stdout: "", stderr: 'service "caelo-admin" is not running' })
          .host,
        localUser,
      },
    );
    expect(stopped.ok ? "" : stopped.error).toContain('service "caelo-admin" is not running');
    expect(stopped.ok ? "" : stopped.error).toContain("up`");
  });

  it("names an admin from before #770 for an upgrade", async () => {
    const { host } = fakeHost({
      exitCode: 0,
      stdout: JSON.stringify({ status: 404, text: "Not Found" }),
      stderr: "",
    });
    const r = await requestOwnerReset(target(), {}, { host, localUser });
    expect(r.ok ? "" : r.error).toContain("before #770");
  });

  it("refuses a host user the admin's audit row would not accept", async () => {
    const { host, calls } = fakeHost(answered(200, ISSUED));
    const r = await requestOwnerReset(
      target(),
      {},
      { host, localUser: () => ({ user: "evil user\n", host: "box" }) },
    );
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("ownerResetTarget", () => {
  const meta = {
    installId: "example.com",
    projectId: "proj",
    region: "europe-west1",
    domain: "example.com",
  };

  it("addresses gcp-firebase by project + region and gcp by project + domain", () => {
    expect(ownerResetTarget({ ...meta, provider: "gcp-firebase" })).toEqual({
      ok: true,
      value: { provider: "gcp-firebase", projectId: "proj", region: "europe-west1" },
    });
    expect(ownerResetTarget({ ...meta, provider: "gcp" })).toEqual({
      ok: true,
      value: { provider: "gcp", projectId: "proj", domain: "example.com" },
    });
  });

  it("refuses aws and azure naming #952 and the ways in meanwhile", () => {
    for (const provider of ["aws", "azure"] as const) {
      const r = ownerResetTarget({ ...meta, provider });
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toContain("#952");
      expect(r.ok ? "" : r.error).toContain("Settings -> Users");
    }
  });

  it("sends a self-hosted install to its .caelo/ directory", () => {
    const r = ownerResetTarget({ ...meta, provider: "self-hosted", projectId: null });
    expect(r.ok ? "" : r.error).toContain(".caelo/");
  });
});

describe("the reset link is never logged", () => {
  const LOGGERS = ["log", "info", "warn", "error", "debug"] as const;

  async function captured(run: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const spies = [
      ...LOGGERS.map((m) =>
        spyOn(console, m).mockImplementation((...a: unknown[]) => {
          lines.push(a.map(String).join(" "));
        }),
      ),
      spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }),
      spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }),
    ];
    try {
      await run();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    return lines.join("\n");
  }

  it("on gcp-firebase, gcp and self-hosted, nothing is printed while the link is fetched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caelo-owner-reset-log-"));
    writeInternalSecret(dir, "x".repeat(96));
    try {
      const firebaseRun = async (args: string[]): Promise<GcloudResult> => {
        const line = args.join(" ");
        if (line.startsWith("run services list")) return ok("caelo-production-admin-abc\n");
        if (line.startsWith("run services describe")) return ok("https://admin-abc.a.run.app\n");
        return fakeGcloud([])(args);
      };
      const results: unknown[] = [];
      const output = await captured(async () => {
        results.push(
          await requestOwnerReset(
            { provider: "gcp-firebase", projectId: "proj", region: "europe-west1" },
            {},
            { run: firebaseRun, fetch: fakeFetch(() => Response.json(ISSUED)).doFetch },
          ),
          await requestOwnerReset(
            { provider: "gcp", projectId: "proj", domain: "example.com" },
            {},
            { run: fakeGcloud([]), fetch: fakeFetch(() => Response.json(ISSUED)).doFetch },
          ),
          await requestOwnerReset(
            { provider: "self-hosted", caeloDir: dir, adminUrl: "https://admin.example.com" },
            {},
            {
              host: fakeHost(answered(200, ISSUED)).host,
              localUser: () => ({ user: "op", host: "box" }),
            },
          ),
        );
      });
      expect(results.every((r) => (r as { ok: boolean }).ok)).toBe(true);
      expect(output).not.toContain(TOKEN);
      expect(output).not.toContain(encodeURIComponent(TOKEN));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the printed lines are the only place the link appears", () => {
    const text = describeOwnerReset({
      email: "owner@example.com",
      resetUrl: "https://admin.example.com/reset?token=abc",
      expiresAt: "2026-10-15T12:52:56.000Z",
    }).join("\n");
    expect(text).toContain("not saved anywhere");
  });
});
