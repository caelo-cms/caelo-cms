// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #971 — no credential reaches an AI-visible result. Catalogue-driven,
 * so a tool added later is covered without anyone remembering this file:
 *
 *  - every gated tool's executor output schema has no secret-shaped field
 *    (the executor's output IS the AI's tool result after approval);
 *  - an executor that returns a credential handoff belongs to a tool that
 *    declares `producesCredential` (and vice versa), whose description
 *    carries the "you never see it" contract;
 *  - every op an AI actor may call returns no secret-shaped field, except
 *    the reviewed exceptions below (each says why it cannot leak);
 *  - the choke point (`credentialFreeResult`) withholds a regressed field
 *    and turns a handoff into the "where to collect it" sentence.
 *
 * The integration twin (credential-free-ai-results.integration.test.ts)
 * runs each credential-producing tool end to end and scans what the model,
 * the chat transcript and the MCP replies actually received.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OperationRegistry } from "@caelo-cms/query-api";
import { z } from "zod";
import {
  CREDENTIAL_KINDS,
  describeCredentialHandoffForAi,
  HANDOFF_LOCATIONS,
} from "../../../ops/credential_handoffs.js";
import { registerAdminOps } from "../../../register.js";
import { CREDENTIAL_CONTRACT } from "../_make-propose-tool.js";
import {
  credentialFreeResult,
  findSecretShapedFields,
  SECRET_SHAPED_KEY,
  WITHHELD,
} from "../credential-free-result.js";
import { createDefaultToolRegistry } from "../index.js";

const registry = new OperationRegistry();
registerAdminOps(registry);
const tools = createDefaultToolRegistry().catalogue();
const gated = tools.filter((t) => t.gated);

/**
 * AI-callable ops whose output schema names a secret-shaped field on
 * purpose. Each entry is a reviewed decision; adding one needs the same.
 */
const AI_SCOPE_SECRET_FIELD_EXCEPTIONS: Record<string, string> = {
  "staging_access.get.credentials.basicAuthPassword":
    "returned only to a HUMAN holding settings.write (the op refuses any other actor kind); the get_staging_access tool hard-codes includeCredentials:false",
  "ai_providers.list.providers.apiKeySource":
    "where the key comes from (stored / env), not the key",
  "ai_providers.list.providers.apiKeySetAt": "a timestamp, not the key",
};

/** String-typed fields with a secret-shaped name, from an op's output schema. */
function secretShapedOutputFields(schema: unknown, prefix: string): string[] {
  const js = z.toJSONSchema(schema as z.ZodType, { unrepresentable: "any", io: "output" });
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o.properties && typeof o.properties === "object") {
      for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
        const p = `${path}.${k}`;
        const types = [(v as { type?: unknown }).type].flat();
        const anyOf = ((v as { anyOf?: { type?: unknown }[] }).anyOf ?? []).map((x) => x.type);
        const isString = [...types, ...anyOf].includes("string");
        if (SECRET_SHAPED_KEY.test(k) && isString) out.push(p);
        walk(v, p);
      }
    }
    for (const key of ["items", "anyOf", "oneOf", "allOf", "additionalProperties"]) {
      const v = o[key];
      if (Array.isArray(v)) for (const x of v) walk(x, path);
      else if (v && typeof v === "object") walk(v, path);
    }
  };
  walk(js, prefix);
  return out;
}

function outputSchemaOf(opName: string): unknown {
  const op = registry.lookup(opName);
  if (!op.ok) throw new Error(`${opName} is not registered`);
  return (op.value as { output: unknown }).output;
}

function returnsHandoff(opName: string): boolean {
  const js = JSON.stringify(z.toJSONSchema(outputSchemaOf(opName) as z.ZodType, { io: "output" }));
  return js.includes('"credentialHandoff"');
}

describe("gated tools never return a credential to the AI (#971)", () => {
  it("finds the gated surface", () => {
    expect(gated.length).toBeGreaterThan(20);
  });

  for (const tool of gated) {
    const executeOp = tool.gated?.executeOp ?? "";
    it(`${tool.name}: ${executeOp} output has no secret-shaped field`, () => {
      expect(secretShapedOutputFields(outputSchemaOf(executeOp), executeOp)).toEqual([]);
    });
    if (tool.gated?.producesCredential) {
      it(`${tool.name}: declares producesCredential, so ${executeOp} returns a handoff`, () => {
        expect(returnsHandoff(executeOp)).toBe(true);
      });
    }
  }

  // One executor serves several tools of a domain (users.execute_proposal
  // applies create, set_roles and delete); a handoff-returning executor
  // needs at least one declaring tool, so its result gets the AI sentence.
  const executors = [...new Set(gated.map((t) => t.gated?.executeOp ?? ""))];
  for (const executeOp of executors) {
    if (!returnsHandoff(executeOp)) continue;
    it(`${executeOp} returns a credential handoff: a tool using it declares producesCredential`, () => {
      const declaring = gated.filter(
        (t) => t.gated?.executeOp === executeOp && t.gated.producesCredential,
      );
      expect(declaring.length).toBeGreaterThan(0);
    });
  }

  it("each credential-producing tool states the contract and a kind with a location", () => {
    const producing = gated.filter((t) => t.gated?.producesCredential);
    expect(producing.map((t) => t.name).sort()).toEqual([
      "propose_create_mcp_token",
      "propose_create_user",
    ]);
    for (const t of producing) {
      expect(t.description).toContain(CREDENTIAL_CONTRACT);
      const kind = t.gated?.producesCredential;
      expect(kind && HANDOFF_LOCATIONS[kind]).toBeDefined();
    }
  });
});

describe("AI-callable ops return no secret-shaped field (#971)", () => {
  const found: string[] = [];
  for (const name of registry.names()) {
    const op = registry.lookup(name);
    if (!op.ok) continue;
    const def = op.value as { actorScope: readonly string[]; output: unknown };
    if (!def.actorScope.includes("ai")) continue;
    found.push(...secretShapedOutputFields(def.output, name));
  }

  it("every hit is a reviewed exception", () => {
    expect(found.filter((f) => !(f in AI_SCOPE_SECRET_FIELD_EXCEPTIONS))).toEqual([]);
  });

  it("no stale exception", () => {
    expect(Object.keys(AI_SCOPE_SECRET_FIELD_EXCEPTIONS).filter((f) => !found.includes(f))).toEqual(
      [],
    );
  });

  it("get_staging_access accepts no credential flag", () => {
    const t = tools.find((x) => x.name === "get_staging_access");
    expect(t?.inputSchema).toEqual(expect.objectContaining({ properties: {} }));
    expect(t?.description).toContain("/settings/staging");
  });
});

describe("credentialFreeResult — the gated-result choke point", () => {
  const ref = {
    handoffId: "11111111-1111-4111-8111-111111111111",
    kind: "user_temporary_password" as const,
    expiresAt: "2026-10-28T00:00:00.000Z",
  };

  it("adds where the operator collects the credential, never a value", () => {
    const shaped = credentialFreeResult("propose_create_user", {
      userId: "u1",
      credentialHandoff: ref,
    }) as Record<string, unknown>;
    expect(shaped.credential).toBe(describeCredentialHandoffForAi(ref));
    expect(String(shaped.credential)).toContain("/settings/users");
    expect(String(shaped.credential)).toContain("must not offer");
  });

  it("withholds a regressed secret field at any depth and keeps metadata", () => {
    const shaped = credentialFreeResult("x", {
      tokenId: "t1",
      cookieSecretSet: true,
      nested: [{ temporaryPassword: "hunter2-hunter2", plaintextToken: "mcp_abc" }],
      apiKey: "sk-live",
    });
    expect(JSON.stringify(shaped)).not.toContain("hunter2");
    expect(JSON.stringify(shaped)).not.toContain("mcp_abc");
    expect(JSON.stringify(shaped)).not.toContain("sk-live");
    expect(shaped).toEqual({
      tokenId: "t1",
      cookieSecretSet: true,
      nested: [{ temporaryPassword: WITHHELD, plaintextToken: WITHHELD }],
      apiKey: WITHHELD,
    });
  });

  it("finds secret-shaped string fields by path", () => {
    expect(
      findSecretShapedFields({ a: { password: "p" }, list: [{ clientSecret: "s" }], tokenId: "x" }),
    ).toEqual(["a.password", "list[0].clientSecret"]);
  });
});

describe("credential kinds line up with the schema", () => {
  const migrations = resolve(import.meta.dir, "../../../../../migrations/migrations/cms_admin");
  const sql = readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(resolve(migrations, f), "utf8"))
    .join("\n");
  for (const kind of CREDENTIAL_KINDS) {
    it(`${kind} has a location and is allowed by the credential_handoffs CHECK`, () => {
      expect(HANDOFF_LOCATIONS[kind]).toBeDefined();
      expect(sql).toContain(`'${kind}'`);
    });
  }
});
