import { adminApi, unwrapAPIResponse } from "./api";

type ListResponse<T> = { items: T[] };

export type KnowledgeBase = {
  knowledgeBaseId: string;
  name: string;
  description: string;
  providerType: string;
  status: string;
  errorMessage: string;
  documentCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeDocument = {
  documentId: string;
  knowledgeBaseId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  status: string;
  errorMessage: string;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type DataResourceGrant = {
  grantId: string;
  userId: string;
  resourceType: string;
  resourceId: string;
  action: "read" | "upload" | "mcp";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeMember = {
  userId: string;
  name: string;
  email: string;
  accountStatus: string;
  actions: DataResourceGrant["action"][];
  updatedAt: string;
};

export type KnowledgeMemberCandidate = {
  userId: string;
  name: string;
  email: string;
};

type KnowledgeBaseResponse = {
  knowledge_base_id: string;
  name: string;
  description: string;
  provider_type: string;
  status: string;
  error_message: string;
  document_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type KnowledgeDocumentResponse = {
  document_id: string;
  knowledge_base_id: string;
  name: string;
  size_bytes: number;
  mime_type: string;
  status: string;
  error_message: string;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
};

type DataResourceGrantResponse = {
  grant_id: string;
  user_id: string;
  resource_type: string;
  resource_id: string;
  action: "read" | "upload" | "mcp";
  created_by: string;
  created_at: string;
  updated_at: string;
};

type KnowledgeMemberResponse = {
  user_id: string;
  name: string;
  email: string;
  account_status: string;
  actions: DataResourceGrantResponse["action"][];
  updated_at: string;
};

type KnowledgeMemberCandidateResponse = {
  user_id: string;
  name: string;
  email: string;
};

export async function listKnowledgeBases() {
  const response = await adminApi.get<ListResponse<KnowledgeBaseResponse>>("/knowledge-bases");
  return response.items.map(mapKnowledgeBase);
}

export async function createKnowledgeBase(input: { name: string; description: string }) {
  return mapKnowledgeBase(await adminApi.post<KnowledgeBaseResponse>("/knowledge-bases", input));
}

export async function updateKnowledgeBase(input: { knowledgeBaseId: string; name: string; description: string }) {
  return mapKnowledgeBase(await adminApi.patch<KnowledgeBaseResponse>("/knowledge-bases", {
    knowledge_base_id: input.knowledgeBaseId,
    name: input.name,
    description: input.description
  }));
}

export function deleteKnowledgeBase(knowledgeBaseId: string) {
  return adminApi.post<void>("/knowledge-bases/remove", { knowledge_base_id: knowledgeBaseId });
}

export async function listKnowledgeDocuments(knowledgeBaseId: string) {
  const response = await adminApi.get<ListResponse<KnowledgeDocumentResponse>>(
    `/knowledge-bases/documents?knowledge_base_id=${encodeURIComponent(knowledgeBaseId)}`
  );
  return response.items.map(mapKnowledgeDocument);
}

export async function syncKnowledgeDocuments(knowledgeBaseId: string) {
  const response = await adminApi.post<ListResponse<KnowledgeDocumentResponse>>(
    "/knowledge-bases/documents/sync",
    { knowledge_base_id: knowledgeBaseId }
  );
  return response.items.map(mapKnowledgeDocument);
}

export async function uploadKnowledgeDocument(knowledgeBaseId: string, file: File) {
  const body = new FormData();
  body.append("knowledge_base_id", knowledgeBaseId);
  body.append("file", file);
  const response = await fetch("/api/v1/admin/knowledge-bases/documents", {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
    body
  });
  if (!response.ok) {
    throw new Error(await responseError(response, `上传失败 (${response.status})`));
  }
  return mapKnowledgeDocument(unwrapAPIResponse<KnowledgeDocumentResponse>(await response.json()));
}

export function deleteKnowledgeDocument(knowledgeBaseId: string, documentId: string) {
  return adminApi.post<void>("/knowledge-bases/documents/remove", {
    knowledge_base_id: knowledgeBaseId,
    document_id: documentId
  });
}

export async function listKnowledgeAccountGrants(knowledgeBaseId: string): Promise<DataResourceGrant[]> {
  const response = await adminApi.get<ListResponse<DataResourceGrantResponse>>(
    `/knowledge-bases/account-grants?knowledge_base_id=${encodeURIComponent(knowledgeBaseId)}`
  );
  return response.items.map(mapDataResourceGrant);
}

export async function listKnowledgeMembers(knowledgeBaseId: string, query = "") {
  const params = new URLSearchParams({ knowledge_base_id: knowledgeBaseId });
  if (query.trim()) params.set("query", query.trim());
  const response = await adminApi.get<ListResponse<KnowledgeMemberResponse>>(`/knowledge-bases/members?${params}`);
  return {
    items: response.items.map((item) => ({
      userId: item.user_id,
      name: item.name,
      email: item.email,
      accountStatus: item.account_status,
      actions: item.actions,
      updatedAt: item.updated_at
    })),
    meta: { next_cursor: "", has_next: false }
  };
}

export async function listKnowledgeMemberCandidates(knowledgeBaseId: string, query = "") {
  const params = new URLSearchParams({ knowledge_base_id: knowledgeBaseId });
  if (query.trim()) params.set("query", query.trim());
  const response = await adminApi.get<ListResponse<KnowledgeMemberCandidateResponse>>(`/knowledge-bases/member-candidates?${params}`);
  return {
    items: response.items.map((item) => ({ userId: item.user_id, name: item.name, email: item.email })),
    meta: { next_cursor: "", has_next: false }
  };
}

export async function createKnowledgeAccountGrant(input: {
  userId: string;
  knowledgeBaseId: string;
  actions: DataResourceGrant["action"][];
}): Promise<DataResourceGrant[]> {
  const response = await adminApi.post<ListResponse<DataResourceGrantResponse>>(
    "/knowledge-bases/account-grants",
    knowledgeGrantInput(input)
  );
  return response.items.map(mapDataResourceGrant);
}

export async function replaceKnowledgeAccountGrant(input: {
  userId: string;
  knowledgeBaseId: string;
  actions: DataResourceGrant["action"][];
}): Promise<DataResourceGrant[]> {
  const response = await adminApi.patch<ListResponse<DataResourceGrantResponse>>(
    "/knowledge-bases/account-grants",
    knowledgeGrantInput(input)
  );
  return response.items.map(mapDataResourceGrant);
}

export function removeKnowledgeAccountGrant(userId: string, knowledgeBaseId: string) {
  return adminApi.post<void>("/knowledge-bases/account-grants/remove", {
    user_id: userId,
    knowledge_base_id: knowledgeBaseId
  });
}

function mapKnowledgeBase(item: KnowledgeBaseResponse): KnowledgeBase {
  return {
    knowledgeBaseId: item.knowledge_base_id,
    name: item.name,
    description: item.description,
    providerType: item.provider_type,
    status: item.status,
    errorMessage: item.error_message,
    documentCount: item.document_count,
    createdBy: item.created_by,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
}

function mapKnowledgeDocument(item: KnowledgeDocumentResponse): KnowledgeDocument {
  return {
    documentId: item.document_id,
    knowledgeBaseId: item.knowledge_base_id,
    name: item.name,
    sizeBytes: item.size_bytes,
    mimeType: item.mime_type,
    status: item.status,
    errorMessage: item.error_message,
    uploadedBy: item.uploaded_by,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
}

function mapDataResourceGrant(item: DataResourceGrantResponse): DataResourceGrant {
  return {
    grantId: item.grant_id,
    userId: item.user_id,
    resourceType: item.resource_type,
    resourceId: item.resource_id,
    action: item.action,
    createdBy: item.created_by,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
}

function knowledgeGrantInput(input: {
  userId: string;
  knowledgeBaseId: string;
  actions: DataResourceGrant["action"][];
}) {
  return {
    user_id: input.userId,
    knowledge_base_id: input.knowledgeBaseId,
    actions: input.actions
  };
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string | { message?: string } };
    return (typeof body.error === "string" ? body.error : body.error?.message)?.trim() || fallback;
  } catch {
    return fallback;
  }
}
