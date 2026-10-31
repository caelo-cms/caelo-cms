// SPDX-License-Identifier: MPL-2.0

/** #1254 — the generator child sizes its pools from its own budget entry. */

import { describe, expect, it } from "bun:test";
import { GENERATOR_POOL_MAX } from "@caelo-cms/shared";
import { generatorEnv } from "./generator-subprocess.js";

describe("generatorEnv", () => {
  it("overrides the admin's pool sizes and keeps everything else", () => {
    const env = generatorEnv({
      CAELO_DB_POOL_MAX: "7",
      CAELO_DB_PUBLIC_POOL_MAX: "4",
      ADMIN_DATABASE_URL: "postgres://x",
    });
    expect(env.CAELO_DB_POOL_MAX).toBe(String(GENERATOR_POOL_MAX));
    expect(env.CAELO_DB_PUBLIC_POOL_MAX).toBe(String(GENERATOR_POOL_MAX));
    expect(env.ADMIN_DATABASE_URL).toBe("postgres://x");
  });
});
