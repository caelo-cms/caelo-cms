// SPDX-License-Identifier: MPL-2.0

/**
 * #1339 (epic #763 P9, L5) — the Cloud Armor rules of the visitor gateway's
 * policy on `gcp` (`<prefix>-waf`), declared once for the stack (new
 * installs, imported from `dist/`) and for `cms-provision upgrade`
 * ({@link ensureGatewayArmorRules} in gateway-armor.ts, existing installs).
 * Pure module: no CLI or Pulumi imports.
 *
 * Cloud Armor is an extra layer here, never the only one (E3): the gateway
 * sheds junk and rate-limits every route itself (docs/dev/gateway-hardening.md),
 * and the cheap setup (gcp-firebase) has no WAF at all. What the edge adds
 * is a per-IP ban before a request costs a Cloud Run instance.
 *
 * The policy also fronts the staging gateway's backend (staging-gateway-setup.ts),
 * which serves whole staged pages. So the rules are per path:
 *
 *   - Credential operations of the auth plugin (signup, login, password
 *     reset) — the brute-force targets — get the tightest ban, 30 a minute
 *     per IP: above every per-operation limit the plugin declares, so a
 *     visitor behind a shared NAT is stopped by the gateway's own limit
 *     first, and only a flood earns the ban. The pattern is anchored (as in
 *     remote-mcp-edge.ts): a traversal or encoded variant cannot match it and
 *     falls through to the general rule below.
 *   - The captcha challenge is throttled (429, no ban) at 60 a minute, the
 *     gateway's own per-client budget (`CAPTCHA_CHALLENGE_RATE_LIMIT`).
 *   - Every other path containing `/api/` keeps the original ban of 100 a
 *     minute. It used to match every request, so a reviewer who browsed a
 *     few staged pages (each with its styles, scripts, fonts and images)
 *     was banned from staging for ten minutes; staged pages are not `/api/`
 *     and are throttled by the staging gate itself.
 *   - The OWASP sqli/xss packs at sensitivity 1, Google's recommended
 *     starting level: the default (all signatures) flags ordinary comment
 *     and form text as an attack.
 *
 * Priorities: lower runs first, the first matching rule decides; the MCP
 * throttle moved to the MCP-Auth-Proxy's own policy (#1328).
 */

import { GENERAL_RATE_LIMIT_PRIORITY, type LiveArmorRule } from "./remote-mcp-edge.js";

/**
 * Priority of the `/api/` ban. Not the old catch-all's (1000): the converge
 * creates this one first and deletes the old one only afterwards, so an
 * install is never without a ban (gateway-armor.ts).
 */
export const API_BAN_PRIORITY = GENERAL_RATE_LIMIT_PRIORITY + 1;

/**
 * The catch-all ban every policy carried before #1339 (`srcIpRanges: *`,
 * 100 a minute, 10-minute ban), retired by the converge once the rules
 * below are in place.
 */
export const LEGACY_GENERAL_BAN = {
  priority: GENERAL_RATE_LIMIT_PRIORITY,
  count: 100,
  intervalSec: 60,
  banDurationSec: 600,
} as const;

/** A per-IP rate rule of the gateway's policy. */
interface ArmorRateRule {
  readonly kind: "rate";
  readonly priority: number;
  readonly description: string;
  readonly expression: string;
  readonly action: "rate_based_ban" | "throttle";
  /** Requests per {@link intervalSec} per source IP. */
  readonly count: number;
  readonly intervalSec: number;
  /** Seconds an IP stays banned after it went over (rate_based_ban only). */
  readonly banDurationSec?: number;
}

/** A deny rule of the gateway's policy. */
interface ArmorDenyRule {
  readonly kind: "deny";
  readonly priority: number;
  readonly description: string;
  readonly expression: string;
  readonly action: "deny(403)";
}

export type GatewayArmorRule = ArmorRateRule | ArmorDenyRule;

/**
 * The auth plugin's credential operations, as an anchored RE2 pattern
 * (Cloud Armor's `matches`).
 */
export const CREDENTIAL_PATH_PATTERN =
  "^/api/plugin/auth/(signup|login|request_password_reset|reset_password)$";

/** Priority of Cloud Armor's default rule (it allows; every policy has one). */
export const DEFAULT_RULE_PRIORITY = 2147483647;

/** The gateway policy's rules, in evaluation order (the default allow excluded). */
export const GATEWAY_ARMOR_RULES: readonly GatewayArmorRule[] = [
  {
    kind: "rate",
    priority: 800,
    description: "Caelo gateway: per-IP ban on the auth plugin's credential operations",
    expression: `request.path.matches('${CREDENTIAL_PATH_PATTERN}')`,
    action: "rate_based_ban",
    count: 30,
    intervalSec: 60,
    banDurationSec: 600,
  },
  {
    kind: "rate",
    priority: 810,
    description: "Caelo gateway: per-IP throttle on captcha challenges",
    expression: "request.path == '/api/captcha/challenge'",
    action: "throttle",
    count: 60,
    intervalSec: 60,
  },
  {
    kind: "rate",
    priority: API_BAN_PRIORITY,
    description: "Caelo gateway: per-IP ban on the visitor API",
    expression: "request.path.contains('/api/')",
    action: "rate_based_ban",
    count: 100,
    intervalSec: 60,
    banDurationSec: 600,
  },
  {
    kind: "deny",
    priority: 2000,
    description: "Caelo gateway: OWASP SQL injection signatures (sensitivity 1)",
    expression: "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})",
    action: "deny(403)",
  },
  {
    kind: "deny",
    priority: 2001,
    description: "Caelo gateway: OWASP cross-site scripting signatures (sensitivity 1)",
    expression: "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})",
    action: "deny(403)",
  },
];

/**
 * Rules the gateway policy bills for, the default rule included (Cloud
 * Armor Standard prices every rule of a policy, cloud.google.com/armor/pricing).
 */
export const GATEWAY_ARMOR_BILLED_RULES = GATEWAY_ARMOR_RULES.length + 1;

/** One rule in the shape `gcp.compute.SecurityPolicy` `rules` take. */
function ruleArgs(r: GatewayArmorRule) {
  const base = {
    action: r.action,
    priority: r.priority,
    description: r.description,
    match: { expr: { expression: r.expression } },
  };
  if (r.kind === "deny") return base;
  return {
    ...base,
    rateLimitOptions: {
      rateLimitThreshold: { count: r.count, intervalSec: r.intervalSec },
      conformAction: "allow",
      exceedAction: "deny(429)",
      enforceOnKey: "IP",
      ...(r.banDurationSec !== undefined ? { banDurationSec: r.banDurationSec } : {}),
    },
  };
}

/** The gateway policy's rules for the `gcp` stack, the default allow last. */
export function gatewayArmorRuleArgs() {
  return [
    ...GATEWAY_ARMOR_RULES.map(ruleArgs),
    {
      action: "allow",
      priority: DEFAULT_RULE_PRIORITY,
      description: "default rule",
      match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
    },
  ];
}

/**
 * The `gcloud compute security-policies rules create` flags for `r`
 * (without the verb, priority and policy).
 */
export function gatewayArmorRuleFlags(r: GatewayArmorRule): string[] {
  const flags = [`--description=${r.description}`, `--expression=${r.expression}`];
  if (r.kind === "deny") return [...flags, "--action=deny-403"];
  return [
    ...flags,
    `--action=${r.action === "rate_based_ban" ? "rate-based-ban" : "throttle"}`,
    `--rate-limit-threshold-count=${r.count}`,
    `--rate-limit-threshold-interval-sec=${r.intervalSec}`,
    "--conform-action=allow",
    // gcloud spells deny(429) as deny-429.
    "--exceed-action=deny-429",
    "--enforce-on-key=IP",
    ...(r.banDurationSec !== undefined ? [`--ban-duration-sec=${r.banDurationSec}`] : []),
  ];
}

/** A live rule as `describe` lists it, with the ban duration a rate rule carries. */
export interface LiveGatewayArmorRule extends LiveArmorRule {
  readonly rateLimitOptions?: LiveArmorRule["rateLimitOptions"] & {
    readonly banDurationSec?: number;
  };
}

/** Whether a live rule is exactly `spec`. */
export function isGatewayArmorRule(live: LiveGatewayArmorRule, spec: GatewayArmorRule): boolean {
  if (live.priority !== spec.priority || live.action !== spec.action) return false;
  if (live.match?.expr?.expression !== spec.expression) return false;
  const o = live.rateLimitOptions;
  if (spec.kind === "deny") return o === undefined;
  return (
    o?.rateLimitThreshold?.count === spec.count &&
    o?.rateLimitThreshold?.intervalSec === spec.intervalSec &&
    o?.conformAction === "allow" &&
    o?.exceedAction === "deny(429)" &&
    (o?.enforceOnKey ?? "ALL") === "IP" &&
    o?.banDurationSec === spec.banDurationSec
  );
}

/** The rate-limit options the pre-#1339 stack set on the catch-all ban. */
const LEGACY_RATE_OPTION_KEYS = new Set([
  "rateLimitThreshold",
  "conformAction",
  "exceedAction",
  "enforceOnKey",
  "banDurationSec",
]);

/** Whether a live rule is exactly {@link LEGACY_GENERAL_BAN}; any other rule at its priority is the Owner's. */
export function isLegacyGeneralBan(live: LiveGatewayArmorRule): boolean {
  const l = LEGACY_GENERAL_BAN;
  const o = live.rateLimitOptions;
  const config = (live.match as { config?: { srcIpRanges?: readonly string[] } } | undefined)
    ?.config;
  return (
    live.priority === l.priority &&
    live.action === "rate_based_ban" &&
    live.match?.expr === undefined &&
    JSON.stringify(config?.srcIpRanges ?? null) === JSON.stringify(["*"]) &&
    o?.rateLimitThreshold?.count === l.count &&
    o?.rateLimitThreshold?.intervalSec === l.intervalSec &&
    o?.banDurationSec === l.banDurationSec &&
    o?.conformAction === "allow" &&
    o?.exceedAction === "deny(429)" &&
    o?.enforceOnKey === "IP" &&
    // Every other option the old stack never set (a ban threshold, an
    // enforce-on-key config, a redirect, …) makes it an Owner's rule.
    Object.keys(o ?? {}).every((k) => LEGACY_RATE_OPTION_KEYS.has(k))
  );
}
