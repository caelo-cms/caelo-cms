// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 (issue #106) — guards for the generation-time blockName enum.
 * blockNotFoundError must name the valid block set (recover-don't-punt);
 * blocks when one is in context, and fall back to the static free-string
 * schema otherwise (an empty enum would match nothing and wedge the model;
 * the op-layer Validator is the defense-in-depth).
 */

import { describe, expect, it } from "bun:test";
import { blockNotFoundError } from "../_block-name-enum.js";

const BASE = {
  type: "object",
  additionalProperties: false,
  required: ["blockName"],
  properties: {
    blockName: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

const ACTOR = { actorId: "00000000-0000-0000-0000-000000000001", actorKind: "ai" as const };

function stateWith(activePage: ToolDescribeStateActivePage | null) {
  return buildToolDescribeState({
    actor: ACTOR,
    layoutsValue: null,
    templatesValue: null,
    siteDefaultsValue: null,
    activePage,
  });
}
