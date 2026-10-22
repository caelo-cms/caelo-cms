// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { GoogleCallError, unknownPrincipalOf } from "./google-iam.js";

const refused = (message: string, status = 400) =>
  new GoogleCallError("setIamPolicy failed", status, JSON.stringify({ error: { message } }));

describe("unknownPrincipalOf", () => {
  it("names the member IAM refused as a nonexistent account, lowercased", () => {
    expect(unknownPrincipalOf(refused("User Test-597@searchviu.com does not exist."))).toBe(
      "user:test-597@searchviu.com",
    );
    expect(unknownPrincipalOf(refused("Group ops@x.com does not exist."))).toBe("group:ops@x.com");
    expect(
      unknownPrincipalOf(refused("Service account a@p.iam.gserviceaccount.com does not exist.")),
    ).toBe("serviceAccount:a@p.iam.gserviceaccount.com");
  });

  it("is null for every other failure", () => {
    expect(unknownPrincipalOf(refused("Policy update access denied.", 403))).toBeNull();
    expect(unknownPrincipalOf(refused("Invalid argument."))).toBeNull();
    expect(unknownPrincipalOf(new GoogleCallError("x", 400, "not json"))).toBeNull();
    expect(unknownPrincipalOf(new Error("User a@b.com does not exist."))).toBeNull();
  });
});
