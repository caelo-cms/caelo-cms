// SPDX-License-Identifier: MPL-2.0

const _BASE = {
  type: "object",
  additionalProperties: false,
  required: ["blockName"],
  properties: {
    blockName: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

const ACTOR = { actorId: "00000000-0000-0000-0000-000000000001", actorKind: "ai" as const };

function _stateWith(activePage: ToolDescribeStateActivePage | null) {
  return buildToolDescribeState({
    actor: ACTOR,
    layoutsValue: null,
    templatesValue: null,
    siteDefaultsValue: null,
    activePage,
  });
}
