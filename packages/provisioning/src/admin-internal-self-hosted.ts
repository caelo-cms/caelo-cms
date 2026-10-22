// SPDX-License-Identifier: MPL-2.0

/**
 * admin-internal.ts on a self-hosted install: from the install's host into
 * the admin container, never over the internet.
 *
 * The root of trust is the host: whoever may run `docker compose` for the
 * install already controls its database, its files and its secrets, so
 * reaching the admin's internal endpoints grants nothing new. The CLI signs
 * a 5-minute token for the endpoint's scope with `.caelo/internal-secret.json`
 * (the secret the Compose file gives the admin as `CAELO_INTERNAL_SECRET`)
 * and runs one `fetch` inside the admin container (`docker compose exec`)
 * against the admin's own port on 127.0.0.1 — the admin image has bun but
 * no curl.
 *
 * Nothing secret travels in process arguments, which other users of the
 * host can read in `ps`: the token and the request body go in on the exec's
 * stdin, the answer comes back on its stdout. `docker compose exec` output
 * is not part of the container's log (`docker compose logs` shows only the
 * container's main process), so the answer is written nowhere.
 */

import type {
  AdminInternalAnswer,
  AdminInternalCall,
  AdminInternalDeps,
  SelfHostedAdminTarget,
} from "./admin-internal.js";
import { readAdminAnswer } from "./admin-internal-answer.js";
import { mintInternalToken } from "./internal-token.js";
import { selfCommand } from "./self-command.js";
import { internalSecretPath, readInternalSecret } from "./self-hosted-internal-secret.js";
import { bunHostRunner } from "./self-hosted-release.js";
import { compose } from "./self-hosted-upgrade.js";

/** The admin's Compose service (compose.ts). */
const ADMIN_SERVICE = "caelo-admin";

/**
 * What runs inside the admin container. It reads `{ endpoint, token, body }`
 * from stdin, POSTs to the admin's own port and prints one JSON line:
 * `{ status, text }`, or `{ unreachable }` when the admin does not answer.
 * It holds no secret itself — it is visible in `ps` on the host.
 */
export const IN_CONTAINER_FETCH = `(async () => {
  const out = (o) => process.stdout.write(JSON.stringify(o));
  const req = JSON.parse(await Bun.stdin.text());
  try {
    const res = await fetch("http://127.0.0.1:" + process.env.PORT + req.endpoint, {
      method: "POST",
      headers: { "x-caelo-internal-token": req.token, "content-type": "application/json" },
      body: JSON.stringify(req.body),
    });
    out({ status: res.status, text: await res.text() });
  } catch (e) {
    out({ unreachable: String(e) });
  }
})();`;

/** The admin call on a self-hosted install (see the file comment). */
export async function callSelfHostedAdmin<T>(
  target: SelfHostedAdminTarget,
  call: AdminInternalCall,
  deps: AdminInternalDeps,
): Promise<AdminInternalAnswer<T>> {
  const host = deps.host ?? bunHostRunner;
  const restart = selfCommand("up");
  let secret: string | null;
  try {
    secret = readInternalSecret(target.caeloDir);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (secret === null) {
    return {
      ok: false,
      error: `${internalSecretPath(target.caeloDir)} does not exist. Run \`${restart}\` (it creates the secret and restarts the admin with it), then run this command again.`,
    };
  }

  const token = await mintInternalToken(secret, call.scope);
  const r = await host.run(
    compose(target.caeloDir, "exec", "-T", ADMIN_SERVICE, "bun", "-e", IN_CONTAINER_FETCH),
    { stdinText: JSON.stringify({ endpoint: call.endpoint, token, body: call.body }) },
  );
  if (r.exitCode !== 0) {
    return {
      ok: false,
      error: `run a request inside the ${ADMIN_SERVICE} container (docker compose exec, exit ${r.exitCode}): ${tail(r.stderr) || "no output"}. The admin must be running — start it with \`${restart}\`, then run this command again.`,
    };
  }
  let reply: { status?: unknown; text?: unknown; unreachable?: unknown };
  try {
    reply = JSON.parse(r.stdout) as typeof reply;
  } catch {
    return {
      ok: false,
      error: `the request inside the ${ADMIN_SERVICE} container printed no answer: ${tail(r.stdout) || tail(r.stderr) || "empty"}`,
    };
  }
  if (typeof reply.unreachable === "string") {
    return {
      ok: false,
      error: `the admin did not answer on its own port inside the container (${reply.unreachable}). Check \`docker compose -f ${target.caeloDir}/docker-compose.yml logs ${ADMIN_SERVICE}\`, then run this command again.`,
    };
  }
  if (typeof reply.status !== "number" || typeof reply.text !== "string") {
    return {
      ok: false,
      error: `the request inside the ${ADMIN_SERVICE} container answered an unexpected shape`,
    };
  }
  if (reply.status === 401) {
    return {
      ok: false,
      error: `the admin refused the internal token (HTTP 401: ${reply.text.slice(0, 200)}) — the running admin does not hold the secret in ${internalSecretPath(target.caeloDir)} (it was started from an older Compose file). Run \`${restart}\` to restart it with that secret, then run this command again.`,
    };
  }
  const answer = readAdminAnswer<T>(reply.status, reply.text, call, "cms-provision upgrade");
  return answer.ok
    ? { ok: true, value: { answer: answer.value, adminUrl: target.adminUrl } }
    : answer;
}

/** The last lines of a command's output, for an error message. */
function tail(text: string): string {
  return text.trim().split("\n").slice(-5).join("\n").slice(0, 500);
}
