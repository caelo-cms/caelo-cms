// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudRunner } from "./gcloud-retry.js";
import { rotationRefusal } from "./runtime-secrets.js";
import {
  finishSealKeyRotation,
  SEAL_KEY_PREVIOUS_ENV,
  SEAL_KEY_ROTATION_WINDOW_DAYS,
  SEAL_ROTATION_LABEL,
  startSealKeyRotation,
} from "./seal-key-rotation.js";

const T = {
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  gatewayService: "caelo-production-gateway-abc",
};
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20);

function service(opts: { previous?: boolean; startedAt?: number }) {
  const env: unknown[] = [
    {
      name: "CAELO_MCP_OAUTH_SEAL_KEY",
      valueFrom: { secretKeyRef: { name: "caelo-production-mcp-oauth-seal-key", key: "latest" } },
    },
  ];
  if (opts.previous) {
    env.push({
      name: SEAL_KEY_PREVIOUS_ENV,
      valueFrom: { secretKeyRef: { name: "caelo-production-mcp-oauth-seal-key", key: "3" } },
    });
  }
  return JSON.stringify({
    metadata: {
      labels: opts.startedAt === undefined ? {} : { [SEAL_ROTATION_LABEL]: String(opts.startedAt) },
    },
    spec: { template: { spec: { containers: [{ env }] } } },
  });
}

function fake(svc: string, versionName = "projects/1/secrets/s/versions/3") {
  const calls: { line: string; stdin?: string }[] = [];
  const run: GcloudRunner = async (args, opts) => {
    const line = args.join(" ");
    calls.push({ line, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    const ok = (stdout = "") => ({ ok: true, stdout, stderr: "", exitCode: 0 });
    if (line.startsWith("run services describe")) return ok(svc);
    if (line.startsWith("secrets versions describe latest")) return ok(`${versionName}\n`);
    return ok();
  };
  return { run, calls };
}

describe("seal-key rotation (#806)", () => {
  it("is offered by rotate-secret (two steps), not refused", () => {
    expect(rotationRefusal("mcp-oauth-seal-key")).toBeNull();
  });

  it("start: adds a version, keeps the new key at latest and pins the old version as previous", async () => {
    const f = fake(service({}));
    const r = await startSealKeyRotation(T, { run: f.run, nowMs: () => NOW, generate: () => "K" });
    expect(r.ok).toBe(true);
    expect(f.calls.find((c) => c.line.startsWith("secrets versions add"))?.stdin).toBe("K");
    const update = f.calls.find((c) => c.line.startsWith("run services update "))?.line ?? "";
    expect(update).toContain(
      `--update-secrets=CAELO_MCP_OAUTH_SEAL_KEY=caelo-production-mcp-oauth-seal-key:latest,${SEAL_KEY_PREVIOUS_ENV}=caelo-production-mcp-oauth-seal-key:3`,
    );
    expect(update).toContain(`--update-labels=${SEAL_ROTATION_LABEL}=${NOW}`);
    expect(f.calls.at(-1)?.line).toContain("update-traffic caelo-production-gateway-abc");
  });

  it("start: refuses while a rotation is in progress, before touching the secret", async () => {
    const f = fake(service({ previous: true, startedAt: NOW - DAY }));
    const r = await startSealKeyRotation(T, { run: f.run, nowMs: () => NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already in progress");
    expect(f.calls.some((c) => c.line.startsWith("secrets versions add"))).toBe(false);
  });

  it("start: refuses an unreadable version instead of pinning a guess", async () => {
    const f = fake(service({}), "something-else");
    const r = await startSealKeyRotation(T, { run: f.run, nowMs: () => NOW });
    expect(r.ok).toBe(false);
    expect(f.calls.some((c) => c.line.startsWith("secrets versions add"))).toBe(false);
  });

  it("finish: refuses inside the refresh-token window", async () => {
    const f = fake(service({ previous: true, startedAt: NOW - 29 * DAY }));
    const r = await finishSealKeyRotation(T, { run: f.run, nowMs: () => NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`${SEAL_KEY_ROTATION_WINDOW_DAYS}-day lifetime`);
    expect(f.calls.some((c) => c.line.startsWith("run services update "))).toBe(false);
  });

  it("finish --now: removes the previous key inside the window (a leaked key)", async () => {
    const f = fake(service({ previous: true, startedAt: NOW - DAY }));
    const r = await finishSealKeyRotation(T, { run: f.run, nowMs: () => NOW }, { now: true });
    expect(r.ok).toBe(true);
    expect(f.calls.some((c) => c.line.includes(`--remove-secrets=${SEAL_KEY_PREVIOUS_ENV}`))).toBe(
      true,
    );
  });

  it("finish: after the window, removes the previous key and the label", async () => {
    const f = fake(service({ previous: true, startedAt: NOW - 31 * DAY }));
    const r = await finishSealKeyRotation(T, { run: f.run, nowMs: () => NOW });
    expect(r.ok).toBe(true);
    const update = f.calls.find((c) => c.line.startsWith("run services update "))?.line ?? "";
    expect(update).toContain(`--remove-secrets=${SEAL_KEY_PREVIOUS_ENV}`);
    expect(update).toContain(`--remove-labels=${SEAL_ROTATION_LABEL}`);
  });

  it("finish: refuses when no rotation is in progress", async () => {
    const f = fake(service({}));
    const r = await finishSealKeyRotation(T, { run: f.run, nowMs: () => NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("No seal-key rotation is in progress");
  });

  it("keeps the window equal to the broker's refresh-token lifetime", async () => {
    const src = await Bun.file(
      new URL("../../../apps/api-gateway/src/mcp/token.ts", import.meta.url),
    ).text();
    expect(src).toContain(
      `REFRESH_MAX_LIFETIME_SECONDS = ${SEAL_KEY_ROTATION_WINDOW_DAYS} * 24 * 60 * 60`,
    );
  });
});
