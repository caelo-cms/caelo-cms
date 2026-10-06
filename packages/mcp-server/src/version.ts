// SPDX-License-Identifier: MPL-2.0

/**
 * The package's own version, reported as `serverInfo.version` in the MCP
 * initialize result. Read from this package's package.json (shipped in
 * the npm tarball via `files`) rather than hard-coded, so it can't drift
 * from the release: every workspace package is version-locked to
 * `CAELO_VERSION` (`scripts/release.ts --check`). Resolved relative to
 * this module, which works from both `src/` (bun) and `dist/` (npm).
 */

import { readFileSync } from "node:fs";

export const MCP_SERVER_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
