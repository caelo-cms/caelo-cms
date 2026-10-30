// SPDX-License-Identifier: MPL-2.0

/**
 * The MCP tool definitions, input schemas and `instructions` of Caelo's two
 * MCP surfaces — ONE copy, used by the stdio shims in this package and by
 * the admin's remote Streamable HTTP endpoints (issue #806). A connecting
 * agent must see the same names, schemas and instructions whichever way it
 * reaches the site; editing them here changes both.
 *
 * Pure module (zod only): no transport, no filesystem, no network.
 */

import { z } from "zod";

// ─── instructions (#552) ────────────────────────────────────────────────

/**
 * MCP `instructions` for the chat-scope server (#552), injected into the
 * connecting agent's context so it uses caelo_chat as a conversation with
 * the site's own agent rather than a one-shot command.
 */
export const CHAT_MCP_INSTRUCTIONS = [
  "This server talks to a Caelo CMS site's own AI agent through caelo_chat; describe the outcome you want and the agent decides how to build it.",
  "Pass the chatSessionId from a reply to continue the same conversation; omit it only to start a new one.",
  "Changes land on that chat's preview branch; nothing reaches the live site until the operator publishes in the Caelo admin. Some actions wait for the operator's approval click there.",
  "When a reply says the turn is waiting for the operator's approval, call caelo_await_approval with the chatSessionId: it waits for the decision and returns your turn's continuation. Never re-send the request; you cannot approve anything yourself.",
].join("\n");

/**
 * MCP `instructions` for the admin server (#552). Clients such as Claude
 * Code put this into the agent's context on connect, so a freshly
 * connected agent knows the session protocol without the operator
 * pasting anything: without a session every write fails, without the
 * context it works without the site's rules and brand voice.
 */
export const ADMIN_MCP_INSTRUCTIONS = [
  "This server edits a Caelo CMS site. Before any other caelo tool:",
  "1. Call caelo_open_session once. It opens your own work session — a chat of yours in the Caelo admin, where the operator can follow, undo and stop your work (pass chatSessionId only to continue a session you opened earlier). Every write lands in the site's shared draft (or the session's own experiment branch); stage with stage_changes when the operator asks for it (otherwise offer it when a change is done), but nothing reaches the live site until the operator clicks Publish live in the Caelo admin.",
  "When several agents work in parallel over this connection (sub-agents), each one calls caelo_open_session itself and passes the workSessionId it got on every caelo call, so each works in its own session. Parallel agents never block each other; two calls that edit the same page or entity at once get a conflict that says to re-read and redo the edit.",
  "2. Call caelo_get_context once and follow it: it carries the site model, tool playbook, staging rules, site memory (brand voice, glossary) and the skills index.",
  "3. Load every skill the context marks ALWAYS APPLIES with load_skill before the work it covers (e.g. before writing any visitor-facing copy).",
  "Every tool in this list works over MCP, including approval-gated ones (marked APPROVAL-GATED — deploys, users/roles, languages/locales, plugin settings, bulk deletes …). Call them yourself: Caelo shows the operator an approval card in the Caelo admin (their Live Edit chat and the pending-approvals page), the call waits for Approve/Reject and returns the decision; if the wait times out, call caelo_await_approval with the proposalId. Tell the operator what you requested and that they approve the card in Caelo. Never ask the operator to paste a prompt into the Caelo admin chat or to do a step there that a tool here can do, and never re-propose a pending proposal.",
  "After every stage_changes, call get_quality_audit (it waits for the result) and fix every open problem it names, then Stage and re-read until it passes: the target is 100 in every category and zero findings, and a score that dropped since the page's previous audit points at a recent change — check those changes first. Do not report open scores or findings to the operator as a result — only what you proved cannot be fixed in the site.",
  "Tool errors name the next step to take; follow them instead of retrying unchanged.",
].join("\n");

// ─── caelo_upload_images (both surfaces) ────────────────────────────────

/** Per-image size cap (matches the admin's chat-attachment cap). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Uploaded media references accepted by caelo_chat; never accept object-store keys. */
export const uploadedImageSchema = z
  .object({
    assetId: z.string().uuid(),
    mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    alt: z.string().max(2048).optional(),
  })
  .strict();

const imageInput = z
  .object({
    filePath: z.string().min(1).max(4096).optional(),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .optional(),
    filename: z.string().min(1).max(512).optional(),
    alt: z.string().max(2048).optional(),
    reference: z.boolean().optional(),
  })
  .strict()
  .refine(
    (i) => (i.filePath === undefined) !== (i.base64 === undefined),
    "Supply exactly one of filePath or base64",
  );
/** A bounded batch; each file has its own success/error result for safe retries. */
export const uploadImagesInput = z.object({ images: z.array(imageInput).min(1).max(4) }).strict();

const UPLOAD_IMAGES_INPUT_SCHEMA = {
  type: "object" as const,
  required: ["images"],
  additionalProperties: false,
  properties: {
    images: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          filePath: {
            type: "string",
            description: "Path on the MCP server machine. Mutually exclusive with base64.",
          },
          base64: {
            type: "string",
            description: "Raw image bytes as base64. Mutually exclusive with filePath.",
          },
          filename: { type: "string", description: "Optional media filename." },
          alt: { type: "string", description: "Optional description of the image." },
          reference: {
            type: "boolean",
            description:
              "True for an image that only guides generation/editing; it is never placed on a page.",
          },
        },
        oneOf: [{ required: ["filePath"] }, { required: ["base64"] }],
      },
    },
  },
};

const UPLOAD_IMAGES_COMMON =
  "Files become shared CMS media assets. Set reference: true for images that only guide image generation or editing " +
  "(character sheets, style samples): they stay out of the page-image library and are never published. " +
  "Returns attachments for caelo_chat " +
  "or asset IDs for page tools. Uploading does not send a chat message or publish a page. " +
  "Results are per file: retry only failures.";

/** Exposed in both stdio catalogues, including chat-scoped connections. */
export const UPLOAD_IMAGES_TOOL = {
  name: "caelo_upload_images",
  description:
    "Upload 1–4 PNG, JPEG, WebP or GIF images (5 MiB each) to the Caelo media library. " +
    "Prefer filePath for files on the machine running this MCP server; otherwise supply raw base64 (no data URL). " +
    `${UPLOAD_IMAGES_COMMON} Requires the token owner's current content.write permission.`,
  inputSchema: UPLOAD_IMAGES_INPUT_SCHEMA,
};

/**
 * The same tool over a remote connection (#806): identical name and schema;
 * the description says what differs — the server runs in the Caelo admin,
 * so it cannot read files on the agent's machine and only base64 works.
 */
export const REMOTE_UPLOAD_IMAGES_TOOL = {
  name: UPLOAD_IMAGES_TOOL.name,
  description:
    "Upload 1–4 PNG, JPEG, WebP or GIF images (5 MiB each) to the Caelo media library. " +
    "Supply raw base64 (no data URL): this is a remote connection, so the server cannot read files on your machine and filePath is refused. " +
    `${UPLOAD_IMAGES_COMMON} Requires your current content.write permission.`,
  inputSchema: UPLOAD_IMAGES_INPUT_SCHEMA,
};

// ─── chat surface ───────────────────────────────────────────────────────

export const caeloChatInputSchema = z
  .object({
    attachments: z.array(uploadedImageSchema).max(4).optional(),
    message: z.string().min(1).max(50_000),
    chatSessionId: z.string().uuid().optional(),
    pageId: z.string().uuid().optional(),
  })
  .strict();
export type CaeloChatInput = z.infer<typeof caeloChatInputSchema>;

export const CAELO_CHAT_TOOL = {
  name: "caelo_chat",
  description:
    "Talk to your Caelo CMS install's AI agent. Same agent that powers the live-edit chat overlay — it can read pages, propose edits, queue Owner-approval proposals, summarise plugin data. Continues an existing chat session (when chatSessionId is supplied) or starts a fresh one. Returns the agent's reply text plus structured tool-call summaries.",
  inputSchema: {
    type: "object" as const,
    required: ["message"],
    properties: {
      attachments: {
        type: "array",
        maxItems: 4,
        description: "Attachments returned by caelo_upload_images.",
        items: z.toJSONSchema(uploadedImageSchema),
      },
      message: {
        type: "string",
        description: "What you want to say to the Caelo agent.",
      },
      chatSessionId: {
        type: "string",
        description:
          "Optional. Chat session UUID to continue. Omit to start a fresh page-unbound chat.",
      },
      pageId: {
        type: "string",
        description:
          "Optional. Bind a NEW chat to one page so the agent's page-context block is populated. Same shape as /edit?page=<id>.",
      },
    },
  },
};

export const chatAwaitApprovalInput = z.object({ chatSessionId: z.string().uuid() }).strict();

/** Issue #658 — keep waiting on the approval cards a caelo_chat turn paused on. */
export const CHAT_AWAIT_APPROVAL_TOOL = {
  name: "caelo_await_approval",
  description:
    "Wait for the operator's Approve/Reject on the approval cards your caelo_chat turn paused on, then " +
    "continue that turn and return its reply (the change applied, or the agent's reaction to a rejection). " +
    "Use it when a caelo_chat reply says it is still waiting for approval. You cannot approve anything " +
    "yourself — only the operator can, in the Caelo admin.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chatSessionId: {
        type: "string",
        description: "The chatSessionId from the caelo_chat reply that is waiting.",
      },
    },
    required: ["chatSessionId"],
  },
};

// ─── admin (Power-MCP) surface ──────────────────────────────────────────

export const openSessionInput = z
  .object({
    title: z.string().min(1).max(200).optional(),
    pageId: z.string().uuid().optional(),
    chatSessionId: z.string().uuid().optional(),
  })
  .strict();
export type OpenSessionInput = z.infer<typeof openSessionInput>;

export const OPEN_SESSION_TOOL = {
  name: "caelo_open_session",
  description:
    "Open your Caelo work session: a chat of your own in the operator's Caelo admin, in the site's shared " +
    "draft — your writes are invisible to the live site until they are staged and the operator clicks Publish live. " +
    "Call this ONCE before any other caelo tool; every call opens a NEW session (each agent gets its own, so the " +
    "operator can undo or stop each agent's work on its own). Pass chatSessionId only to continue a session you " +
    "opened earlier. When several agents share this connection, each passes the returned chatSessionId as " +
    "workSessionId on every caelo call. Optional pageId binds the new session to that page.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Session title shown in the Caelo admin chat list." },
      pageId: { type: "string", description: "Optional page UUID to bind the new session to." },
      chatSessionId: {
        type: "string",
        description: "Continue this session (one you opened earlier) instead of opening a new one.",
      },
    },
  },
};

/**
 * Issue #1253 — the per-call work session. Every catalogue tool gains this
 * optional argument on the Power-MCP surface (and loses it again before the
 * call reaches Caelo): agents sharing one connection each name their own
 * session, because a connection has one current session at most.
 */
export const WORK_SESSION_ARG = "workSessionId";

/** The JSON-Schema property {@link WORK_SESSION_ARG} adds to each tool. */
export const WORK_SESSION_PROPERTY = {
  type: "string",
  description:
    "Your work session (the chatSessionId from caelo_open_session). Required when several agents share this connection; otherwise the session you opened last.",
} as const;

export const adminAwaitApprovalInput = z.object({ proposalId: z.string().uuid() }).strict();

/** Issue #658 — keep waiting for a decision after a gated call's wait timed out. */
export const ADMIN_AWAIT_APPROVAL_TOOL = {
  name: "caelo_await_approval",
  description:
    "Wait for the operator's Approve/Reject on a proposal you queued with an approval-gated tool, and return " +
    "the decision (applied / rejected with reason / …). Use it when a gated tool's result says it is still " +
    "waiting. You cannot approve anything yourself — only the operator can, in the Caelo admin.",
  inputSchema: {
    type: "object" as const,
    properties: {
      proposalId: {
        type: "string",
        description: "The id from the gated tool's 'Queued proposal <id>' result.",
      },
    },
    required: ["proposalId"],
  },
};

export const GET_CONTEXT_TOOL = {
  name: "caelo_get_context",
  description:
    "Fetch the Caelo install's composed site context: how pages/modules/content instances fit together, " +
    "the tool playbook, staging rules, site memory (brand voice, glossary) and the active skills index. " +
    "Load this once before working; load individual skills on demand via the load_skill tool.",
  inputSchema: { type: "object" as const, properties: {} },
};

/**
 * The chat server's whole tool list (stdio flavour). Static, so it also
 * serves the credential-less listing MCP directories inspect (#841); the
 * remote surface swaps in its own upload tool.
 */
export const CHAT_TOOLS = [UPLOAD_IMAGES_TOOL, CHAT_AWAIT_APPROVAL_TOOL, CAELO_CHAT_TOOL] as const;

/**
 * The tools Power-MCP adds in front of the admin's catalogue (stdio
 * flavour) — also the head of the credential-less listing (#841).
 */
export const ADMIN_LOCAL_TOOLS = [
  UPLOAD_IMAGES_TOOL,
  OPEN_SESSION_TOOL,
  GET_CONTEXT_TOOL,
  ADMIN_AWAIT_APPROVAL_TOOL,
] as const;
