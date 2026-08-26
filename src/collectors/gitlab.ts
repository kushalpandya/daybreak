import type { DaybreakConfig } from "../config.ts";
import type { RunContext } from "../types.ts";
import { glabApi } from "../integrations/glab.ts";
import { StateDatabase } from "../state/database.ts";
import { mapConcurrent, mapSettledConcurrent, metric } from "../utils.ts";

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

interface GitLabApprovals {
  approvals_required?: number;
  approvals_left?: number;
  approved_by?: Array<{ user?: { username?: string } }>;
}

/** Upper bound on merge requests enriched with pipeline and approval detail per project. */
const MAX_ENRICHED = 25;

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
  const recapSince = config.recapMs === null
    ? null
    : new Date(Date.parse(run.windows.github.end) - config.recapMs).toISOString();
  let projects;
  try {
    projects = await mapConcurrent(
      config.projects,
      3,
      (path) =>
        collectProject(host, user, path, state, run, writeState, collectedAt, limit, recapSince),
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
  recapSince: string | null,
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

  // The merge request list endpoint omits head_pipeline and reports detailed_merge_status as
  // "unchecked", so pipeline and approval state have to come from the per-MR endpoints. Only
  // the merge requests that reach the brief are enriched, and the count is capped.
  const detail = await enrichMergeRequests(host, project.id, [
    ...reviewMrs,
    ...authoredMrs,
    ...assignedMrs,
  ]);

  const recap = recapSince
    ? await collectRecap(host, project.id, user.id, recapSince, limit)
    : null;

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
    authoredMergeRequests: authoredMrs.map((mr) => normalizeMergeRequest(mr, "authored", detail)),
    assignedMergeRequests: assignedMrs.map((mr) => normalizeMergeRequest(mr, "assigned", detail)),
    reviewRequests: reviewMrs.map((mr) => normalizeMergeRequest(mr, "review_requested", detail)),
    recap,
  };
}

/** Merged MRs and closed issues in the recap window, for weekly summaries. */
async function collectRecap(
  host: string,
  projectId: number,
  userId: number,
  since: string,
  limit: number,
) {
  const query = `updated_after=${encodeURIComponent(since)}&author_id=${userId}&per_page=${limit}`;
  const [mergedMrs, closedIssues] = await Promise.all([
    glabApi<GitLabMergeRequest[]>(
      `projects/${projectId}/merge_requests?state=merged&${query}`,
      host,
    ),
    glabApi<GitLabIssue[]>(`projects/${projectId}/issues?state=closed&${query}`, host),
  ]);
  return {
    since,
    mergedMergeRequests: mergedMrs.map((mr) => ({
      reference: mr.references.full,
      title: mr.title,
      url: mr.web_url,
      updatedAt: mr.updated_at,
    })),
    closedIssues: closedIssues.map((issue) => ({
      reference: issue.references.full,
      title: issue.title,
      url: issue.web_url,
      updatedAt: issue.updated_at,
    })),
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

export interface MergeRequestDetail {
  pipeline: { id: number; status: string; url: string } | null;
  mergeStatus: string;
  approvals: { required: number; remaining: number; approvedBy: string[] } | null;
}

/** Fetches pipeline and approval state for each unique merge request, in parallel. */
async function enrichMergeRequests(
  host: string,
  projectId: number,
  mrs: GitLabMergeRequest[],
): Promise<Map<number, MergeRequestDetail>> {
  const iids = [...new Set(mrs.map((mr) => mr.iid))].slice(0, MAX_ENRICHED);
  const details = new Map<number, MergeRequestDetail>();
  const results = await mapSettledConcurrent(iids, 6, async (iid) => {
    const [full, approvals] = await Promise.all([
      glabApi<GitLabMergeRequest>(`projects/${projectId}/merge_requests/${iid}`, host),
      glabApi<GitLabApprovals>(`projects/${projectId}/merge_requests/${iid}/approvals`, host)
        .catch(() => null),
    ]);
    return { iid, full, approvals };
  });
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { iid, full, approvals } = result.value;
    details.set(iid, {
      pipeline: full.head_pipeline
        ? {
          id: full.head_pipeline.id,
          status: full.head_pipeline.status,
          url: full.head_pipeline.web_url,
        }
        : null,
      mergeStatus: full.detailed_merge_status,
      approvals: approvals
        ? {
          required: approvals.approvals_required ?? 0,
          remaining: approvals.approvals_left ?? 0,
          approvedBy: (approvals.approved_by ?? [])
            .map((entry) => entry.user?.username)
            .filter((name): name is string => Boolean(name)),
        }
        : null,
    });
  }
  return details;
}

function normalizeMergeRequest(
  mr: GitLabMergeRequest,
  responsibility: "authored" | "assigned" | "review_requested",
  detail: Map<number, MergeRequestDetail>,
) {
  const enriched = detail.get(mr.iid);
  const pipeline = enriched?.pipeline ?? null;
  const approvals = enriched?.approvals ?? null;
  const reasons: string[] = [];
  if (!mr.draft && responsibility !== "authored") reasons.push(responsibility);
  if (pipeline?.status === "failed") reasons.push("pipeline_failed");
  if (mr.has_conflicts) reasons.push("merge_conflict");
  if (!mr.blocking_discussions_resolved) reasons.push("unresolved_discussions");
  if (!mr.draft && responsibility === "authored" && approvals && approvals.remaining === 0) {
    reasons.push("ready_to_merge");
  }
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
    pipeline,
    approvals,
    mergeability: {
      status: enriched?.mergeStatus ?? mr.detailed_merge_status,
      hasConflicts: mr.has_conflicts,
    },
    discussionsResolved: mr.blocking_discussions_resolved,
    actionRequired: reasons.length > 0,
    actionReasons: reasons,
  };
}
