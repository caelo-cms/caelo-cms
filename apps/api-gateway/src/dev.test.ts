// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { gatewayDatabaseUrls } from "./database-env.js";
import { gatewayDevEnv } from "./dev.js";

/** The shared root .env of the documented dev setup (.env.example). */
const ROOT_ENV = {
  ADMIN_DATABASE_URL: "postgres://admin_role:a@localhost:5432/cms_admin",
  PUBLIC_ADMIN_DATABASE_URL: "postgres://admin_role:a@localhost:5432/cms_public",
  PUBLIC_DATABASE_URL: "postgres://public_role:p@localhost:5432/cms_public",
  GATEWAY_DATABASE_URL: "postgres://gateway_role:g@localhost:5432/cms_admin",
  CAELO_SITE_URL: "http://localhost:8082",
};

describe("gateway dev launcher (#613 review)", () => {
  it("the strict guard refuses the shared root .env as is", () => {
    expect(() => gatewayDatabaseUrls(ROOT_ENV)).toThrow(/must not hold admin_role credentials/);
  });

  it("starts the gateway from it with the admin credentials left out", () => {
    const env = gatewayDevEnv({ ...ROOT_ENV, ADMIN_DATABASE_PASSWORD: "x", UNSET: undefined });
    expect(Object.keys(env).sort()).toEqual([
      "CAELO_SITE_URL",
      "GATEWAY_DATABASE_URL",
      "PUBLIC_DATABASE_URL",
    ]);
    expect(gatewayDatabaseUrls(env)).toEqual({
      gateway: ROOT_ENV.GATEWAY_DATABASE_URL,
      public: ROOT_ENV.PUBLIC_DATABASE_URL,
    });
  });
});
