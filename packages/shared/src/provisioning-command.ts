// SPDX-License-Identifier: MPL-2.0

/**
 * The `bunx @caelo-cms/provisioning …` commands Caelo prints — in the CLI's
 * own next-step hints, `status`, and the admin's Settings → Updates page
 * (issue #696 Phase 0).
 *
 * Every command names an exact package version. Without one, `bunx` reuses
 * whatever copy of the CLI it cached first and never looks again, so an
 * operator who installed months ago would upgrade with months-old upgrade
 * logic (the same trap #552 fixed for the MCP shim). The version is always
 * one the caller knows for certain: the running CLI's own, or the release
 * the release check reported — never "whatever is newest".
 */

import { parseVersion } from "./version.js";

/** npm name of the provisioning CLI. */
export const PROVISIONING_PACKAGE = "@caelo-cms/provisioning";

/**
 * A hostname the `--install` flag can carry into a copy-pasted shell
 * command: letters, digits, dots and hyphens only, so nothing in it can be
 * read by the shell.
 */
const SAFE_INSTALL_HINT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * `bunx @caelo-cms/provisioning@<version> <args>`.
 *
 * @param version an exact release (`0.10.44`, a leading `v` is dropped);
 *   throws on anything that is not a version, so a tag like `latest` can
 *   never slip into a printed command.
 * @param args the CLI arguments, already split.
 * @example provisioningCommand("0.10.44", ["status"])
 *   // → "bunx @caelo-cms/provisioning@0.10.44 status"
 */
export function provisioningCommand(version: string, args: readonly string[] = []): string {
  const exact = parseVersion(version.replace(/^v/, "")).raw;
  return [`bunx ${PROVISIONING_PACKAGE}@${exact}`, ...args].join(" ");
}

/**
 * The upgrade command for one install, pinned twice: the CLI runs as the
 * target release (its upgrade logic matches the release it installs) and
 * `--version` makes it roll exactly that release, even if a newer one ships
 * before the operator runs it (without the flag, `upgrade` rolls the
 * registry's `latest` tag).
 *
 * @param args.version the release to install.
 * @param args.install the install's domain (or install id); `upgrade`
 *   matches either against `~/.caelo-<id>/install.json`.
 * @example provisioningUpgradeCommand({ version: "0.10.44", install: "example.com" })
 *   // → "bunx @caelo-cms/provisioning@0.10.44 upgrade --version 0.10.44 --install example.com"
 */
export function provisioningUpgradeCommand(args: { version: string; install: string }): string {
  const version = parseVersion(args.version.replace(/^v/, "")).raw;
  if (!SAFE_INSTALL_HINT.test(args.install)) {
    throw new Error(`not a domain or install id: ${JSON.stringify(args.install)}`);
  }
  return provisioningCommand(version, ["upgrade", "--version", version, "--install", args.install]);
}

/**
 * The `--install` value for the install whose public site is `siteUrl`
 * (the admin's `CAELO_SITE_URL`, which the stacks set to
 * `https://<domain>` — the same domain `install.json` records).
 *
 * @returns the lower-cased hostname, or null when `siteUrl` is not a URL
 *   or its host is not a plain domain (an IP literal with a port, say).
 */
export function installHintFromSiteUrl(siteUrl: string): string | null {
  let host: string;
  try {
    host = new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  return SAFE_INSTALL_HINT.test(host) ? host : null;
}
