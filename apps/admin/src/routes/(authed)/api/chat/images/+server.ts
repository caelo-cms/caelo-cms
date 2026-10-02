// SPDX-License-Identifier: MPL-2.0
import { verifyCsrfToken } from "@caelo-cms/admin-core";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { uploadMedia } from "$lib/server/media-upload.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requirePermission(locals, "content.write");
  if (!(await verifyCsrfToken(user.csrfSecret, request.headers.get("x-csrf-token") ?? ""))) {
    throw error(403, "Invalid CSRF token");
  }
  return json(await uploadMedia(request, locals.ctx, true));
};
