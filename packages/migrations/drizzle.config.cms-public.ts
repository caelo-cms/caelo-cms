// SPDX-License-Identifier: MPL-2.0

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/cms_public/index.ts",
  out: "./migrations/cms_public",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.PUBLIC_ADMIN_DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
