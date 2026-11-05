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

  it("is at 23: public_role revoke (3), URL-map redirects role (4), no gateway cms_admin login (5), ops-bucket list (6), gateway proxy hops (7), quality-audit job (8), converge job (9), remote MCP (10), Google sign-in (11), project-level sign-in client (12), edge security headers (13), capture job (14), database verify-full TLS (15), MCP-Auth-Proxy (16), staging database (17), scheduler tick (18), scheduler tick as JSON (19), staging gateway (20), gateway budget and plain-gcp repairs (21), per-path Cloud Armor rules (22), site security headers on the backend bucket (23)", () => {
    expect(INFRA_CONTRACT_VERSION).toBe(23);
    expect(INFRA_CONTRACT_STEPS[23]).toContain("#1454");
    expect(INFRA_CONTRACT_STEPS[3]).toContain("#633");
    expect(INFRA_CONTRACT_STEPS[4]).toContain("#587");
    expect(INFRA_CONTRACT_STEPS[5]).toContain("#635");
    expect(INFRA_CONTRACT_STEPS[6]).toContain("#799");
    expect(INFRA_CONTRACT_STEPS[7]).toContain("#845");
    expect(INFRA_CONTRACT_STEPS[8]).toContain("#875");
    expect(INFRA_CONTRACT_STEPS[9]).toContain("#819");
    expect(INFRA_CONTRACT_STEPS[10]).toContain("#806");
    expect(INFRA_CONTRACT_STEPS[11]).toContain("#914");
    expect(INFRA_CONTRACT_STEPS[12]).toContain("project's IAP settings");
    expect(INFRA_CONTRACT_STEPS[13]).toContain("#891");
    expect(INFRA_CONTRACT_STEPS[14]).toContain("#1217");
    expect(INFRA_CONTRACT_STEPS[15]).toContain("#1338");
    expect(INFRA_CONTRACT_STEPS[16]).toContain("#1328");
    expect(INFRA_CONTRACT_STEPS[17]).toContain("#1329");
    expect(INFRA_CONTRACT_STEPS[18]).toContain("#1140");
    expect(INFRA_CONTRACT_STEPS[19]).toContain("JSON");
    expect(INFRA_CONTRACT_STEPS[20]).toContain("#1330");
    expect(INFRA_CONTRACT_STEPS[21]).toContain("#1463");
    expect(INFRA_CONTRACT_STEPS[22]).toContain("#1339");
  });

  it("lists the pending steps oldest first", () => {
    expect(pendingInfraSteps(2, 4)).toEqual([INFRA_CONTRACT_STEPS[3], INFRA_CONTRACT_STEPS[4]]);
    expect(pendingInfraSteps(3, 4)).toEqual([INFRA_CONTRACT_STEPS[4]]);
    expect(pendingInfraSteps(4, 4)).toEqual([]);
    expect(pendingInfraSteps(0, 1)).toEqual([INFRA_CONTRACT_STEPS[1]]);
  });

  it("names a version a newer release added by number", () => {
    expect(infraStepsText(23, 24)).toBe("infrastructure step 24 (see that release's notes)");
  });
});
