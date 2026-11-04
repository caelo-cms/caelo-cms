// SPDX-License-Identifier: MPL-2.0
import { json } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { uploadMedia } from "#lib/server/media-upload.js";
export const POST = async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    return json(await uploadMedia(request, locals.ctx));
};
