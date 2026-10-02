// SPDX-License-Identifier: MPL-2.0
import { fontCatalog } from "@caelo-cms/font-service";
import { json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ url, locals }) => {
  requirePermission(locals, "roles.manage");
  return json(await fontCatalog((url.searchParams.get("q") ?? "").slice(0, 200)));
};
