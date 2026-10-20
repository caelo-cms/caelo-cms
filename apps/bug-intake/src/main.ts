// SPDX-License-Identifier: MPL-2.0

/**
 * Entry point of the Caelo bug intake (epic #901). Wires the GitHub App
 * client, the data-repo store, the semantic matcher and the HTTP handler,
 * then serves. Configuration: see config.ts and docs/internal/bug-intake.md.
 */

import { loadIntakeEnv } from "./config.js";
import { GitHubClient } from "./github.js";
import { LlmClusterMatcher } from "./matcher.js";
import { createIntakeHandler } from "./server.js";
import { IntakeService, type IssueTracker } from "./service.js";
import { GitHubRepoStore } from "./store.js";

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
const store = new GitHubRepoStore(gh, env.BUG_INTAKE_DATA_REPO);
const service = new IntakeService({
  store,
  tracker,
  matcher: LlmClusterMatcher.anthropic(env.ANTHROPIC_API_KEY, env.BUG_INTAKE_MATCH_MODEL),
  issueThresholdInstalls: env.BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS,
});

const server = Bun.serve({ port: env.PORT, fetch: createIntakeHandler({ service, store }) });
console.log(
  `[bug-intake] listening on :${server.port} — issues in ${repo}, data in ${env.BUG_INTAKE_DATA_REPO}, threshold ${env.BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS} install(s)`,
);
