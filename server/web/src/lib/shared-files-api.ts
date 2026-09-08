import { adminApi } from "./api";

export type SharedSpace = {
  spaceId: string;
  name: string;
  description: string;
  memberCount: number;
  fileCount: number;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
};

export type SharedSpaceMember = {
  userId: string;
  name: string;
  email: string;
  accountStatus: string;
  grantStatus: "complete" | "incomplete";
  actions: Array<"read" | "write">;
  joinedAt: string;
  updatedAt: string;
};

export type SharedSpaceCandidate = {
  userId: string;
  name: string;
  email: string;
};

export type SharedFile = {
  fileId: string;
  spaceId: string;
  logicalPath: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  revision: number;
  updatedByUserId: string;
  updatedByUserName: string;
  updatedByAgentId: string;
  updatedAt: string;
};

export class SharedFileAPIError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SharedFileAPIError";
  }
}

type PageMeta = { next_cursor: string; has_next: boolean };
type ListEnvelope<T> = { data: T[]; meta: PageMeta };

type SharedSpaceResponse = {
  space_id: string;
  name: string;
  description: string;
  member_count?: number;
  file_count?: number;
  size_bytes?: number;
  created_by?: string;
  created_at?: string;
  updated_by?: string;
  updated_at: string;
};

type MemberResponse = {
  user_id: string;
  name: string;
  email: string;
  account_status: string;
  grant_status: "complete" | "incomplete";
  actions: Array<"read" | "write">;
  joined_at: string;
  updated_at: string;
};

type CandidateResponse = { user_id: string; name: string; email: string };
type SharedFileResponse = {
  file_id: string;
  space_id: string;
  logical_path: string;
  file_name: string;
  size_bytes: number;
  content_type: string;
  revision: number;
  updated_by_user_id: string;
  updated_by_user_name?: string;
  updated_by_agent_id?: string | null;
  updated_at: string;
};

type UploadResponse = {
  file_id: string;
  space_id: string;
  logical_path: string;
  file_name: string;
  size_bytes: number;
  content_type: string;
  revision: number;
  created: boolean;
  sha256: string;
  updated_at: string;
};

export async function listSharedSpaces(input: { query?: string; cursor?: string }) {
  const params = new URLSearchParams({ limit: "50" });
  if (input.query?.trim()) params.set("query", input.query.trim());
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await adminApi.get<ListEnvelope<SharedSpaceResponse>>(`/shared-spaces?${params}`);
  return { items: response.data.map(mapSpace), meta: response.meta };
}

export async function getSharedSpace(spaceId: string) {
  const response = await adminApi.get<SharedSpaceResponse>(`/shared-spaces/detail?space_id=${encodeURIComponent(spaceId)}`);
  return mapSpace(response);
}

export async function createSharedSpace(input: { name: string; description: string }) {
  return mapSpace(await adminApi.post<SharedSpaceResponse>("/shared-spaces", input));
}

export async function updateSharedSpace(input: { spaceId: string; name: string; description: string }) {
  return mapSpace(await adminApi.patch<SharedSpaceResponse>("/shared-spaces", {
    space_id: input.spaceId,
    name: input.name,
    description: input.description
  }));
}

export async function listSharedSpaceMembers(input: { spaceId: string; query?: string; cursor?: string }) {
  const params = new URLSearchParams({ space_id: input.spaceId, limit: "100" });
  if (input.query?.trim()) params.set("query", input.query.trim());
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await adminApi.get<ListEnvelope<MemberResponse>>(`/shared-spaces/account-grants?${params}`);
  return { items: response.data.map(mapMember), meta: response.meta };
}

export async function listSharedSpaceCandidates(input: { spaceId: string; query?: string; cursor?: string }) {
  const params = new URLSearchParams({ space_id: input.spaceId, limit: "100" });
  if (input.query?.trim()) params.set("query", input.query.trim());
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await adminApi.get<ListEnvelope<CandidateResponse>>(`/shared-spaces/member-candidates?${params}`);
  return { items: response.data.map((item) => ({ userId: item.user_id, name: item.name, email: item.email })), meta: response.meta };
}

export async function addSharedSpaceMember(input: { spaceId: string; userId: string; actions: Array<"read" | "write"> }) {
  return mapMember(await adminApi.post<MemberResponse>("/shared-spaces/account-grants", {
    space_id: input.spaceId,
    user_id: input.userId,
    actions: input.actions
  }));
}

export async function updateSharedSpaceMember(input: { spaceId: string; userId: string; actions: Array<"read" | "write"> }) {
  return mapMember(await adminApi.patch<MemberResponse>("/shared-spaces/account-grants", {
    space_id: input.spaceId,
    user_id: input.userId,
    actions: input.actions
  }));
}

export function removeSharedSpaceMember(input: { spaceId: string; userId: string }) {
  return adminApi.post<void>("/shared-spaces/account-grants/remove", {
    space_id: input.spaceId,
    user_id: input.userId
  });
}

export async function listSharedFiles(input: { spaceId: string; query?: string; logicalPathPrefix?: string; cursor?: string }) {
  const params = new URLSearchParams({ space_id: input.spaceId, limit: "50" });
  if (input.query?.trim()) params.set("query", input.query.trim());
  if (input.logicalPathPrefix?.trim()) params.set("logical_path_prefix", input.logicalPathPrefix.trim());
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await adminApi.get<ListEnvelope<SharedFileResponse>>(`/shared-files?${params}`);
  return { items: response.data.map(mapFile), meta: response.meta };
}

export async function uploadSharedFile(input: { spaceId: string; logicalPath: string; file: File; expectedRevision?: number }) {
  const params = new URLSearchParams({ space_id: input.spaceId, logical_path: input.logicalPath });
  if (input.expectedRevision !== undefined) params.set("expected_revision", String(input.expectedRevision));
  const response = await fetch(`/api/v1/admin/shared-files/content?${params}`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": input.file.type || "application/octet-stream"
    },
    body: input.file
  });
  if (!response.ok) {
    throw await sharedFileError(response);
  }
  const body = await response.json() as { data: UploadResponse };
  return {
    fileId: body.data.file_id,
    spaceId: body.data.space_id,
    logicalPath: body.data.logical_path,
    fileName: body.data.file_name,
    sizeBytes: body.data.size_bytes,
    contentType: body.data.content_type,
    revision: body.data.revision,
    created: body.data.created,
    sha256: body.data.sha256,
    updatedAt: body.data.updated_at
  };
}

export function sharedFileDownloadURL(fileId: string) {
  return `/api/v1/admin/shared-files/content?file_id=${encodeURIComponent(fileId)}`;
}

function mapSpace(item: SharedSpaceResponse): SharedSpace {
  return {
    spaceId: item.space_id,
    name: item.name,
    description: item.description,
    memberCount: item.member_count ?? 0,
    fileCount: item.file_count ?? 0,
    sizeBytes: item.size_bytes ?? 0,
    createdBy: item.created_by ?? "",
    createdAt: item.created_at ?? "",
    updatedBy: item.updated_by ?? "",
    updatedAt: item.updated_at
  };
}

function mapMember(item: MemberResponse): SharedSpaceMember {
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

function mapFile(item: SharedFileResponse): SharedFile {
  return {
    fileId: item.file_id,
    spaceId: item.space_id,
    logicalPath: item.logical_path,
    fileName: item.file_name,
    sizeBytes: item.size_bytes,
    contentType: item.content_type,
    revision: item.revision,
    updatedByUserId: item.updated_by_user_id,
    updatedByUserName: item.updated_by_user_name ?? item.updated_by_user_id,
    updatedByAgentId: item.updated_by_agent_id ?? "",
    updatedAt: item.updated_at
  };
}

async function sharedFileError(response: Response) {
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    return new SharedFileAPIError(body.error?.code ?? "request_failed", body.error?.message ?? `文件上传失败（${response.status}）`);
  } catch {
    return new SharedFileAPIError("request_failed", `文件上传失败（${response.status}）`);
  }
}
