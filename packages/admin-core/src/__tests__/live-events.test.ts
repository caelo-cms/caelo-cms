// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1215 — the live-refresh hub that replaces the editor's timer
 * polling: which committed operations announce which topic, and how a
 * waiter (`/api/live-events`) answers. Pure, no database.
 */

import { describe, expect, it } from "bun:test";
import { OperationRegistry } from "@caelo-cms/query-api";
import { liveTopicsOfOperation, parseLiveTopics } from "@caelo-cms/shared";
import { publishLiveTopics, subscribeLiveTopics, waitForLiveTopics } from "../live-events.js";
import { registerAdminOps } from "../register.js";

const registry = new OperationRegistry();
registerAdminOps(registry);
const OP_NAMES = registry.names();

describe("liveTopicsOfOperation over the real op catalogue", () => {
  it("classifies only write ops: a read announcing a change would make every refresh announce another", () => {
    const READ =
      /\.(list|get|search|find|count|read|lookup|check|resolve)(_|$)|\.(?!update_|set_)\w*_(status|readiness)$/;
    const readsWithTopics = OP_NAMES.filter(
      (n) => READ.test(n) && liveTopicsOfOperation(n).length > 0,
    );
    expect(readsWithTopics).toEqual([]);
  });

  it("every op it names exists (a rename would silently stop the refresh)", () => {
    const named = [
      "chat.register_agent_run",
      "chat.finish_agent_run",
      "chat.cancel_agents",
      "chat.allow_external_agent",
      "chat.touch_external_agent",
      "chat.record_turn_approvals",
      "chat.decide_turn_approval",
      "chat.supersede_turn_approvals",
      "chat.claim_turn_approvals",
      "skills.review_proposal",
      "gateway.execute_rate_limit_proposal",
      "gateway.reject_rate_limit_proposal",
      "plugins.approve_installation",
      "credentials.issue",
      "chat.stage",
      "chat.unstage",
      "chat.finalize_stage",
      "chat.finalize_draft_stage",
      "chat.publish",
      "quality_audits.enqueue",
      "quality_audits.record_result",
      "quality_audits.retry",
      "quality_audits.claim_chat_notification",
      "quality_audits.ack_chat_notification",
      "quality_audits.release_chat_notification",
      "quality_audits.publish_anyway",
      "imports.create_run",
      "imports.update_run_status",
      "imports.write_extracted_pages",
      "deploy.trigger",
      "deploy.start_trigger",
      "deploy.fail_run",
      "deploy.finish_trigger",
      "deploy.update_progress",
      "deploy.promote",
      "deploy.start_promote",
      "deploy.finish_promote",
      "deploy.begin_execute_proposal",
      "deploy.end_execute_proposal",
      "quality_audits.begin_execute_proposal",
      "quality_audits.end_execute_proposal",
      "deploy.rollback",
      "deploy.build_plugin_data",
      "deploy.begin_plugin_data_run",
      "deploy.finish_plugin_data_run",
    ];
    const missing = named.filter((n) => !OP_NAMES.includes(n));
    expect(missing).toEqual([]);
    for (const n of named) expect(liveTopicsOfOperation(n).length).toBeGreaterThan(0);
  });

  it("every proposal op moves the pending strip; an applied one may leave a credential", () => {
    const proposals = OP_NAMES.filter((n) => /\.(propose(_|$)|reject_proposal$)/.test(n));
    expect(proposals.length).toBeGreaterThan(40);
    for (const n of proposals) expect(liveTopicsOfOperation(n)).toContain("pending");
    const executors = OP_NAMES.filter((n) => n.endsWith(".execute_proposal"));
    expect(executors.length).toBeGreaterThan(15);
    for (const n of executors) {
      expect(liveTopicsOfOperation(n)).toEqual(expect.arrayContaining(["pending", "credentials"]));
    }
    expect(liveTopicsOfOperation("quality_audits.execute_proposal")).toContain("quality");
    expect(liveTopicsOfOperation("deploy.execute_proposal")).toContain("deploys");
  });

  it("clock-driven writes announce nothing (a hint on a clock is polling again)", () => {
    for (const n of [
      "chat.heartbeat_agent_run",
      "chat.renew_turn_lease",
      "quality_audits.claim_next",
      "deploy.renew_run_lease",
      "deploy.acquire_live_release",
    ]) {
      expect(OP_NAMES).toContain(n);
      expect(liveTopicsOfOperation(n)).toEqual([]);
    }
  });
});

describe("parseLiveTopics", () => {
  it("parses a comma list and refuses unknown names instead of waiting forever", () => {
    expect(parseLiveTopics("agents, pending,agents")).toEqual({
      ok: true,
      topics: ["agents", "pending"],
    });
    expect(parseLiveTopics("agents,bogus")).toEqual({ ok: false, unknown: ["bogus"] });
    expect(parseLiveTopics(null)).toEqual({ ok: true, topics: [] });
  });
});

describe("waitForLiveTopics", () => {
  it("answers the wanted topics that arrive, ignoring others", async () => {
    const waiting = waitForLiveTopics(["pending", "quality"], { timeoutMs: 2_000, settleMs: 20 });
    publishLiveTopics(["agents"]);
    publishLiveTopics(["quality"]);
    publishLiveTopics(["pending", "crawl"]);
    expect(await waiting).toEqual(["pending", "quality"]);
  });

  it("answers [] after the deadline; a topic after it changes nothing", async () => {
    const started = Date.now();
    const waiting = waitForLiveTopics(["agents"], { timeoutMs: 30 });
    expect(await waiting).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    publishLiveTopics(["agents"]);
    expect(await waiting).toEqual([]);
  });

  it("an unsubscribed listener hears nothing", () => {
    const heard: string[] = [];
    const stop = subscribeLiveTopics((t) => heard.push(...t));
    publishLiveTopics(["crawl"]);
    stop();
    publishLiveTopics(["crawl"]);
    expect(heard).toEqual(["crawl"]);
  });

  it("answers [] at once when the request goes away", async () => {
    const ac = new AbortController();
    const waiting = waitForLiveTopics(["agents"], { timeoutMs: 5_000, signal: ac.signal });
    ac.abort();
    expect(await waiting).toEqual([]);
    const pre = new AbortController();
    pre.abort();
    expect(await waitForLiveTopics(["agents"], { timeoutMs: 5_000, signal: pre.signal })).toEqual(
      [],
    );
  });

  it("a listener that throws does not keep the others from hearing", async () => {
    const stop = subscribeLiveTopics(() => {
      throw new Error("listener bug");
    });
    const waiting = waitForLiveTopics(["deploys"], { timeoutMs: 2_000 });
    publishLiveTopics(["deploys"]);
    expect(await waiting).toEqual(["deploys"]);
    stop();
  });
});
