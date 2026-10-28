// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { installServingGuard, type SignalTarget } from "./serving-guard.js";

function fakeProcess(): { proc: SignalTarget; term: () => void; exits: number[] } {
  let listener: (() => void) | null = null;
  const exits: number[] = [];
  const proc = {
    on: (_signal: "SIGTERM", l: () => void) => {
      listener = l;
    },
    exit: (code: number) => {
      exits.push(code);
      return undefined as never;
    },
  };
  return { proc, term: () => listener?.(), exits };
}

describe("installServingGuard (#1211)", () => {
  it("a stop before the build is served ends the generator", () => {
    const { proc, term, exits } = fakeProcess();
    installServingGuard(proc);
    term();
    expect(exits).toEqual([143]);
  });

  it("a stop while current/ is being written is ignored, so it is never half-written", () => {
    const { proc, term, exits } = fakeProcess();
    const guard = installServingGuard(proc);
    guard.markServing();
    term();
    expect(exits).toEqual([]);
  });
});
