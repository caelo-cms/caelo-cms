// SPDX-License-Identifier: MPL-2.0
import { requirePermission } from "$lib/server/guards.js";
/**
 * Every page in the content tree requires `content.read`. Mutation actions on
 * individual routes call `requirePermission(locals, 'content.write')`
 * separately so a Reviewer (read-only) can browse but not modify.
 */
export const load = async ({ locals }) => {
    requirePermission(locals, "content.read");
    return {};
};
