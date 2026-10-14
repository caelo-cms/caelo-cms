// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the wire and storage shapes of the findings checks' part of
 * an audit: what the worker hands `quality_audits.record_result`, what the
 * run stores in `quality_audit_runs.checks`, and the problem rows. Zod
 * schemas, so every hop validates (CLAUDE.md §4).
 *
 * Kept free of DB code so the worker, the ops and the read surfaces share
 * one definition.
 */

import { z } from "zod";
import { checkIdSchema, findingFixSchema, findingSchema } from "./findings.js";

export const checkSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("core") }).strict(),
  z.object({ kind: z.literal("plugin"), slug: z.string().min(1).max(100) }).strict(),
]);

/** A findings check that ran in this audit. */
export const ranCheckSchema = z
  .object({
    id: checkIdSchema,
    title: z.string().min(1).max(200),
    scope: z.enum(["page", "site"]),
    source: checkSourceSchema,
  })
  .strict();

/**
 * Something that kept a check from measuring: a page staging did not
 * serve (`checkId` null), or a check that threw / hung / returned
 * malformed findings. Either fails the audit loudly.
 */
export const checkRunErrorSchema = z
  .object({
    checkId: z.string().nullable(),
    pageId: z.string().uuid().optional(),
    url: z.string().optional(),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

/** The findings checks' outcome, as the worker reports it. */
export const checksOutcomeSchema = z
  .object({
    ran: z.array(ranCheckSchema),
    /** Every page whose HTML the checks read. */
    pages: z.array(z.object({ pageId: z.string().uuid(), url: z.string() }).strict()),
    findings: z.array(findingSchema),
    errors: z.array(checkRunErrorSchema),
  })
  .strict();

export type ChecksOutcome = z.infer<typeof checksOutcomeSchema>;
export type CheckRunErrorRecord = z.infer<typeof checkRunErrorSchema>;

/** `CheckRuleProblem` (evaluate.ts) as stored and read. */
export const checkRuleProblemSchema = z
  .object({
    kind: z.literal("check_rule"),
    checkId: z.string(),
    ruleId: z.string(),
    count: z.number().int().min(1),
    allowed: z.number().int().min(0),
    findings: z.array(z.object({ message: z.string(), fix: findingFixSchema.optional() }).strict()),
  })
  .strict();

const severityCountsSchema = z
  .object({
    error: z.number().int().min(0),
    warning: z.number().int().min(0),
    info: z.number().int().min(0),
  })
  .strict();

/** `quality_audit_runs.checks`: the run-level summary of the checks. */
export const runChecksSummarySchema = z
  .object({
    ran: z.array(ranCheckSchema),
    pagesChecked: z.number().int().min(0),
    /** Findings per severity across the whole run. */
    findingCounts: severityCountsSchema,
    /** Page-less findings (all severities). */
    siteFindings: z.array(findingSchema),
    /** Site-wide error rules over their accepted count. */
    siteProblems: z.array(checkRuleProblemSchema),
    errors: z.array(checkRunErrorSchema),
  })
  .strict();

export type RunChecksSummary = z.infer<typeof runChecksSummarySchema>;
