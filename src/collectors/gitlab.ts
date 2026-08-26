import type { DaybreakConfig } from "../config.ts";
import type { RunContext } from "../types.ts";
import { glabApi } from "../integrations/glab.ts";
import { StateDatabase } from "../state/database.ts";
import { mapConcurrent, metric } from "../utils.ts";

interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

interface GitLabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  updated_at: string;
  created_at: string;
  due_date: string | null;
  labels: string[];
  confidential: boolean;
  references: { full: string };
}

interface GitLabMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  updated_at: string;
  created_at: string;
  draft: boolean;
  detailed_merge_status: string;
  has_conflicts: boolean;
  blocking_discussions_resolved: boolean;
  labels: string[];
  references: { full: string };
  head_pipeline?: { id: number; status: string; web_url: string } | null;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
  star_count: number;
  forks_count: number;
  open_issues_count: number;
  archived: boolean;
}

export async function collectGitlab(
  config: NonNullable<DaybreakConfig["gitlab"]>,
  statePath: string,
  run: RunContext,
  writeState: boolean,
) {
  const host = config.host;
  const user = await glabApi<GitLabUser>("user", host);
  const limit = config.maxItemsPerCategory;
  const todos = await glabApi<unknown[]>(`todos?state=pending&per_page=${limit}`, host);
  const state = new StateDatabase(statePath);
  const collectedAt = new Date().toISOString();
  let projects;
  try {
    projects = await mapConcurrent(
      config.projects,
      3,
      (path) => collectProject(host, user, path, state, run, writeState, collectedAt, limit),
    );
  } finally {
    state.close();
  }

  return {
    data: {
      host,
      user: { id: user.id, username: user.username, name: user.name },
      todos: todos.slice(0, limit),
      projects,
    },
    warnings: [],
  };
}

async function collectProject(
  host: string,
  user: GitLabUser,
  path: string,
  state: StateDatabase,
  run: RunContext,
  writeState: boolean,
  collectedAt: string,
  limit: number,
) {
  const encoded = encodeURIComponent(path);
  const project = await glabApi<GitLabProject>(`projects/${encoded}`, host);
  const stateKey = `gitlab:${host}:${project.path_with_namespace}`;
  const previous = state.previousSnapshot(stateKey, run.windows.github.start);
  if (writeState) {
    state.saveSnapshot({
      repository: stateKey,
      stars: project.star_count,
      releaseDownloads: 0,
      recordedAt: collectedAt,
    });
  }
  const [authoredIssues, assignedIssues, authoredMrs, assignedMrs, reviewMrs] = await Promise.all([
    glabApi<GitLabIssue[]>(
      `projects/${project.id}/issues?state=opened&author_id=${user.id}&per_page=${limit}`,
      host,
    ),
    glabApi<GitLabIssue[]>(
      `projects/${project.id}/issues?state=opened&assignee_id=${user.id}&per_page=${limit}`,
      host,
    ),
    glabApi<GitLabMergeRequest[]>(
      `projects/${project.id}/merge_requests?state=opened&author_id=${user.id}&per_page=${limit}`,
      host,
    ),
    glabApi<GitLabMergeRequest[]>(
      `projects/${project.id}/merge_requests?state=opened&assignee_id=${user.id}&per_page=${limit}`,
      host,
    ),
    glabApi<GitLabMergeRequest[]>(
      `projects/${project.id}/merge_requests?state=opened&reviewer_id=${user.id}&per_page=${limit}`,
      host,
    ),
  ]);

  return {
    id: project.id,
    path: project.path_with_namespace,
    url: project.web_url,
    archived: project.archived,
    metrics: {
      stars: metric(project.star_count, previous?.stars, previous?.recordedAt),
      forks: project.forks_count,
      openIssues: project.open_issues_count,
    },
    authoredIssues: authoredIssues.map((issue) =>
      normalizeIssue(issue, "authored", run.reportingDate)
    ),
    assignedIssues: assignedIssues.map((issue) =>
      normalizeIssue(issue, "assigned", run.reportingDate)
    ),
    authoredMergeRequests: authoredMrs.map((mr) => normalizeMergeRequest(mr, "authored")),
    assignedMergeRequests: assignedMrs.map((mr) => normalizeMergeRequest(mr, "assigned")),
    reviewRequests: reviewMrs.map((mr) => normalizeMergeRequest(mr, "review_requested")),
  };
}

function normalizeIssue(
  issue: GitLabIssue,
  responsibility: "authored" | "assigned",
  reportingDate: string,
) {
  const overdue = issue.due_date ? issue.due_date < reportingDate : false;
  const actionReasons = responsibility === "assigned"
    ? overdue ? ["assigned", "overdue"] : ["assigned"]
    : overdue
    ? ["overdue"]
    : [];
  return {
    id: issue.id,
    iid: issue.iid,
    reference: issue.references.full,
    title: issue.title,
    url: issue.web_url,
    labels: issue.labels,
    confidential: issue.confidential,
    dueDate: issue.due_date,
    overdue,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    responsibility,
    actionRequired: actionReasons.length > 0,
    actionReasons,
  };
}

function normalizeMergeRequest(
  mr: GitLabMergeRequest,
  responsibility: "authored" | "assigned" | "review_requested",
) {
  const reasons: string[] = [];
  if (!mr.draft && responsibility !== "authored") reasons.push(responsibility);
  if (mr.head_pipeline?.status === "failed") reasons.push("pipeline_failed");
  if (mr.has_conflicts) reasons.push("merge_conflict");
  if (!mr.blocking_discussions_resolved) reasons.push("unresolved_discussions");
  return {
    id: mr.id,
    iid: mr.iid,
    reference: mr.references.full,
    title: mr.title,
    url: mr.web_url,
    labels: mr.labels,
    draft: mr.draft,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    responsibility,
    pipeline: mr.head_pipeline
      ? { id: mr.head_pipeline.id, status: mr.head_pipeline.status, url: mr.head_pipeline.web_url }
      : null,
    mergeability: {
      status: mr.detailed_merge_status,
      hasConflicts: mr.has_conflicts,
    },
    discussionsResolved: mr.blocking_discussions_resolved,
    actionRequired: reasons.length > 0,
    actionReasons: reasons,
  };
}
