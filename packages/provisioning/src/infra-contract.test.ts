// SPDX-License-Identifier: MPL-2.0

/**
 * Every infrastructure contract version names the step it adds, so the
 * upgrader's refusal tells the Owner what the converge will change.
 */

import { describe, expect, it } from "bun:test";
import {
  INFRA_CONTRACT_STEPS,
  INFRA_CONTRACT_VERSION,
  infraStepsText,
  pendingInfraSteps,
} from "./infra-contract.js";

describe("infrastructure contract steps", () => {
  it("describes every version up to the current one, and no other", () => {
    expect(Object.keys(INFRA_CONTRACT_STEPS).map(Number)).toEqual(
      Array.from({ length: INFRA_CONTRACT_VERSION }, (_, i) => i + 1),
    );
  });

  it("is at 12: public_role revoke (3), URL-map redirects role (4), no gateway cms_admin login (5), ops-bucket list (6), gateway proxy hops (7), quality-audit job (8), converge job (9), remote MCP (10), Google sign-in (11), edge security headers (12)", () => {
    expect(INFRA_CONTRACT_VERSION).toBe(12);
    expect(INFRA_CONTRACT_STEPS[3]).toContain("#633");
    expect(INFRA_CONTRACT_STEPS[4]).toContain("#587");
    expect(INFRA_CONTRACT_STEPS[5]).toContain("#635");
    expect(INFRA_CONTRACT_STEPS[6]).toContain("#799");
    expect(INFRA_CONTRACT_STEPS[7]).toContain("#845");
    expect(INFRA_CONTRACT_STEPS[8]).toContain("#875");
    expect(INFRA_CONTRACT_STEPS[9]).toContain("#819");
    expect(INFRA_CONTRACT_STEPS[10]).toContain("#806");
    expect(INFRA_CONTRACT_STEPS[11]).toContain("#914");
    expect(INFRA_CONTRACT_STEPS[12]).toContain("#891");
  });

  it("lists the pending steps oldest first", () => {
    expect(pendingInfraSteps(2, 4)).toEqual([INFRA_CONTRACT_STEPS[3], INFRA_CONTRACT_STEPS[4]]);
    expect(pendingInfraSteps(3, 4)).toEqual([INFRA_CONTRACT_STEPS[4]]);
    expect(pendingInfraSteps(4, 4)).toEqual([]);
    expect(pendingInfraSteps(0, 1)).toEqual([INFRA_CONTRACT_STEPS[1]]);
  });

  it("names a version a newer release added by number", () => {
    expect(infraStepsText(12, 13)).toBe("infrastructure step 13 (see that release's notes)");
  });
});
