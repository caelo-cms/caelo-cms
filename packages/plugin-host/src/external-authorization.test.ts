// SPDX-License-Identifier: MPL-2.0

/**
 * #1267 scale gate — a permission check that could not run is not a "no".
 * Under a busy pool the check's own operation failed and the host answered
 * "needs the content.write permission … ask an Owner" to an Owner.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import type { PluginHostInfra } from "./dispatch.js";
import { operatorHasPermission } from "./external-authorization.js";

const SYSTEM = "00000000-0000-4000-8000-000000000001";
const OPERATOR = "11111111-1111-4111-8111-111111111111";
const BUSY =
  "the admin database pool had no free connection for plugin_external.operator_has_permission within 10000 ms";

function infraAnswering(answer: "busy" | boolean): PluginHostInfra {
  const adapter = {
    runOperation: async (op: { name: string }) =>
      answer === "busy"
        ? err({ kind: "HandlerError", operation: op.name, message: BUSY })
        : ok({ allowed: answer }),
  } as unknown as DatabaseAdapter;
  return { registry: new OperationRegistry(), adapter } as unknown as PluginHostInfra;
}

describe("operatorHasPermission", () => {
  it("answers the check's result", async () => {
    expect(
      await operatorHasPermission(infraAnswering(true), SYSTEM, OPERATOR, "content.write"),
    ).toBe(true);
    expect(
      await operatorHasPermission(infraAnswering(false), SYSTEM, OPERATOR, "content.write"),
    ).toBe(false);
  });

  it("throws, naming the cause, when the check could not run", async () => {
    await expect(
      operatorHasPermission(infraAnswering("busy"), SYSTEM, OPERATOR, "content.write"),
    ).rejects.toThrow(/could not check the content.write permission.*no free connection/);
  });
});
