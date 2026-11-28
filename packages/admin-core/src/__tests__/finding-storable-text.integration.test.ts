// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1751 — a finding that quotes half of a character still records.
 * Core's `structured-data/invalid-json` quotes the JSON parser's error,
 * which names half of an unquoted emoji (`Unrecognized token '\ud83d'`);
 * `JSON.stringify` writes such a half as an escape jsonb refuses, so the
 * Stage audit could not be recorded (`quality_audit_pages.check_findings`).
 * Every finding passes `findingSchema`, which makes its text storable.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { findingSchema } from "../quality/checks/findings.js";
import { checkRunErrorSchema } from "../quality/checks/outcome.js";
import { jsonbParam } from "../sql-helpers.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "finding-storable-text",
};

/** Half of 😀: what a parser's error text or a cut between the halves leaves. */
const HALF = "😀".slice(0, 1);

let adapter: DatabaseAdapter;

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
});

afterAll(async () => {
  await adapter.close();
});

/** The value written through the same jsonb parameter the audit's insert uses, read back. */
async function roundTrip(value: unknown): Promise<unknown> {
  return adapter.withAdminTransaction(SYSTEM, async (tx) => {
    const rows = (await tx.execute(sql`SELECT ${jsonbParam(value)} AS v`)) as unknown as {
      v: unknown;
    }[];
    return rows[0]?.v;
  });
}

describe("a finding quoting half of a character", () => {
  const raw = {
    ruleId: "structured-data/invalid-json",
    severity: "error",
    pageId: "00000000-0000-4000-8000-000000000001",
    message: `Broken structured data: a JSON-LD block is not valid JSON (Unrecognized token '${HALF}').`,
    fix: { tool: "update_modules_many", hint: `Remove the stray ${HALF}.` },
  };

  it("is refused by jsonb as the check wrote it", async () => {
    await expect(roundTrip([raw])).rejects.toThrow();
  });

  it("records once it passed findingSchema, the half shown as U+FFFD", async () => {
    const finding = findingSchema.parse(raw);
    const stored = (await roundTrip([finding])) as (typeof finding)[];
    expect(stored[0]?.message).toContain("Unrecognized token '�'");
    expect(stored[0]?.fix?.hint).toBe("Remove the stray �.");
    // A whole character stays as it is.
    expect(findingSchema.parse({ ...raw, message: "Keeps 😀." }).message).toBe("Keeps 😀.");
  });

  it("records a check's error message the same way", async () => {
    const error = checkRunErrorSchema.parse({
      checkId: "structured-data",
      code: "check_threw",
      message: `Unrecognized token '${HALF}'`,
    });
    expect(await roundTrip([error])).toEqual([{ ...error, message: "Unrecognized token '�'" }]);
  });
});
