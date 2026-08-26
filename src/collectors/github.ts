import type { DaybreakConfig } from "../config.ts";
import type { RunContext } from "../types.ts";
import { ghApi, ghGraphql, ghList, ghPaginated } from "../integrations/gh.ts";
import { StateDatabase } from "../state/database.ts";
import { mapConcurrent, metric } from "../utils.ts";

interface GitHubRepo {
  full_name: string;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  archived: boolean;
  private?: boolean;
}
interface GitHubRelease {
  assets: Array<{ download_count: number }>;
}
interface GitHubNotification {
  id: string;
  reason: string;
  unread: boolean;
  updated_at: string;
  repository: { full_name: string };
  subject: { title: string; type: string; url: string | null; latest_comment_url: string | null };
}
interface SearchNode {
  __typename: "Issue" | "PullRequest";
  id: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
  repository: { nameWithOwner: string };
  statusCheckRollup?: { state: string } | null;
}
interface SearchResult {
  data: {
    viewer: { login: string };
    assignedIssues: { nodes: SearchNode[] };
    assignedPullRequests: { nodes: SearchNode[] };
    reviewRequests: { nodes: SearchNode[] };
    authoredIssues: { nodes: SearchNode[] };
    authoredPullRequests: { nodes: SearchNode[] };
  };
}

export async function collectGithub(
  config: NonNullable<DaybreakConfig["github"]>,
  statePath: string,
  run: RunContext,
  writeState: boolean,
) {
  const collectedAt = new Date().toISOString();
  const state = new StateDatabase(statePath);
  try {
    const repositories = await mapConcurrent(config.repositories, 4, async (repository) => {
      const [repo, releases] = await Promise.all([
        ghApi<GitHubRepo>(`repos/${repository}`),
        ghPaginated<GitHubRelease>(`repos/${repository}/releases?per_page=100`),
      ]);
      const releaseDownloads = releases.reduce(
        (total, release) =>
          total + release.assets.reduce((sum, asset) => sum + asset.download_count, 0),
        0,
      );
      const previous = state.previousSnapshot(repository, run.windows.github.start);
      if (writeState) {
        state.saveSnapshot({
          repository,
          stars: repo.stargazers_count,
          releaseDownloads,
          recordedAt: collectedAt,
        });
      }
      return {
        name: repo.full_name,
        url: repo.html_url,
        archived: repo.archived,
        stars: metric(repo.stargazers_count, previous?.stars, previous?.recordedAt),
        forks: repo.forks_count,
        openIssues: repo.open_issues_count,
        releaseDownloads: metric(
          releaseDownloads,
          previous?.releaseDownloads,
          previous?.recordedAt,
        ),
      };
    });

    const work = await fetchWork(config.repositories, config.maxItems);
    const notifications = await ghList<GitHubNotification>(
      `notifications?all=false&participating=false&per_page=${config.maxItems}`,
    );

    const warnings: string[] = [];
    if (repositories.some((repo) => repo.stars.previous === null)) {
      warnings.push("Repository deltas are unavailable until a lookback snapshot exists");
    }
    return {
      data: {
        user: { login: work.login },
        snapshotWritten: writeState,
        repositories,
        todos: {
          assignedIssues: work.assignedIssues,
          assignedPullRequests: work.assignedPullRequests,
          reviewRequests: work.reviewRequests,
          authoredIssues: work.authoredIssues,
          authoredPullRequests: work.authoredPullRequests,
          notifications,
        },
      },
      warnings,
    };
  } finally {
    state.close();
  }
}

async function fetchWork(repositories: string[], maxItems: number) {
  const viewer = await ghApi<{ login: string }>("user");
  if (repositories.length === 0) {
    return {
      login: viewer.login,
      assignedIssues: [],
      assignedPullRequests: [],
      reviewRequests: [],
      authoredIssues: [],
      authoredPullRequests: [],
    };
  }
  const query =
    `query($assignedIssues: String!, $assignedPrs: String!, $reviews: String!, $authoredIssues: String!, $authoredPrs: String!, $limit: Int!) {
    viewer { login }
    assignedIssues: search(query: $assignedIssues, type: ISSUE, first: $limit) {
      nodes { ...WorkItem }
    }
    assignedPullRequests: search(query: $assignedPrs, type: ISSUE, first: $limit) {
      nodes { ...WorkItem }
    }
    reviewRequests: search(query: $reviews, type: ISSUE, first: $limit) {
      nodes { ...WorkItem }
    }
    authoredIssues: search(query: $authoredIssues, type: ISSUE, first: $limit) {
      nodes { ...WorkItem }
    }
    authoredPullRequests: search(query: $authoredPrs, type: ISSUE, first: $limit) {
      nodes { ...WorkItem }
    }
  }
  fragment WorkItem on SearchResultItem {
    __typename
    ... on Issue { id number title url updatedAt repository { nameWithOwner } }
    ... on PullRequest {
      id number title url updatedAt isDraft reviewDecision mergeStateStatus
      repository { nameWithOwner }
      statusCheckRollup { state }
    }
  }`;
  const repoFilter = repositories.map((repository) => `repo:${repository}`).join(" ");
  const result = await ghGraphql<SearchResult>(query, {
    assignedIssues: `is:open is:issue assignee:${viewer.login} ${repoFilter}`,
    assignedPrs: `is:open is:pr assignee:${viewer.login} ${repoFilter}`,
    reviews: `is:open is:pr review-requested:${viewer.login} ${repoFilter}`,
    authoredIssues: `is:open is:issue author:${viewer.login} ${repoFilter}`,
    authoredPrs: `is:open is:pr author:${viewer.login} ${repoFilter}`,
    limit: Math.min(maxItems, 100),
  });
  return {
    login: result.data.viewer.login,
    assignedIssues: result.data.assignedIssues.nodes.map((item) =>
      normalizeWorkItem(item, ["assigned"])
    ),
    assignedPullRequests: result.data.assignedPullRequests.nodes.map((item) =>
      normalizeWorkItem(item, ["assigned"])
    ),
    reviewRequests: result.data.reviewRequests.nodes.map((item) =>
      normalizeWorkItem(item, reviewReasons(item))
    ),
    authoredIssues: result.data.authoredIssues.nodes.map((item) =>
      normalizeWorkItem(item, authoredReasons(item))
    ),
    authoredPullRequests: result.data.authoredPullRequests.nodes.map((item) =>
      normalizeWorkItem(item, authoredReasons(item))
    ),
  };
}

function normalizeWorkItem(item: SearchNode, actionReasons: string[] = []) {
  return {
    id: item.id,
    repository: item.repository.nameWithOwner,
    number: item.number,
    reference: `${item.repository.nameWithOwner}#${item.number}`,
    title: item.title,
    url: item.url,
    updatedAt: item.updatedAt,
    draft: item.isDraft ?? false,
    reviewDecision: item.reviewDecision ?? null,
    mergeStateStatus: item.mergeStateStatus ?? null,
    checks: item.statusCheckRollup?.state ?? null,
    actionRequired: actionReasons.length > 0,
    actionReasons,
  };
}

function reviewReasons(item: SearchNode): string[] {
  const reasons = [];
  if (!item.isDraft) reasons.push("review_requested");
  if (item.statusCheckRollup?.state === "FAILURE" || item.statusCheckRollup?.state === "ERROR") {
    reasons.push("checks_failed");
  }
  return reasons;
}

function authoredReasons(item: SearchNode): string[] {
  const reasons = [];
  if (item.statusCheckRollup?.state === "FAILURE" || item.statusCheckRollup?.state === "ERROR") {
    reasons.push("checks_failed");
  }
  if (item.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes_requested");
  if (item.mergeStateStatus === "DIRTY") reasons.push("merge_conflict");
  if (item.mergeStateStatus === "BLOCKED") reasons.push("merge_blocked");
  return reasons;
}
