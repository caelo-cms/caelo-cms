// SPDX-License-Identifier: MPL-2.0

/** #1763 — the llms.txt switch: off by default, honest about what it is. */

import { describe, expect, it } from "bun:test";
import {
  manifestFromDefinition,
  type PluginContextTier1,
  pluginManifest,
} from "@caelo-cms/plugin-sdk";
import {
  AGENT_FILES_OPERATION,
  agentFiles,
  LLMS_TXT_CONFIG,
  LLMS_TXT_SETTING,
} from "./agent-files.js";
import seo from "./index.js";

const withConfig = (config: Record<string, unknown>) =>
  ({ config: { get: async () => config } }) as unknown as PluginContextTier1;

describe("llms.txt switch", () => {
  it("is off by default and waits for the Stage", () => {
    expect(LLMS_TXT_CONFIG).toMatchObject({ type: "bool", default: false, scope: "release" });
    expect(LLMS_TXT_CONFIG.description).toContain("no ranking lever");
    expect(LLMS_TXT_CONFIG.description).toContain("97%");
  });

  it("answers what the setting says", async () => {
    expect(await agentFiles(withConfig({ [LLMS_TXT_SETTING]: true }))).toEqual({ llmsTxt: true });
    expect(await agentFiles(withConfig({ [LLMS_TXT_SETTING]: false }))).toEqual({ llmsTxt: false });
    await expect(agentFiles(withConfig({}))).rejects.toThrow("not a yes or no");
  });

  it("is declared on the manifest", () => {
    const manifest = pluginManifest.parse(manifestFromDefinition(seo));
    expect(manifest.agentFilesOperation).toBe(AGENT_FILES_OPERATION);
    expect(manifest.operations).toContain(AGENT_FILES_OPERATION);
    expect(manifest.config?.[LLMS_TXT_SETTING]).toBeDefined();
  });
});
