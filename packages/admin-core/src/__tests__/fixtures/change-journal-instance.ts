// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — "admin instance 1" for change-journal.integration.test.ts:
 * a separate process with its own pools and its own live fan-out. It
 * commits one content write (journal → `draft` on every instance) and one
 * operation with a live topic (`chat.register_agent_run` → `agents`), then
 * exits. The test process is instance 2 and must hear both.
 *
 *   bun change-journal-instance.ts <chatSessionId>
 */

import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { startLiveFanOut } from "../../live-events.js";
import { registerAdminOps } from "../../register.js";

const chatSessionId = process.argv[2];
const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!chatSessionId || !ADMIN_URL || !PUBLIC_URL) {
  throw new Error("usage: change-journal-instance.ts <chatSessionId> (with the DB URLs set)");
}

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1267-instance-1",
};

const adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
const registry = new OperationRegistry();
registerAdminOps(registry);
const fanOut = await startLiveFanOut({ adapter, instanceId: "instance-1" });
try {
  const created = await execute(registry, adapter, SYS, "modules.create", {
    slug: `t1267-instance-1-${crypto.randomUUID().slice(0, 8)}`,
    displayName: "From instance 1",
    html: "<p>instance 1</p>",
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const run = await execute(registry, adapter, SYS, "chat.register_agent_run", {
    chatSessionId,
    kind: "turn",
    source: "live_edit",
    label: "instance 1",
    operatorInitiated: false,
  });
  if (!run.ok) throw new Error(JSON.stringify(run.error));
} finally {
  await fanOut.stop();
  await adapter.close();
}
