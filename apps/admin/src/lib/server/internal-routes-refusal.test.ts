// SPDX-License-Identifier: MPL-2.0

/**
 * #1563 — every /api/internal/* endpoint that checks the internal token
 * answers a refused caller with a 401 and its JSON reason. SvelteKit answers
 * a thrown plain `Response` with a 500 "Internal Error"
 * (`render_endpoint` rethrows all but a `Redirect`), so the refusal must be
 * returned: these tests call each handler the way SvelteKit does and let a
 * thrown value fail the test. None of these paths reaches the database.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { POST as ownerReset } from "../../routes/api/internal/owner-reset/+server.js";
import { POST as outputsSync } from "../../routes/api/internal/provisioning-outputs/sync/+server.js";
import { POST as schedulerTick } from "../../routes/api/internal/scheduler/tick/+server.js";
import { POST as stagingProvision } from "../../routes/api/internal/staging/provision/+server.js";
import { INTERNAL_TOKEN_HEADER, signInternalToken } from "./internal-jwt.js";

type Handler = (event: { request: Request }) => Response | Promise<Response>;

const ENDPOINTS: ReadonlyArray<readonly [string, Handler]> = [
  ["owner-reset", ownerReset as unknown as Handler],
  ["provisioning-outputs/sync", outputsSync as unknown as Handler],
  ["scheduler/tick", schedulerTick as unknown as Handler],
  ["staging/provision", stagingProvision as unknown as Handler],
];

const SECRET_ENV = "CAELO_INTERNAL_SECRET";
let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = "internal-routes-refusal-secret-0123456789abcdef";
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = savedSecret;
});

async function call(handler: Handler, path: string, headers: Record<string, string>) {
  const request = new Request(`http://admin.test/api/internal/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
  return handler({ request });
}

describe("internal endpoints refuse with a 401, never a 500 (#1563)", () => {
  for (const [path, handler] of ENDPOINTS) {
    it(`${path}: no token`, async () => {
      const res = await call(handler, path, {});
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "missing-bearer" });
    });

    it(`${path}: a token of no endpoint's scope`, async () => {
      const iat = Date.now();
      const token = await signInternalToken({ iat, exp: iat + 60_000, scope: "nobody.scope" });
      const res = await call(handler, path, { [INTERNAL_TOKEN_HEADER]: token });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "scope-mismatch" });
    });
  }
});

describe("apps/admin/src", () => {
  it("throws no plain Response anywhere", () => {
    // A thrown Response reads as a crash (500) in SvelteKit; return it.
    const root = join(import.meta.dir, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      // Dirents, not a stat per path: the read is the only access to a file.
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|js|svelte)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
          if (/throw\s+new\s+Response\s*\(/.test(readFileSync(path, "utf8"))) {
            offenders.push(relative(root, path));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
