// SPDX-License-Identifier: MPL-2.0

/**
 * `@caelo-cms/mcp-server/surfaces` — the transport-independent MCP servers
 * and their tool definitions, for the admin's remote Streamable HTTP
 * endpoints (issue #806). The stdio shims in this package build on the same
 * modules, so a remote agent and a stdio agent see identical tools,
 * instructions and results. Nothing here touches the filesystem or reads
 * process configuration.
 */

export {
  type ApprovalOutcome,
  DEFAULT_APPROVAL_WAIT_MS,
} from "../approval-wait.js";
export type { ChatApprovalState, SendChatResult } from "../chat-approval.js";
export {
  type CaeloChatInput,
  CHAT_MCP_INSTRUCTIONS,
  type OpenSessionInput,
  POWER_MCP_INSTRUCTIONS,
  REMOTE_UPLOAD_IMAGES_TOOL,
  UPLOAD_IMAGES_TOOL,
} from "../tool-definitions.js";
export {
  type ChatSurfaceBackend,
  type ChatSurfaceOptions,
  createChatMcpServer,
} from "./chat-surface.js";
export {
  type AdminSurfaceOptions,
  createPowerMcpServer,
  type ExecuteToolResponse,
  type GetContextResponse,
  NoWorkSessionError,
  type OpenSessionResponse,
  type PowerSurfaceBackend,
  type RemoteTool,
} from "./power-surface.js";
export { rpcToolCallId } from "./rpc-tool-call-id.js";
export { type StoreImageMeta, type UploadImagesResult, uploadImagesWith } from "./upload.js";
