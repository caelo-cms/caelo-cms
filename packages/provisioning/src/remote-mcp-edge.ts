// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — what the `gcp` stack's load balancer does for remote MCP, declared
 * once for the stack (new installs, imported from `dist/`) and for
 * `cms-provision upgrade` (remote-mcp.ts `ensureRemoteMcpEdge`, existing
 * installs). Pure module: no CLI or Pulumi imports.
 *
 * Routing: the broker's discovery documents live at the host root
 * (`/.well-known/oauth-*`); the URL map sends those prefixes to the gateway
 * together with `/api/*` (`GCP_PUBLIC_BASE_PATHS` in @caelo-cms/shared).
 *
 * Cloud Armor: the stack's policy bans an IP for 10 minutes after 100
 * requests a minute and denies anything the OWASP sqli/xss rule packs flag.
 * Both are wrong for `/api/mcp/*`:
 *
 *   - MCP bodies carry HTML legitimately (module markup, page content the
 *     agent writes through Caelo's tools), which the xss/sqli packs flag.
 *     The broker accepts only bearer-authenticated JSON-RPC that the
 *     IAP-gated admin validates with Zod; Cloud Armor's signature match
 *     adds false positives there, not protection.
 *   - claude.ai and ChatGPT call from their own shared egress IPs, so every
 *     user of an install arrives from a handful of addresses. One agent
 *     session issues a JSON-RPC POST per tool call (plus initialize and
 *     notifications) — a busy Power-MCP agent sustains 1–3 a second. A
 *     100/min ban would cut every user behind the same connector for 10
 *     minutes after one busy session.
 *
 * So the MCP paths ({@link MCP_ARMOR_PATH_PATTERN}) get their own rule, evaluated before the general ones
 * (lower priority number = earlier; the first matching rule decides): a
 * per-IP *throttle* of 600 requests a minute — about five busy agent
 * sessions per egress IP — answering 429 above it without a ban, so a burst
 * slows down instead of locking everyone out. Below the threshold the
 * rule's action is `allow`, which ends evaluation: the OWASP packs and the
 * general ban do not run for these paths. Abuse stays bounded by the
 * gateway's max instances (100) and by IAP, which rejects every request
 * without a valid token of an allowlisted user before it reaches the admin.
 */

/**
 * The paths the MCP rule covers, as an anchored RE2 pattern (Cloud Armor's
 * `matches`): the two MCP endpoints and the broker's `oauth/<name>` and
 * `oauth/<name>/<surface>` routes — lowercase letters and hyphens only.
 *
 * Deliberately not a prefix match. A `startsWith('/api/mcp/')` rule also
 * matches `/api/mcp/../forms/submit` or `/api/mcp/%2e%2e/comments`, which
 * the gateway's URL parser normalises to `/api/forms/submit` — so any
 * public write could borrow the MCP rule's 600/min throttle and skip the
 * OWASP packs and the ban. No dot, no percent sign and no extra segment can
 * match this pattern, so a traversal falls through to the general rules.
 * The dotted metadata aliases (`/.well-known/…`, `oauth/.well-known/…`) are
 * one-off GETs per connection and stay under the general rules.
 */
export const MCP_ARMOR_PATH_PATTERN = "^/api/mcp/(chat|admin|oauth/[a-z-]+(/[a-z-]+)?)$";

/** The general per-IP ban rule and the OWASP rule packs the MCP rule must precede. */
export const GENERAL_RATE_LIMIT_PRIORITY = 1000;
export const OWASP_RULE_PRIORITIES: readonly number[] = [2000, 2001];

/** The `/api/mcp/*` rule of the gateway's Cloud Armor policy (see the module comment). */
export const MCP_ARMOR_RULE = {
  priority: 900,
  description: "Caelo remote MCP: per-IP throttle sized for agent traffic; skips the OWASP packs",
  expression: `request.path.matches('${MCP_ARMOR_PATH_PATTERN}')`,
  action: "throttle",
  /** Requests per {@link MCP_ARMOR_RULE.intervalSec} per source IP. */
  count: 600,
  intervalSec: 60,
  conformAction: "allow",
  exceedAction: "deny(429)",
  enforceOnKey: "IP",
} as const;

/** {@link MCP_ARMOR_RULE} in the shape `gcp.compute.SecurityPolicy` `rules` take. */
export function mcpArmorRuleArgs() {
  const r = MCP_ARMOR_RULE;
  return {
    action: r.action,
    priority: r.priority,
    description: r.description,
    match: { expr: { expression: r.expression } },
    rateLimitOptions: {
      rateLimitThreshold: { count: r.count, intervalSec: r.intervalSec },
      conformAction: r.conformAction,
      exceedAction: r.exceedAction,
      enforceOnKey: r.enforceOnKey,
    },
  };
}

/**
 * The `gcloud compute security-policies rules create|update` flags for
 * {@link MCP_ARMOR_RULE} (without the verb, priority and policy).
 */
export function mcpArmorRuleFlags(): string[] {
  const r = MCP_ARMOR_RULE;
  return [
    `--description=${r.description}`,
    `--expression=${r.expression}`,
    `--action=${r.action}`,
    `--rate-limit-threshold-count=${r.count}`,
    `--rate-limit-threshold-interval-sec=${r.intervalSec}`,
    `--conform-action=${r.conformAction}`,
    // gcloud spells deny(429) as deny-429.
    "--exceed-action=deny-429",
    `--enforce-on-key=${r.enforceOnKey}`,
  ];
}

/** A Cloud Armor rule as `gcloud compute security-policies describe --format=json` lists it. */
export interface LiveArmorRule {
  readonly priority?: number;
  readonly action?: string;
  readonly match?: { readonly expr?: { readonly expression?: string } };
  readonly rateLimitOptions?: {
    readonly rateLimitThreshold?: { readonly count?: number; readonly intervalSec?: number };
    readonly conformAction?: string;
    readonly exceedAction?: string;
    readonly enforceOnKey?: string;
  };
}

/** Whether a live rule is exactly {@link MCP_ARMOR_RULE}. */
export function isMcpArmorRule(rule: LiveArmorRule): boolean {
  const r = MCP_ARMOR_RULE;
  const o = rule.rateLimitOptions;
  return (
    rule.priority === r.priority &&
    rule.action === r.action &&
    rule.match?.expr?.expression === r.expression &&
    o?.rateLimitThreshold?.count === r.count &&
    o?.rateLimitThreshold?.intervalSec === r.intervalSec &&
    o?.conformAction === r.conformAction &&
    o?.exceedAction === r.exceedAction &&
    (o?.enforceOnKey ?? "ALL") === r.enforceOnKey
  );
}
