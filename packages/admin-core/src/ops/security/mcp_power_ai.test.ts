// SPDX-License-Identifier: MPL-2.0

/**
 * #741 — which Power-MCP tools can spend the install's AI, and what the
 * agent is told about it. Pure: no database, no provider.
 */

import { describe, expect, it } from "bun:test";
import { createDefaultToolRegistry } from "../../ai/tools/index.js";
import { aiWorkContract, powerToolCatalogue, toolUsesInstallAi } from "./mcp_power.js";

const CORE_SPENDERS = ["generate_image", "edit_image", "query_page_html", "add_module"];

describe("toolUsesInstallAi", () => {
  const tools = createDefaultToolRegistry();

  it("is declared on every core tool that can call the install's provider", () => {
    for (const name of CORE_SPENDERS) expect(toolUsesInstallAi(tools, name)).toBe(true);
  });

  it("is not declared on tools that only read or write data", () => {
    for (const name of ["list_pages", "build_page", "set_media_alt_many", "propose_site_import"]) {
      if (tools.get(name)) expect(toolUsesInstallAi(tools, name)).toBe(false);
    }
  });
});

describe("powerToolCatalogue AI note", () => {
  const tools = createDefaultToolRegistry();

  it("tells an AI-delegated agent that the AI part comes back to it", () => {
    const listed = powerToolCatalogue(tools, { aiDelegated: true });
    const image = listed.find((t) => t.name === "generate_image");
    expect(image?.description).toContain("install's AI is not used");
    const plain = listed.find((t) => t.name === "list_pages");
    expect(plain?.description).not.toContain("install's AI is not used");
  });

  it("leaves descriptions untouched for a token that may use Caelo's AI", () => {
    const listed = powerToolCatalogue(tools, { aiDelegated: false });
    expect(listed.find((t) => t.name === "generate_image")?.description).not.toContain(
      "install's AI is not used",
    );
  });
});

describe("aiWorkContract", () => {
  it("describes the work-item protocol in both modes", () => {
    for (const allow of [true, false]) {
      const text = aiWorkContract(allow);
      expect(text).toContain("## AI work on this connection");
      expect(text).toContain("apply_translations");
      expect(text).toContain("resultArg");
    }
  });

  it("points a delegated agent at its own image upload instead of image generation", () => {
    const text = aiWorkContract(false);
    expect(text).toContain("not available to this token");
    expect(text).toContain("caelo_upload_images");
  });

  it("names the cost cap when the token may spend the install's AI", () => {
    expect(aiWorkContract(true)).toContain("cost cap");
  });
});
