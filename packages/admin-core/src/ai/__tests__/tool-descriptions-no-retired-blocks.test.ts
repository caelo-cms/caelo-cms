// SPDX-License-Identifier: MPL-2.0

/**
 * The system prompt is fully static (CLAUDE.md §11): the old dynamic
 * site-state blocks are gone. Only `# Current page` and the site status
 * note remain, and they ride on the user message. A tool description that still sends the AI
 * to one of them points at nothing, and the AI either guesses or asks the
 * operator. Live state is read with the list_/get_ tools instead.
 */

import { describe, expect, it } from "bun:test";
import { createDefaultToolRegistry } from "../tools/index.js";

const RETIRED_BLOCKS = [
  "## Content Library",
  "## Layouts",
  "## Templates",
  "## Modules",
  "# All pages",
  "# Site defaults",
  "## Site identity",
  "## Pending proposals",
  "## Users",
  "## Roles",
  "## Domains",
  "# Plugins",
  "structured set",
];

describe("tool descriptions", () => {
  it("never point at a retired system-prompt block", () => {
    const offenders: string[] = [];
    for (const t of createDefaultToolRegistry().list()) {
      const text = `${t.description}\n${JSON.stringify(t.inputSchema)}`;
      for (const block of RETIRED_BLOCKS) {
        if (text.includes(block)) offenders.push(`${t.name}: ${block}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
