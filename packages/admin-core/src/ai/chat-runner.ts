// SPDX-License-Identifier: MPL-2.0

/**
 * Public façade for the chat-runner. The implementation was split into the
 * `chat-runner/` directory (issue #15) for human maintainability; this file
 * stays as a thin re-export so every existing import path
 * (`@caelo-cms/admin-core`, `../chat-runner.js`, `../../ai/chat-runner.js`)
 * keeps resolving unchanged. See `chat-runner/index.ts` for the orchestrator.
 */

export * from "./chat-runner/index.js";
