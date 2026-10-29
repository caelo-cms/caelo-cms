// SPDX-License-Identifier: MPL-2.0

/** Unit tests for the list ops' shared refusal text. */

import { describe, expect, it } from "bun:test";
import { describeIssues } from "./_shared.js";

describe("describeIssues", () => {
  // #1237: the refusal read 'pick another loop name.. Fix the definition'
  // because the issue sentence and the caller both ended the sentence.
  it("drops each issue's trailing period so the caller's sentence ends once", () => {
    const text = describeIssues([
      { path: "a", message: 'children name "items" is reserved — pick another loop name.' },
      { path: "b", message: "duplicate field name." },
    ]);
    expect(`${text}. Fix the definition.`).toBe(
      'a: children name "items" is reserved — pick another loop name; b: duplicate field name. Fix the definition.',
    );
  });
});
