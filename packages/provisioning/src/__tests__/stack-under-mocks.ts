// SPDX-License-Identifier: MPL-2.0

/**
 * Runs one stack program (`stacks/<provider>/index.ts`) under Pulumi mocks
 * and prints the resources it declares as JSON lines on stdout — one process
 * per run, because a stack program is a module that declares its resources
 * once, on import. Used by tests that pin what a given stack config
 * declares (gateway-bootstrap.test.ts).
 *
 * Usage: bun src/__tests__/stack-under-mocks.ts <gcp|gcp-firebase> '<config JSON>'
 * where the config JSON maps unprefixed keys (`domain`) to string values.
 * Needs the package's `dist/` (the stacks import from it): `tsc -b` first.
 */

import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { CLOUD_SQL_PSA_CONNECTION_TYPE } from "../stack-contract.js";

const [provider, configJson] = process.argv.slice(2);
if (provider !== "gcp" && provider !== "gcp-firebase") {
  throw new Error(`usage: stack-under-mocks.ts <gcp|gcp-firebase> '<config JSON>'`);
}
const project = `caelo-${provider}`;
const config = JSON.parse(configJson ?? "{}") as Record<string, string>;
pulumi.runtime.setAllConfig(
  Object.fromEntries(Object.entries(config).map(([k, v]) => [`${project}:${k}`, v])),
);

/** One declared resource: its type, logical name and, when set, its fixed cloud name. */
const declared: { type: string; name: string; cloudName?: string }[] = [];
pulumi.runtime.setMocks(
  {
    newResource: (args) => {
      declared.push({
        type: args.type,
        name: args.name,
        ...(typeof args.inputs.name === "string" ? { cloudName: args.inputs.name } : {}),
      });
      const state: Record<string, unknown> = {
        ...args.inputs,
        name: args.inputs.name ?? args.name,
      };
      // The stacks refuse a Cloud SQL instance without its private DNS name (#1338).
      if (args.type === "gcp:sql/databaseInstance:DatabaseInstance") {
        state.dnsNames = [
          {
            connectionType: CLOUD_SQL_PSA_CONNECTION_TYPE,
            name: "db1.p-label.europe-west1.sql-psa.goog.",
          },
        ];
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args) => args.inputs,
  },
  project,
  "production",
  false,
);

await import(resolve(import.meta.dir, `../../stacks/${provider}/index.ts`));
// Resources that wait on another's outputs register later: wait until no
// new one has arrived for a while.
for (let seen = -1, stable = 0; stable < 5; ) {
  await new Promise((r) => setTimeout(r, 100));
  stable = declared.length === seen ? stable + 1 : 0;
  seen = declared.length;
}
for (const d of declared) process.stdout.write(`${JSON.stringify(d)}\n`);
