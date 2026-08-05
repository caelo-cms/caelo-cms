// SPDX-License-Identifier: MPL-2.0
/**
 * Issue #376 — Power-MCP: work-session endpoint. Opens (or resumes) the
 * chat session whose preview branch every subsequent /api/mcp/tool call
 * writes to. Auth lives inside the op; this is just the HTTP shell.
 */
import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
const SYSTEM_CTX = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system",
    requestId: "mcp-http-session",
};
export const POST = async ({ request }) => {
    const token = request.headers.get("x-caelo-mcp-token");
    if (!token)
        throw error(401, "missing x-caelo-mcp-token header");
    let body;
    try {
        body = (await request.json());
    }
    catch {
        throw error(400, "body is not valid JSON");
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.open_session", {
        plaintextToken: token,
        ...(typeof body.chatSessionId === "string" ? { chatSessionId: body.chatSessionId } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.pageId === "string" ? { pageId: body.pageId } : {}),
    });
    if (!r.ok) {
        const msg = "message" in r.error ? r.error.message : r.error.kind;
        if (typeof msg === "string" && msg.startsWith("auth_error:")) {
            throw error(401, msg);
        }
        // Op-input validation failures are the caller's mistake, not a server
        // fault — surface them as 400 with the issues (review finding, PR #379).
        if (r.error.kind === "ValidationFailed") {
            throw error(400, `invalid request: ${JSON.stringify("issues" in r.error ? r.error.issues : [])}`);
        }
        throw error(500, typeof msg === "string" ? msg : "mcp.open_session failed");
    }
    return json(r.value);
};
