// SPDX-License-Identifier: MPL-2.0

/**
 * #1339 — bring the visitor gateway's Cloud Armor policy on an existing
 * `gcp` install to the rules of gateway-edge.ts (infrastructure contract
 * 21). The stack declares the same rules for new installs; the converge
 * runs this, because the in-cloud upgrader holds no compute rights.
 *
 * Per rule: present and exactly to spec → left alone; present but
 * different → deleted and created again (Cloud Armor cannot turn a
 * source-IP match into an expression match in place, which the general
 * ban rule needs); missing → created. Rules at other priorities are the
 * Owner's own and stay.
 */

import {
  GATEWAY_ARMOR_RULES,
  gatewayArmorRuleFlags,
  isGatewayArmorRule,
  type LiveGatewayArmorRule,
} from "./gateway-edge.js";
import { gcloud as defaultGcloud } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { gcpNamePrefix } from "./gcp-names.js";

/** What {@link ensureGatewayArmorRules} did, or why it could not. */
export type GatewayArmorResult =
  | { readonly ok: true; readonly policy: string; readonly done: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly done: readonly string[] };

/**
 * Apply {@link GATEWAY_ARMOR_RULES} to the gateway's `<prefix>-waf*` policy.
 *
 * @param target the install's project and environment
 * @returns the lines it changed (empty when every rule was already in place)
 */
export async function ensureGatewayArmorRules(
  target: { readonly projectId: string; readonly env: string },
  deps: { run?: GcloudRunner } = {},
): Promise<GatewayArmorResult> {
  const run = deps.run ?? defaultGcloud;
  const project = `--project=${target.projectId}`;
  const done: string[] = [];
  const prefix = `${gcpNamePrefix(target.env)}-waf`;
  const list = await run([
    "compute",
    "security-policies",
    "list",
    project,
    `--filter=name~^${prefix}`,
    "--format=value(name)",
  ]);
  if (!list.ok) return { ok: false, error: `list security policies: ${list.stderr.trim()}`, done };
  const names = list.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Pulumi names the policy `<prefix>-waf-<suffix>`; the MCP-Auth-Proxy's is `<prefix>-mcp-auth-proxy-armor`.
  if (names.length !== 1) {
    return {
      ok: false,
      error: `expected exactly one ${prefix}* Cloud Armor policy, found ${names.length}`,
      done,
    };
  }
  const policy = names[0] as string;
  const describe = await run([
    "compute",
    "security-policies",
    "describe",
    policy,
    project,
    "--format=json",
  ]);
  if (!describe.ok) {
    return { ok: false, error: `describe ${policy}: ${describe.stderr.trim()}`, done };
  }
  let live: LiveGatewayArmorRule[];
  try {
    live = ((JSON.parse(describe.stdout) as { rules?: LiveGatewayArmorRule[] }).rules ??
      []) as LiveGatewayArmorRule[];
  } catch {
    return { ok: false, error: `describe ${policy}: output is not JSON`, done };
  }
  for (const spec of GATEWAY_ARMOR_RULES) {
    const existing = live.find((r) => r.priority === spec.priority);
    if (existing && isGatewayArmorRule(existing, spec)) continue;
    const rule = ["compute", "security-policies", "rules"];
    const at = [String(spec.priority), `--security-policy=${policy}`, project];
    if (existing) {
      const removed = await run([...rule, "delete", ...at, "--quiet"]);
      if (!removed.ok) {
        return {
          ok: false,
          error: `delete rule ${spec.priority} on ${policy}: ${removed.stderr.trim()}`,
          done,
        };
      }
    }
    const created = await run([
      ...rule,
      "create",
      ...at,
      ...gatewayArmorRuleFlags(spec),
      "--quiet",
    ]);
    if (!created.ok) {
      return {
        ok: false,
        error: `create rule ${spec.priority} on ${policy}: ${created.stderr.trim()}`,
        done,
      };
    }
    done.push(`${existing ? "replaced" : "created"} rule ${spec.priority}: ${spec.description}`);
  }
  return { ok: true, policy, done };
}
