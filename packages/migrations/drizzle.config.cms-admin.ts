// SPDX-License-Identifier: MPL-2.0

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/cms_admin/index.ts",
  out: "./migrations/cms_admin",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["ADMIN_DATABASE_URL"] ?? "",
  },
  strict: true,
  verbose: true,
});
