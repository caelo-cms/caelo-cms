// SPDX-License-Identifier: MPL-2.0

/**
 * The redirect plan as Azure Front Door (Standard) rules-engine rules
 * (provider `azure`, #587).
 *
 * Front Door's rules engine answers a `UrlRedirect` action at the edge,
 * before the Blob static-website origin, so no compute sits on the request
 * path. Each planned redirect is one rule: a `UrlPath` condition (Front Door
 * matches the path WITHOUT its leading slash) and a `UrlRedirect` action.
 *
 * Limit (Front Door Standard and Premium, fixed): 100 rules per rule set and
 * per route. A plan with more redirects is refused with
 * {@link FrontDoorRuleLimitError} before anything is written — never a
 * partial set. Front Door cannot answer a bare 410, so `gone` entries get
 * the origin's 404. Writing the rules at deploy time is tracked in #750.
 */

import type { PlannedRedirect, RedirectPlan, RedirectStatusCode } from "./redirect-plan.js";

/** Rules per rule set / per route on Front Door Standard and Premium. */
export const FRONT_DOOR_MAX_RULES = 100;

type FrontDoorRedirectType = "Moved" | "Found" | "TemporaryRedirect" | "PermanentRedirect";

const REDIRECT_TYPE: Record<RedirectStatusCode, FrontDoorRedirectType> = {
  301: "Moved",
  302: "Found",
  307: "TemporaryRedirect",
  308: "PermanentRedirect",
};

/** One rule, in the shape of `azure-native` `cdn.Rule` arguments (ARM). */
export interface FrontDoorRedirectRule {
  readonly ruleName: string;
  readonly order: number;
  readonly matchProcessingBehavior: "Stop";
  readonly conditions: readonly [
    {
      readonly name: "UrlPath";
      readonly parameters: {
        readonly typeName: "DeliveryRuleUrlPathMatchConditionParameters";
        readonly operator: "Equal";
        readonly negateCondition: false;
        readonly matchValues: readonly string[];
        readonly transforms: readonly [];
      };
    },
  ];
  readonly actions: readonly [
    {
      readonly name: "UrlRedirect";
      readonly parameters: {
        readonly typeName: "DeliveryRuleUrlRedirectActionParameters";
        readonly redirectType: FrontDoorRedirectType;
        readonly destinationProtocol: "MatchRequest";
        readonly customPath: string;
        readonly customQueryString?: string;
        readonly customFragment?: string;
      };
    },
  ];
}

/** The plan has more redirects than a Front Door route can hold. */
export class FrontDoorRuleLimitError extends Error {
  constructor(readonly redirectCount: number) {
    super(
      `Azure Front Door serves at most ${FRONT_DOOR_MAX_RULES} redirect rules per site (a fixed rules-engine limit); this site has ${redirectCount}. Nothing was published and the live redirects are unchanged. Delete redirects nobody links to any more (find_redirects lists them, bulk_delete_redirects removes them), then publish again. Larger sets on Azure are tracked in https://github.com/caelo-cms/caelo-cms/issues/750.`,
    );
    this.name = "FrontDoorRuleLimitError";
  }
}

/**
 * One rule per planned redirect, ordered as the plan.
 *
 * @throws {FrontDoorRuleLimitError} over {@link FRONT_DOOR_MAX_RULES}.
 */
export function frontDoorRedirectRules(plan: RedirectPlan): FrontDoorRedirectRule[] {
  if (plan.redirects.length > FRONT_DOOR_MAX_RULES) {
    throw new FrontDoorRuleLimitError(plan.redirects.length);
  }
  return plan.redirects.map((r, i) => toRule(r, i + 1));
}

function toRule(r: PlannedRedirect, order: number): FrontDoorRedirectRule {
  const { path, query, fragment } = splitLocation(r.location);
  return {
    // Rule names: letters and digits only, starting with a letter.
    ruleName: `caeloRedirect${order}`,
    order,
    matchProcessingBehavior: "Stop",
    conditions: [
      {
        name: "UrlPath",
        parameters: {
          typeName: "DeliveryRuleUrlPathMatchConditionParameters",
          operator: "Equal",
          negateCondition: false,
          matchValues: r.matchPaths.map((p) => p.slice(1)),
          transforms: [],
        },
      },
    ],
    actions: [
      {
        name: "UrlRedirect",
        parameters: {
          typeName: "DeliveryRuleUrlRedirectActionParameters",
          redirectType: REDIRECT_TYPE[r.statusCode],
          destinationProtocol: "MatchRequest",
          customPath: path,
          // Without customQueryString Front Door keeps the visitor's query,
          // which is the plan's preserveQuery semantics.
          ...(query !== null ? { customQueryString: query } : {}),
          ...(fragment !== null ? { customFragment: fragment } : {}),
        },
      },
    ],
  };
}

function splitLocation(location: string): {
  path: string;
  query: string | null;
  fragment: string | null;
} {
  const hashAt = location.indexOf("#");
  const beforeHash = hashAt === -1 ? location : location.slice(0, hashAt);
  const fragment = hashAt === -1 ? null : location.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  return {
    path: queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt),
    // A target with only a fragment still replaces the visitor's query, as
    // on every other provider (preserveQuery is false for it).
    query: queryAt === -1 ? (fragment === null ? null : "") : beforeHash.slice(queryAt + 1),
    fragment,
  };
}
