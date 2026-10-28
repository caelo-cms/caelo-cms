// SPDX-License-Identifier: MPL-2.0

/**
 * Entry point of the Caelo bug intake (epic #901). Wires the GitHub App
 * client (issues only), the Firestore store, the semantic matcher and the
 * HTTP handler, then serves. Configuration: see config.ts and
 * docs/internal/bug-intake.md.
 */

import { loadIntakeEnv } from "./config.js";
import { FirestoreStore } from "./firestore-store.js";
import { GitHubClient } from "./github.js";
import { LlmClusterMatcher } from "./matcher.js";
import { RateLimiter } from "./rate-limit.js";
import { createIntakeHandler } from "./server.js";
import { IntakeService, type IssueTracker } from "./service.js";

const env = loadIntakeEnv(process.env);

const gh = new GitHubClient({
  appId: env.GITHUB_APP_ID,
  privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
  installationId: env.GITHUB_APP_INSTALLATION_ID,
});
const repo = env.BUG_INTAKE_PUBLIC_REPO;
const tracker: IssueTracker = {
  createIssue: (issue) => gh.createIssue(repo, issue),
  updateIssue: (n, patch) => gh.updateIssue(repo, n, patch),
  getIssue: (n) => gh.getIssue(repo, n),
  addComment: (n, body) => gh.addComment(repo, n, body),
  recentCommentBodies: (n) => gh.recentCommentBodies(repo, n),
  releases: () => gh.releases(repo),
};
const store = FirestoreStore.connect(
  env.BUG_INTAKE_FIRESTORE_PROJECT,
  env.BUG_INTAKE_FIRESTORE_DATABASE,
);
const service = new IntakeService({
  store,
  tracker,
  matcher: LlmClusterMatcher.anthropic(env.ANTHROPIC_API_KEY, env.BUG_INTAKE_MATCH_MODEL),
  issueThresholdInstalls: env.BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS,
  maxNewIssuesPerDay: env.BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY,
  maxNewSuggestionsPerDay: env.BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY,
  issuesPaused: env.BUG_INTAKE_ISSUES_PAUSED,
});

const server = Bun.serve({
  port: env.PORT,
  fetch: createIntakeHandler({
    service,
    store,
    globalRegisterLimiter: new RateLimiter(env.BUG_INTAKE_MAX_REGISTRATIONS_PER_HOUR, 60 * 60_000),
  }),
});
console.log(
  `[bug-intake] listening on :${server.port} — issues in ${repo}` +
    (env.BUG_INTAKE_ISSUES_PAUSED ? " (PAUSED: no GitHub writes)" : "") +
    `, data in Firestore ${env.BUG_INTAKE_FIRESTORE_PROJECT}/${env.BUG_INTAKE_FIRESTORE_DATABASE}` +
    `, threshold ${env.BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS} install(s)` +
    `, at most ${env.BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY} new defect issue(s)` +
    ` and ${env.BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY} new suggestion issue(s) per UTC day` +
    `, ${env.BUG_INTAKE_MAX_REGISTRATIONS_PER_HOUR} registration(s) per hour`,
);
