import { adminApi, appApi, unwrapAPIResponse } from "./api";

type ListResponse<T> = { items: T[] };

export type AdminSkill = {
  skillId: string;
  spaceId?: string;
  spaceName?: string;
  name: string;
  description: string;
  currentVersionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillVersion = {
  versionId: string;
  skillId: string;
  version: string;
  description: string;
  changelog: string;
  packageSha256: string;
  source: SkillVersionSource | null;
  createdAt: string;
};

export type SkillVersionSource = {
  sourceId: string;
  repositoryOwner: string;
  repositoryName: string;
  path: string;
  commitSha: string;
  contentSha256: string;
};

export type GitHubSource = {
  sourceId: string;
  spaceId?: string;
  provider: string;
  repositoryOwner: string;
  repositoryName: string;
  branch: string;
  scanRoot: string;
  excludePaths: string[];
  hasToken: boolean;
  autoPublish: boolean;
  schedule: string;
  status: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSyncedCommitSha: string | null;
  lastErrorSummary: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillSourceItem = {
  sourceItemId: string;
  sourceId: string;
  skillPath: string;
  discoveredName: string;
  skillId: string | null;
  status: string;
  lastSeenCommitSha: string | null;
  lastContentSha256: string | null;
  lastVersionId: string | null;
  lastErrorSummary: string;
  missingSince: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillSourceSyncRun = {
  runId: string;
  sourceId: string;
  trigger: string;
  repositoryMode: string;
  status: string;
  requestedBy: string;
  beforeCommitSha: string | null;
  targetCommitSha: string | null;
  discoveredCount: number;
  createdVersionCount: number;
  publishedCount: number;
  conflictCount: number;
  failedCount: number;
  errorSummary: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type GitHubSourceDetail = {
  source: GitHubSource;
  items: SkillSourceItem[];
  manualClone: ManualCloneInstructions | null;
};

export type ManualCloneInstructions = {
  workingDirectory: string;
  repositoryDirectory: string;
  command: string;
  commandGroups: ManualGitCommandGroup[];
};

export type ManualGitCommandGroup = {
  title: string;
  commands: string[];
};

export type GitHubSourceSummary = {
  source: GitHubSource;
  latestRun: SkillSourceSyncRun | null;
  discoveredCount: number;
};

export type AdminSkillDetail = {
  skill: AdminSkill;
  versions: SkillVersion[];
};

export type SkillMutationResult = {
  skill: AdminSkill;
  version: SkillVersion;
};

export type SkillBatchPublishCandidate = Pick<AdminSkill, "skillId" | "name">;

export type SkillBatchPublishResult = {
  published: SkillMutationResult[];
  failed: Array<SkillBatchPublishCandidate & { error: unknown }>;
};

export type SkillSpaceMoveResult = {
  targetSpaceId: string;
  movedCount: number;
  unchangedCount: number;
};

export type SkillVersionFile = {
  path: string;
  size: number;
};

export type SkillVersionFileContent = SkillVersionFile & {
  content: string;
};

export type PublishedSkill = {
  skillId: string;
  spaceId?: string;
  spaceName?: string;
  name: string;
  description: string;
  versionId: string;
  version: string;
  packageSha256: string;
  changelog?: string;
  updatedAt: string;
};

export type SkillSpace = {
  spaceId: string;
  name: string;
  description: string;
  actions: Array<"read" | "write">;
  memberCount: number;
  skillCount: number;
  publishedCount: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillSpaceMember = {
  userId: string;
  name: string;
  email: string;
  accountStatus: string;
  grantStatus: string;
  actions: Array<"read" | "write">;
  joinedAt: string;
  updatedAt: string;
};

export type SkillSpaceCandidate = { userId: string; name: string; email: string };

export class SkillHubAPIError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "SkillHubAPIError";
    this.status = status;
    this.code = code;
  }
}

type AdminSkillResponse = {
  skill_id: string;
  space_id: string;
  space_name: string;
  name: string;
  description: string;
  current_version_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type SkillVersionResponse = {
  version_id: string;
  skill_id: string;
  version: string;
  description: string;
  changelog: string;
  package_sha256: string;
  source: SkillVersionSourceResponse | null;
  created_at: string;
};

type SkillVersionSourceResponse = {
  source_id: string;
  repository_owner: string;
  repository_name: string;
  path: string;
  commit_sha: string;
  content_sha256: string;
};

type GitHubSourceResponse = {
  source_id: string;
  space_id: string;
  provider: string;
  repository_owner: string;
  repository_name: string;
  branch: string;
  scan_root: string;
  exclude_paths: string[];
  has_token: boolean;
  auto_publish: boolean;
  schedule: string;
  status: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_synced_commit_sha: string | null;
  last_error_summary: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type SkillSourceItemResponse = {
  source_item_id: string;
  source_id: string;
  skill_path: string;
  discovered_name: string;
  skill_id: string | null;
  status: string;
  last_seen_commit_sha: string | null;
  last_content_sha256: string | null;
  last_version_id: string | null;
  last_error_summary: string;
  missing_since: string | null;
  created_at: string;
  updated_at: string;
};

type SkillSourceSyncRunResponse = {
  run_id: string;
  source_id: string;
  trigger: string;
  repository_mode: string;
  status: string;
  requested_by: string;
  before_commit_sha: string | null;
  target_commit_sha: string | null;
  discovered_count: number;
  created_version_count: number;
  published_count: number;
  conflict_count: number;
  failed_count: number;
  error_summary: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type GitHubSourceDetailResponse = {
  source: GitHubSourceResponse;
  items: SkillSourceItemResponse[];
  manual_clone: {
    working_directory: string;
    repository_directory: string;
    command: string;
    command_groups: {
      title: string;
      commands: string[];
    }[];
  } | null;
};

type GitHubSourceSummaryResponse = {
  source: GitHubSourceResponse;
  latest_run: SkillSourceSyncRunResponse | null;
  discovered_count: number;
};

type GitHubSourceInput = {
  spaceId?: string;
  repositoryOwner: string;
  repositoryName: string;
  branch: string;
  scanRoot: string;
  excludePaths: string[];
  token?: string;
  autoPublish: boolean;
  schedule: string;
};

type AdminSkillDetailResponse = {
  skill: AdminSkillResponse;
  versions: SkillVersionResponse[];
};

type SkillMutationResponse = {
  skill: AdminSkillResponse;
  version: SkillVersionResponse;
};

type PublishedSkillResponse = {
  skill_id: string;
  space_id: string;
  space_name: string;
  name: string;
  description: string;
  version_id: string;
  version: string;
  package_sha256: string;
  changelog?: string;
  updated_at: string;
};

type SkillSpaceResponse = {
  space_id: string;
  name: string;
  description: string;
  actions?: Array<"read" | "write">;
  member_count?: number;
  skill_count?: number;
  published_count?: number;
  created_by?: string;
  updated_by?: string;
  created_at?: string;
  updated_at: string;
};

type SkillSpaceMoveResponse = {
  target_space_id: string;
  moved_count: number;
  unchanged_count: number;
};

type SkillSpaceMemberResponse = {
  user_id: string;
  name: string;
  email: string;
  account_status: string;
  grant_status: string;
  actions: Array<"read" | "write">;
  joined_at: string;
  updated_at: string;
};

export async function listSkills() {
  const response = await adminApi.get<ListResponse<AdminSkillResponse>>("/skills");
  return response.items.map(mapSkill);
}

export async function listPublishedSkills() {
  const response = await appApi.get<ListResponse<PublishedSkillResponse>>("/skills");
  return response.items.map(mapPublishedSkill);
}

export async function getPublishedSkill(skillId: string) {
  return mapPublishedSkill(await appApi.get<PublishedSkillResponse>(`/skills/detail?skill_id=${encodeURIComponent(skillId)}`));
}

export function getPublishedSkillPackageURL(skillId: string, versionId: string) {
  return `/api/v1/app/skills/package?skill_id=${encodeURIComponent(skillId)}&version_id=${encodeURIComponent(versionId)}`;
}

export function listPublishedSkillVersionFiles(skillId: string, versionId: string) {
  return skillHubGet<ListResponse<SkillVersionFile>>(
    `/api/v1/app/skills/version-files?skill_id=${encodeURIComponent(skillId)}&version_id=${encodeURIComponent(versionId)}`
  );
}

export function getPublishedSkillVersionFile(skillId: string, versionId: string, path: string) {
  return skillHubGet<SkillVersionFileContent>(
    `/api/v1/app/skills/version-file?skill_id=${encodeURIComponent(skillId)}&version_id=${encodeURIComponent(versionId)}&path=${encodeURIComponent(path)}`
  );
}

export async function getSkill(skillId: string) {
  const response = await adminApi.get<AdminSkillDetailResponse>(`/skills/detail?skill_id=${encodeURIComponent(skillId)}`);
  return { skill: mapSkill(response.skill), versions: response.versions.map(mapVersion) };
}

type SkillVersionUploadInput = { spaceId?: string; version: string; changelog: string; packageFile: File };

export function uploadSkillVersion(input: SkillVersionUploadInput) {
  return uploadSkillVersionTo("/api/v1/admin/skills/versions", input);
}

export function uploadAppSkillVersion(input: SkillVersionUploadInput) {
  return uploadSkillVersionTo("/api/v1/app/skills/versions", input);
}

async function uploadSkillVersionTo(url: string, input: SkillVersionUploadInput) {
  const body = new FormData();
  if (input.spaceId) body.append("space_id", input.spaceId);
  body.append("version", input.version);
  if (input.changelog) body.append("changelog", input.changelog);
  body.append("package", input.packageFile);
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
    body
  });
  if (!response.ok) throw new Error(await responseError(response, `上传失败 (${response.status})`));
  return mapMutation(unwrapAPIResponse<SkillMutationResponse>(await response.json()));
}

export async function listSkillSpaces() {
  const response = await adminApi.get<ListResponse<SkillSpaceResponse>>("/skill-spaces");
  return response.items.map(mapSkillSpace);
}

export async function moveSkillsToSpace(input: { skillIds: string[]; targetSpaceId: string }): Promise<SkillSpaceMoveResult> {
  const response = await adminApi.patch<SkillSpaceMoveResponse>("/skills/space", {
    skill_ids: input.skillIds,
    target_space_id: input.targetSpaceId
  });
  return {
    targetSpaceId: response.target_space_id,
    movedCount: response.moved_count,
    unchangedCount: response.unchanged_count
  };
}

export async function listAuthorizedSkillSpaces() {
  const response = await appApi.get<ListResponse<SkillSpaceResponse>>("/skill-spaces");
  return response.items.map(mapSkillSpace);
}

export async function createSkillSpace(input: { name: string; description: string }) {
  return mapSkillSpace(await adminApi.post<SkillSpaceResponse>("/skill-spaces", input));
}

export async function updateSkillSpace(input: { spaceId: string; name: string; description: string }) {
  return mapSkillSpace(await adminApi.patch<SkillSpaceResponse>("/skill-spaces", { space_id: input.spaceId, name: input.name, description: input.description }));
}

export async function listSkillSpaceMembers(spaceId: string, query = "") {
  const params = new URLSearchParams({ space_id: spaceId });
  if (query.trim()) params.set("query", query.trim());
  const response = await adminApi.get<ListResponse<SkillSpaceMemberResponse>>(`/skill-spaces/account-grants?${params.toString()}`);
  return response.items.map(mapSkillSpaceMember);
}

export async function listSkillSpaceCandidates(spaceId: string, query = "") {
  const params = new URLSearchParams({ space_id: spaceId });
  if (query.trim()) params.set("query", query.trim());
  const response = await adminApi.get<ListResponse<{ user_id: string; name: string; email: string }>>(`/skill-spaces/member-candidates?${params.toString()}`);
  return response.items.map((item) => ({ userId: item.user_id, name: item.name, email: item.email }));
}

export async function addSkillSpaceMember(input: { spaceId: string; userId: string; actions: Array<"read" | "write"> }) {
  return mapSkillSpaceMember(await adminApi.post<SkillSpaceMemberResponse>("/skill-spaces/account-grants", { space_id: input.spaceId, user_id: input.userId, actions: input.actions }));
}

export async function updateSkillSpaceMember(input: { spaceId: string; userId: string; actions: Array<"read" | "write"> }) {
  return mapSkillSpaceMember(await adminApi.patch<SkillSpaceMemberResponse>("/skill-spaces/account-grants", { space_id: input.spaceId, user_id: input.userId, actions: input.actions }));
}

export function removeSkillSpaceMember(input: { spaceId: string; userId: string }) {
  return adminApi.post<void>("/skill-spaces/account-grants/remove", { space_id: input.spaceId, user_id: input.userId });
}

export async function setCurrentSkillVersion(skillId: string, versionId: string) {
  const response = await adminApi.put<SkillMutationResponse>(
    "/skills/current-version",
    { skill_id: skillId, version_id: versionId }
  );
  return mapMutation(response);
}

export async function publishLatestSkillVersions(candidates: SkillBatchPublishCandidate[]): Promise<SkillBatchPublishResult> {
  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    const detail = await getSkill(candidate.skillId);
    const latest = [...detail.versions].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    if (!latest) throw new Error("没有可发布的版本");
    return setCurrentSkillVersion(candidate.skillId, latest.versionId);
  }));

  return settled.reduce<SkillBatchPublishResult>((result, item, index) => {
    if (item.status === "fulfilled") {
      result.published.push(item.value);
    } else {
      result.failed.push({ ...candidates[index], error: item.reason });
    }
    return result;
  }, { published: [], failed: [] });
}

export function clearCurrentSkillVersion(skillId: string) {
  return adminApi.post<void>("/skills/current-version/remove", { skill_id: skillId });
}

export async function listGitHubSources() {
  const response = await adminApi.get<ListResponse<GitHubSourceSummaryResponse>>("/skill-sources");
  return response.items.map(mapGitHubSourceSummary);
}

export async function getSkillSourceAvailability() {
  const response = await adminApi.get<{ skill_source_enabled: boolean }>("/status");
  return response.skill_source_enabled;
}

export async function getGitHubSource(sourceId: string): Promise<GitHubSourceDetail> {
  const response = await adminApi.get<GitHubSourceDetailResponse>(`/skill-sources/detail?source_id=${encodeURIComponent(sourceId)}`);
  return {
    source: mapGitHubSource(response.source),
    items: response.items.map(mapSkillSourceItem),
    manualClone: response.manual_clone == null ? null : {
      workingDirectory: response.manual_clone.working_directory,
      repositoryDirectory: response.manual_clone.repository_directory,
      command: response.manual_clone.command,
      commandGroups: response.manual_clone.command_groups.map((group) => ({
        title: group.title,
        commands: group.commands
      }))
    }
  };
}

export async function getGitHubSourceToken(sourceId: string) {
  const response = await adminApi.get<{ token: string }>(`/skill-sources/token?source_id=${encodeURIComponent(sourceId)}`);
  return response.token;
}

export async function createGitHubSource(input: GitHubSourceInput) {
  return mapGitHubSource(await adminApi.post<GitHubSourceResponse>("/skill-sources", mapGitHubSourceInput(input)));
}

export async function updateGitHubSource(sourceId: string, input: GitHubSourceInput) {
  return mapGitHubSource(await adminApi.put<GitHubSourceResponse>("/skill-sources", {
    source_id: sourceId,
    ...mapGitHubSourceInput(input)
  }));
}

export async function queueGitHubSourceSync(sourceId: string) {
  const response = await adminApi.post<{ run_id: string }>("/skill-sources/sync", { source_id: sourceId });
  return { runId: response.run_id };
}

export async function queueGitHubSourceLocalScan(sourceId: string) {
  const response = await adminApi.post<{ run_id: string }>("/skill-sources/scan-local", { source_id: sourceId });
  return { runId: response.run_id };
}

export async function disableGitHubSource(sourceId: string) {
  return mapGitHubSource(await adminApi.post<GitHubSourceResponse>("/skill-sources/disable", { source_id: sourceId }));
}

export async function enableGitHubSource(sourceId: string) {
  return mapGitHubSource(await adminApi.post<GitHubSourceResponse>("/skill-sources/enable", { source_id: sourceId }));
}

export async function removeGitHubSourceToken(sourceId: string) {
  return mapGitHubSource(await adminApi.post<GitHubSourceResponse>("/skill-sources/token/remove", { source_id: sourceId }));
}

export async function bindGitHubSourceItem(sourceItemId: string, skillId: string) {
  return mapSkillSourceItem(await adminApi.post<SkillSourceItemResponse>("/skill-sources/items/bind", {
    source_item_id: sourceItemId,
    skill_id: skillId
  }));
}

export async function unbindGitHubSourceItem(sourceItemId: string) {
  return mapSkillSourceItem(await adminApi.post<SkillSourceItemResponse>("/skill-sources/items/unbind", {
    source_item_id: sourceItemId
  }));
}

export async function listGitHubSourceSyncRuns(sourceId: string) {
  const response = await adminApi.get<ListResponse<SkillSourceSyncRunResponse>>(
    `/skill-sources/sync-runs?source_id=${encodeURIComponent(sourceId)}`
  );
  return response.items.map(mapSkillSourceSyncRun);
}

export function listSkillVersionFiles(skillId: string, versionId: string) {
  return skillHubGet<ListResponse<SkillVersionFile>>(
    `/api/v1/admin/skills/version-files?skill_id=${encodeURIComponent(skillId)}&version_id=${encodeURIComponent(versionId)}`
  );
}

export function getSkillVersionFile(skillId: string, versionId: string, path: string) {
  return skillHubGet<SkillVersionFileContent>(
    `/api/v1/admin/skills/version-file?skill_id=${encodeURIComponent(skillId)}&version_id=${encodeURIComponent(versionId)}&path=${encodeURIComponent(path)}`
  );
}

export function getSkillVersionPackageURL(skillId: string, versionId: string) {
  return `/api/v1/admin/skills/version-package?skill_id=${encodeURIComponent(skillId)}&version_id=${encodeURIComponent(versionId)}`;
}

function mapSkill(item: AdminSkillResponse): AdminSkill {
  return {
    skillId: item.skill_id,
    spaceId: item.space_id,
    spaceName: item.space_name,
    name: item.name,
    description: item.description,
    currentVersionId: item.current_version_id,
    createdBy: item.created_by,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
}

function mapVersion(item: SkillVersionResponse): SkillVersion {
  return {
    versionId: item.version_id,
    skillId: item.skill_id,
    version: item.version,
    description: item.description,
    changelog: item.changelog,
    packageSha256: item.package_sha256,
    source: item.source === null ? null : mapSkillVersionSource(item.source),
    createdAt: item.created_at
  };
}

function mapSkillVersionSource(item: SkillVersionSourceResponse): SkillVersionSource {
  return {
    sourceId: item.source_id,
    repositoryOwner: item.repository_owner,
    repositoryName: item.repository_name,
    path: item.path,
    commitSha: item.commit_sha,
    contentSha256: item.content_sha256
  };
}

export function githubCommitURL(source: SkillVersionSource) {
  return `https://github.com/${encodeURIComponent(source.repositoryOwner)}/${encodeURIComponent(source.repositoryName)}/commit/${encodeURIComponent(source.commitSha)}`;
}

function mapGitHubSource(item: GitHubSourceResponse): GitHubSource {
  return {
    sourceId: item.source_id,
    spaceId: item.space_id,
    provider: item.provider,
    repositoryOwner: item.repository_owner,
    repositoryName: item.repository_name,
    branch: item.branch,
    scanRoot: item.scan_root,
    excludePaths: item.exclude_paths,
    hasToken: item.has_token,
    autoPublish: item.auto_publish,
    schedule: item.schedule,
    status: item.status,
    lastAttemptAt: item.last_attempt_at,
    lastSuccessAt: item.last_success_at,
    lastSyncedCommitSha: item.last_synced_commit_sha,
    lastErrorSummary: item.last_error_summary,
    createdBy: item.created_by,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
}

function mapSkillSourceItem(item: SkillSourceItemResponse): SkillSourceItem {
  return {
    sourceItemId: item.source_item_id,
    sourceId: item.source_id,
    skillPath: item.skill_path,
    discoveredName: item.discovered_name,
    skillId: item.skill_id,
    status: item.status,
    lastSeenCommitSha: item.last_seen_commit_sha,
    lastContentSha256: item.last_content_sha256,
    lastVersionId: item.last_version_id,
    lastErrorSummary: item.last_error_summary,
    missingSince: item.missing_since,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
}

function mapSkillSourceSyncRun(item: SkillSourceSyncRunResponse): SkillSourceSyncRun {
  return {
    runId: item.run_id,
    sourceId: item.source_id,
    trigger: item.trigger,
    repositoryMode: item.repository_mode,
    status: item.status,
    requestedBy: item.requested_by,
    beforeCommitSha: item.before_commit_sha,
    targetCommitSha: item.target_commit_sha,
    discoveredCount: item.discovered_count,
    createdVersionCount: item.created_version_count,
    publishedCount: item.published_count,
    conflictCount: item.conflict_count,
    failedCount: item.failed_count,
    errorSummary: item.error_summary,
    startedAt: item.started_at,
    finishedAt: item.finished_at,
    createdAt: item.created_at
  };
}

function mapGitHubSourceSummary(item: GitHubSourceSummaryResponse): GitHubSourceSummary {
  return {
    source: mapGitHubSource(item.source),
    latestRun: item.latest_run === null ? null : mapSkillSourceSyncRun(item.latest_run),
    discoveredCount: item.discovered_count
  };
}

function mapGitHubSourceInput(input: GitHubSourceInput) {
  return {
    space_id: input.spaceId,
    repository_owner: input.repositoryOwner,
    repository_name: input.repositoryName,
    branch: input.branch,
    scan_root: input.scanRoot,
    exclude_paths: input.excludePaths,
    ...(input.token === undefined ? {} : { token: input.token }),
    auto_publish: input.autoPublish,
    schedule: input.schedule
  };
}

function mapMutation(item: SkillMutationResponse): SkillMutationResult {
  return { skill: mapSkill(item.skill), version: mapVersion(item.version) };
}

function mapPublishedSkill(item: PublishedSkillResponse): PublishedSkill {
  return {
    skillId: item.skill_id,
    spaceId: item.space_id,
    spaceName: item.space_name,
    name: item.name,
    description: item.description,
    versionId: item.version_id,
    version: item.version,
    packageSha256: item.package_sha256,
    changelog: item.changelog,
    updatedAt: item.updated_at
  };
}

function mapSkillSpace(item: SkillSpaceResponse): SkillSpace {
  return {
    spaceId: item.space_id,
    name: item.name,
    description: item.description,
    actions: item.actions ?? [],
    memberCount: item.member_count ?? 0,
    skillCount: item.skill_count ?? 0,
    publishedCount: item.published_count ?? 0,
    createdBy: item.created_by ?? "",
    updatedBy: item.updated_by ?? "",
    createdAt: item.created_at ?? "",
    updatedAt: item.updated_at
  };
}

function mapSkillSpaceMember(item: SkillSpaceMemberResponse): SkillSpaceMember {
  return {
    userId: item.user_id,
    name: item.name,
    email: item.email,
    accountStatus: item.account_status,
    grantStatus: item.grant_status,
    actions: item.actions,
    joinedAt: item.joined_at,
    updatedAt: item.updated_at
  };
}

async function skillHubGet<T>(url: string) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    const fallback = `GET ${url} failed with ${response.status}`;
    try {
      const body = (await response.json()) as { code?: string; error?: string | { code?: string; message?: string } };
      const message = typeof body.error === "string" ? body.error : body.error?.message;
      const code = typeof body.error === "object" ? body.error?.code : body.code;
      throw new SkillHubAPIError(message?.trim() || fallback, response.status, code?.trim() || "unknown_error");
    } catch (error) {
      if (error instanceof SkillHubAPIError) throw error;
      throw new SkillHubAPIError(fallback, response.status, "unknown_error");
    }
  }
  return unwrapAPIResponse<T>(await response.json());
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string | { message?: string } };
    return (typeof body.error === "string" ? body.error : body.error?.message)?.trim() || fallback;
  } catch {
    return fallback;
  }
}
