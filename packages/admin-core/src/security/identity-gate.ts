// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — "can this email pass the install's identity gate?", asked
 * before a user is created (CLAUDE.md §2: no silent failures).
 *
 * Every cloud adapter puts the admin behind the provider's identity proxy
 * first (CLAUDE.md §11.B Tier 2); Caelo's own login is the second gate. A
 * user Caelo creates but the proxy will never let through is a silent
 * failure: they get a password and then "You don't have access". So user
 * creation asks the gate first, per provider:
 *
 *   - `gcp` / `gcp-firebase` (Google IAP): IAP's default, Google-managed
 *     OAuth client admits only accounts of the project's own Google
 *     organisation. An address outside it can pass only once the Owner has
 *     set up the install's Google sign-in client (Settings → Google
 *     sign-in), which IAP then signs people in with. The organisation's
 *     domain is read by the provisioner (`CAELO_GOOGLE_ORG_DOMAIN`, see
 *     packages/provisioning remote-mcp.ts) — the admin's own service account
 *     cannot read the organisation.
 *   - every other provider: passes. Their gates (Caddy forward_auth,
 *     ALB + Cognito, Easy Auth + Entra ID) are allowlisted by group in the
 *     provider's IdP, which Caelo does not manage yet; they answer for
 *     themselves once it does.
 */

/** Env var naming the project's Google organisation domain(s), or {@link NO_GOOGLE_ORGANISATION}. */
export const GOOGLE_ORG_DOMAIN_ENV = "CAELO_GOOGLE_ORG_DOMAIN";

/** {@link GOOGLE_ORG_DOMAIN_ENV} value for a project that is in no Google organisation. */
export const NO_GOOGLE_ORGANISATION = "none";

/** Where the Owner sets up the Google sign-in client. */
export const GOOGLE_SIGN_IN_SETTINGS_PATH = "/settings/google-sign-in";

/** Why an email cannot pass, as a structured, operator-facing answer. */
export type IdentityGateVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `outside-organisation` | `no-organisation` | `organisation-unknown`. */
      readonly code: "outside-organisation" | "no-organisation" | "organisation-unknown";
      readonly reason: string;
      readonly nextStep: string;
    };

/** One provider's identity gate. */
export interface IdentityGate {
  /** `google-iap` on Google Cloud installs; `none` where Caelo does not manage the gate. */
  readonly kind: "google-iap" | "none";
  /** The organisation's domains the gate admits without a sign-in client (google-iap only). */
  readonly organisationDomains: readonly string[] | "none" | "unknown";
  /** Whether `email` can pass, given whether the install's Google sign-in client is set up. */
  check(email: string, ctx: { readonly signInClientConfigured: boolean }): IdentityGateVerdict;
}

const PASS: IdentityGateVerdict = { ok: true };

const SET_UP_SIGN_IN = `Set up Google sign-in first: Settings → Google sign-in (${GOOGLE_SIGN_IN_SETTINGS_PATH}). With it, any Google account (Gmail or another company's Workspace) that is a user here can sign in. Then create the user again.`;

/** Lower-cased domain part of an email address ('' when there is none). */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0
    ? ""
    : email
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/** Parse {@link GOOGLE_ORG_DOMAIN_ENV}: a comma-separated domain list, `none`, or unset. */
export function parseOrganisationDomains(
  raw: string | undefined,
): readonly string[] | "none" | "unknown" {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value === NO_GOOGLE_ORGANISATION) return "none";
  return value
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

/** The Google IAP gate for an organisation (or `none` / `unknown`). */
export function googleIapGate(
  organisationDomains: readonly string[] | "none" | "unknown",
): IdentityGate {
  return {
    kind: "google-iap",
    organisationDomains,
    check(email, { signInClientConfigured }) {
      if (signInClientConfigured) return PASS;
      if (organisationDomains === "unknown") {
        return {
          ok: false,
          code: "organisation-unknown",
          reason: `Caelo cannot tell whether ${email} can pass Google IAP: this install does not know its Google organisation (\`cms-provision upgrade\` records it when the account running it may view the organisation). IAP's built-in sign-in admits only that organisation's accounts.`,
          nextStep: `${SET_UP_SIGN_IN} Alternatively re-run \`cms-provision upgrade\` as an account with the Organization Viewer role.`,
        };
      }
      if (organisationDomains === "none") {
        return {
          ok: false,
          code: "no-organisation",
          reason: `${email} cannot pass Google IAP yet: this Google Cloud project belongs to no organisation, and IAP's built-in sign-in admits no account there.`,
          nextStep: SET_UP_SIGN_IN,
        };
      }
      if (organisationDomains.includes(emailDomain(email))) return PASS;
      return {
        ok: false,
        code: "outside-organisation",
        reason: `${email} is outside this project's Google organisation (${organisationDomains.join(", ")}). Google IAP's built-in sign-in admits only that organisation's accounts, so this user would see "You don't have access".`,
        nextStep: SET_UP_SIGN_IN,
      };
    },
  };
}

/** Providers whose admin sits behind Google IAP. */
export const GOOGLE_IAP_PROVIDERS: ReadonlySet<string> = new Set(["gcp", "gcp-firebase"]);

/** A gate that Caelo does not manage: everyone passes this check. */
const UNMANAGED_GATE: IdentityGate = {
  kind: "none",
  organisationDomains: "unknown",
  check: () => PASS,
};

/** The env {@link identityGateFromEnv} reads. */
export interface IdentityGateEnv {
  readonly CAELO_PROVIDER?: string;
  readonly CAELO_GOOGLE_ORG_DOMAIN?: string;
}

/** The identity gate of the install described by `env`. */
export function identityGateFromEnv(env: IdentityGateEnv): IdentityGate {
  const provider = (env.CAELO_PROVIDER ?? "").trim();
  if (!GOOGLE_IAP_PROVIDERS.has(provider)) return UNMANAGED_GATE;
  return googleIapGate(parseOrganisationDomains(env.CAELO_GOOGLE_ORG_DOMAIN));
}

let envOverride: IdentityGateEnv | null = null;

/** Swap the env the gate is read from in tests (`null` restores process.env). */
export function setIdentityGateEnvForTests(env: IdentityGateEnv | null): void {
  envOverride = env;
}

/** This process's identity gate. */
export function currentIdentityGate(): IdentityGate {
  return identityGateFromEnv(
    envOverride ?? {
      CAELO_PROVIDER: process.env.CAELO_PROVIDER,
      CAELO_GOOGLE_ORG_DOMAIN: process.env[GOOGLE_ORG_DOMAIN_ENV],
    },
  );
}

/**
 * The emails among `emails` that pass `gate` only because the Google
 * sign-in client is set up — who cannot sign in without it (shown on the
 * setup page while it is missing, and in the warning before removing it).
 */
export function emailsNeedingSignInClient(gate: IdentityGate, emails: readonly string[]): string[] {
  return emails.filter((email) => !gate.check(email, { signInClientConfigured: false }).ok);
}

/** {@link IdentityGateVerdict} as one operator- and AI-facing sentence pair. */
export function identityGateMessage(verdict: Extract<IdentityGateVerdict, { ok: false }>): string {
  return `${verdict.reason} Next step: ${verdict.nextStep}`;
}
