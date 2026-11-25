// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1689 — create an install's roles and databases on a shared
 * Postgres server from a template install (template-install.ts), for
 * hosting providers. Ships in the admin image next to migrate.ts:
 *
 *   bun run packages/migrations/src/install-from-template.ts
 *
 * Env:
 *   CAELO_SUPERUSER_DATABASE_URL    a superuser on the server's maintenance
 *                                   database (e.g. postgres); never an
 *                                   install's login
 *   CAELO_TEMPLATE_INSTALL_NAMES    the template install's name map (JSON)
 *   CAELO_INSTALL_NAMES             the new install's name map (JSON)
 *   ADMIN_ROLE_PASSWORD, PUBLIC_ROLE_PASSWORD, PUBLIC_STAGING_ROLE_PASSWORD
 *                                   the new install's three logins
 *   ADMIN_ROLE_CONNECTION_LIMIT     optional: the new admin login's
 *                                   CONNECTION LIMIT (the template's if unset)
 *
 * Prints one JSON line with what it created and how long each step took.
 * Then run the new install's migrations as usual (migrate.ts with its
 * CAELO_INSTALL_NAMES): they apply only what the template did not have.
 */

import {
  databaseUrlFromEnv,
  INSTALL_NAMES_ENV,
  type InstallNames,
  installNamesFromEnv,
  parseInstallNames,
} from "@caelo-cms/shared";
import type { SQL as SQLType } from "bun";
import { installFromTemplate } from "./template-install.js";

const SQL = (globalThis as { Bun?: { SQL: new (url: string, o?: { max?: number }) => SQLType } })
  .Bun?.SQL as unknown as new (
  url: string,
  o?: { max?: number },
) => SQLType;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`install-from-template: ${name} is required (see the file header)`);
    process.exit(1);
  }
  return value;
}

/** A name map from the JSON in `variable`. */
function namesFrom(variable: string): InstallNames {
  let json: unknown;
  try {
    json = JSON.parse(required(variable));
  } catch {
    console.error(`install-from-template: ${variable} is not JSON (an install name map, #1689)`);
    process.exit(1);
  }
  return parseInstallNames(json, variable);
}

const superuserUrl = databaseUrlFromEnv(["CAELO_SUPERUSER_DATABASE_URL"]);
if (!superuserUrl) required("CAELO_SUPERUSER_DATABASE_URL");
const base = new URL(superuserUrl as string);
const maintenanceDatabase = decodeURIComponent(base.pathname.replace(/^\//, ""));
if (maintenanceDatabase === "") {
  console.error(
    "install-from-template: CAELO_SUPERUSER_DATABASE_URL names no database; name the server's maintenance database (e.g. /postgres)",
  );
  process.exit(1);
}
const template = namesFrom("CAELO_TEMPLATE_INSTALL_NAMES");
required(INSTALL_NAMES_ENV);
const target = installNamesFromEnv();
const limit = process.env.ADMIN_ROLE_CONNECTION_LIMIT;

const report = await installFromTemplate({
  connect: (database) => {
    const u = new URL(base);
    u.pathname = `/${encodeURIComponent(database)}`;
    return new SQL(u.toString(), { max: 2 });
  },
  maintenanceDatabase,
  template,
  target,
  passwords: {
    admin: required("ADMIN_ROLE_PASSWORD"),
    public: required("PUBLIC_ROLE_PASSWORD"),
    publicStaging: required("PUBLIC_STAGING_ROLE_PASSWORD"),
  },
  ...(limit ? { adminConnectionLimit: Number(limit) } : {}),
});
console.log(JSON.stringify(report));
