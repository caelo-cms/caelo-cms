// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — what the capture job's preview hand-over is built from: the
 * page's preview document and its media lookups, read through the Query API
 * as the caller (the same `pages.render_preview` the editor's preview and
 * `inspect_page_render` use, the same `media.get` the media routes use).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import { type ExecutionContext, mediaFormatContentType } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import type { ServedPreviewSource } from "./preview-capture.js";

/** The hand-over source of one page on one branch, read as `ctx`. */
export function previewSourceFromQueryApi(args: {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly ctx: ExecutionContext;
  readonly pageId: string;
  readonly chatBranchId?: string;
}): ServedPreviewSource {
  const { registry, adapter, ctx, pageId, chatBranchId } = args;
  return {
    async renderDocument() {
      const r = await execute(registry, adapter, ctx, "pages.render_preview", {
        pageId,
        ...(chatBranchId ? { chatBranchId } : {}),
      });
      if (!r.ok) {
        return {
          ok: false,
          message: `the preview of page ${pageId}${chatBranchId ? ` on branch ${chatBranchId}` : ""} could not be rendered: ${describeError(r.error)}`,
        };
      }
      return { ok: true, html: (r.value as { html: string }).html };
    },
    async resolveMedia(ref, variant) {
      const r = await execute(registry, adapter, ctx, "media.get", { assetId: ref });
      if (!r.ok) return null;
      const asset = (
        r.value as {
          asset: { variants: { variant: string; storageKey: string; format: string }[] } | null;
        }
      ).asset;
      const v = asset?.variants.find((x) => x.variant === variant);
      return v ? { storageKey: v.storageKey, contentType: mediaFormatContentType(v.format) } : null;
    },
  };
}
