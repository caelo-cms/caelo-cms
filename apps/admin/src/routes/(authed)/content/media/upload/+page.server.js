// SPDX-License-Identifier: MPL-2.0
import { requirePermission } from "$lib/server/guards.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "content.write");
    return {};
};
