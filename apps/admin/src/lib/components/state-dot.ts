// SPDX-License-Identifier: MPL-2.0

/**
 * The three publish states a page or change moves through (#779):
 * Draft (edited, not in any build) → Preview (in the staged build) →
 * Live (in the production build). Rendered by `StateDot.svelte`.
 */
export type PublishState = "draft" | "preview" | "live";
