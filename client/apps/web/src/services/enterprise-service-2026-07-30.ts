import type {
  EnterpriseActivityCapabilityResponse,
  EnterpriseActivityDetailResponse,
  EnterpriseActivityRange,
  EnterpriseActivityStatisticsResponse,
  EnterpriseBillingOverviewResponse,
  EnterpriseBilibiliDashboardResponse,
  EnterpriseKnowledgeBaseListResponse,
  EnterpriseKnowledgeDocumentListResponse,
  EnterpriseKnowledgeDocumentUploadResponse,
  EnterpriseDingTalkLoginPrepareResponse,
  EnterpriseLoginRequest,
  EnterpriseMcpCatalogResponse,
  EnterpriseMcpPreferenceUpdateRequest,
  EnterpriseQrLoginStartRequest,
  EnterpriseQrLoginStartResponse,
  EnterpriseQrLoginStatusResponse,
  EnterpriseRegisterRequest,
  EnterpriseRechargeOrderPageResponse,
  EnterpriseRechargeSessionResponse,
  EnterpriseSessionResponse,
  EnterpriseSharedFileDetailResponse,
  EnterpriseSharedFileDownloadResponse,
  EnterpriseSharedFileListResponse,
  EnterpriseSharedFileMutationResponse,
  EnterpriseSharedSpaceListResponse,
  EnterpriseSkillDetailResponse,
  EnterpriseSkillListResponse,
  EnterpriseSkillMutationResponse
} from '@clawee/protocol';
import type { RuntimeClient } from '../runtime/client.js';

type ClientLike = Pick<RuntimeClient, 'get' | 'post' | 'postBinary' | 'patch'>;

const KNOWLEDGE_DOCUMENT_CONTENT_TYPE =
  'application/vnd.clawee.knowledge-document';
const SHARED_FILE_CONTENT_TYPE =
  'application/vnd.clawee.shared-file';

export function createEnterpriseService(client: ClientLike) {
  return {
    getGateway(): Promise<{ gateway: string; configurable: boolean }> {
      return client.get('/enterprise/gateway');
    },
    setGateway(gateway: string): Promise<{ gateway: string; configurable: boolean }> {
      return client.post('/enterprise/gateway', { gateway });
    },
    getSession(): Promise<EnterpriseSessionResponse> {
      return client.get('/enterprise/session');
    },
    refreshSession(): Promise<EnterpriseSessionResponse> {
      return client.post('/enterprise/session/refresh');
    },
    prepareDingTalkLogin(): Promise<EnterpriseDingTalkLoginPrepareResponse> {
      return client.post('/enterprise/dingtalk/login/prepare');
    },
    login(input: EnterpriseLoginRequest): Promise<EnterpriseSessionResponse> {
      return client.post('/enterprise/login', input);
    },
    register(input: EnterpriseRegisterRequest): Promise<EnterpriseSessionResponse> {
      return client.post('/enterprise/register', input);
    },
    startQrLogin(
      input: EnterpriseQrLoginStartRequest
    ): Promise<EnterpriseQrLoginStartResponse> {
      return client.post('/enterprise/qr-login', input);
    },
    getQrLoginStatus(requestId: string): Promise<EnterpriseQrLoginStatusResponse> {
      return client.get(`/enterprise/qr-login/${encodeURIComponent(requestId)}`);
    },
    logout(): Promise<EnterpriseSessionResponse> {
      return client.post('/enterprise/logout');
    },
    getActivityCapability(): Promise<EnterpriseActivityCapabilityResponse> {
      return client.get('/enterprise/activity/capability');
    },
    getActivityStatistics(
      range: EnterpriseActivityRange
    ): Promise<EnterpriseActivityStatisticsResponse> {
      const query = new URLSearchParams({ range });
      return client.get(
        `/enterprise/activity/statistics?${query.toString()}`
      );
    },
    getActivityDetail(input: {
      range: EnterpriseActivityRange;
      collectorId: string;
      agentId: string;
    }): Promise<EnterpriseActivityDetailResponse> {
      const query = new URLSearchParams({
        range: input.range,
        collectorId: input.collectorId,
        agentId: input.agentId
      });
      return client.get(`/enterprise/activity/detail?${query.toString()}`);
    },
    getBillingOverview(
      range: EnterpriseActivityRange
    ): Promise<EnterpriseBillingOverviewResponse> {
      const query = new URLSearchParams({ range });
      return client.get(`/enterprise/billing/overview?${query.toString()}`);
    },
    getBilibiliDashboard(): Promise<EnterpriseBilibiliDashboardResponse> {
      return client.get(
        '/enterprise/business-dashboards/bilibili-operation'
      );
    },
    createRechargeSession(): Promise<EnterpriseRechargeSessionResponse> {
      return client.post('/enterprise/billing/recharge-session');
    },
    listRechargeOrders(
      page: number
    ): Promise<EnterpriseRechargeOrderPageResponse> {
      const query = new URLSearchParams({ page: String(page) });
      return client.get(
        `/enterprise/billing/recharge-orders?${query.toString()}`
      );
    },
    listMcpConnections(): Promise<EnterpriseMcpCatalogResponse> {
      return client.get('/enterprise/mcp');
    },
    refreshMcpConnections(): Promise<EnterpriseMcpCatalogResponse> {
      return client.post('/enterprise/mcp/refresh');
    },
    updateMcpPreference(
      upstreamId: string,
      input: EnterpriseMcpPreferenceUpdateRequest
    ): Promise<EnterpriseMcpCatalogResponse> {
      return client.patch(
        `/enterprise/mcp/upstreams/${encodeURIComponent(upstreamId)}/preference`,
        input
      );
    },
    listKnowledgeBases(): Promise<EnterpriseKnowledgeBaseListResponse> {
      return client.get('/enterprise/knowledge-bases');
    },
    listKnowledgeDocuments(
      knowledgeBaseId: string
    ): Promise<EnterpriseKnowledgeDocumentListResponse> {
      return client.get(
        `/enterprise/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`
      );
    },
    uploadKnowledgeDocument(input: {
      knowledgeBaseId: string;
      file: File;
    }): Promise<EnterpriseKnowledgeDocumentUploadResponse> {
      const query = new URLSearchParams({
        fileName: input.file.name,
        mimeType: input.file.type || 'application/octet-stream',
        sizeBytes: String(input.file.size)
      });
      return client.postBinary(
        `/enterprise/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/documents?${query.toString()}`,
        input.file,
        KNOWLEDGE_DOCUMENT_CONTENT_TYPE
      );
    },
    listSharedSpaces(input: {
      limit?: number;
      cursor?: string;
    } = {}): Promise<EnterpriseSharedSpaceListResponse> {
      const query = buildQuery({
        limit: input.limit,
        cursor: input.cursor
      });
      return client.get(`/enterprise/shared-spaces${query}`);
    },
    listSharedFiles(input: {
      spaceId?: string;
      query?: string;
      logicalPathPrefix?: string;
      limit?: number;
      cursor?: string;
    } = {}): Promise<EnterpriseSharedFileListResponse> {
      const query = buildQuery({
        spaceId: input.spaceId,
        query: input.query,
        logicalPathPrefix: input.logicalPathPrefix,
        limit: input.limit,
        cursor: input.cursor
      });
      return client.get(`/enterprise/shared-files${query}`);
    },
    getSharedFileDetail(
      fileId: string
    ): Promise<EnterpriseSharedFileDetailResponse> {
      return client.get(
        `/enterprise/shared-files/${encodeURIComponent(fileId)}`
      );
    },
    uploadSharedFile(input: {
      spaceId: string;
      logicalPath: string;
      expectedRevision?: number;
      file: File;
    }): Promise<EnterpriseSharedFileMutationResponse> {
      const query = new URLSearchParams({
        logicalPath: input.logicalPath,
        contentType: input.file.type || 'application/octet-stream',
        sizeBytes: String(input.file.size)
      });
      if (input.expectedRevision !== undefined) {
        query.set('expectedRevision', String(input.expectedRevision));
      }
      return client.postBinary(
        `/enterprise/shared-spaces/${encodeURIComponent(input.spaceId)}/files?${query.toString()}`,
        input.file,
        SHARED_FILE_CONTENT_TYPE
      );
    },
    downloadSharedFile(input: {
      fileId: string;
      projectId: string;
      overwrite?: boolean;
    }): Promise<EnterpriseSharedFileDownloadResponse> {
      return client.post(
        `/enterprise/shared-files/${encodeURIComponent(input.fileId)}/download`,
        {
          projectId: input.projectId,
          ...(input.overwrite === true ? { overwrite: true } : {})
        }
      );
    },
    listSkills(): Promise<EnterpriseSkillListResponse> {
      return client.get('/enterprise/skills');
    },
    getSkillDetail(skillId: string): Promise<EnterpriseSkillDetailResponse> {
      return client.get(`/enterprise/skills/${encodeURIComponent(skillId)}`);
    },
    installSkill(skillId: string): Promise<EnterpriseSkillMutationResponse> {
      return client.post(
        `/enterprise/skills/${encodeURIComponent(skillId)}/install`
      );
    },
    updateSkill(skillId: string): Promise<EnterpriseSkillMutationResponse> {
      return client.post(
        `/enterprise/skills/${encodeURIComponent(skillId)}/update`
      );
    }
  };
}

function buildQuery(
  input: Record<string, string | number | undefined>
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded.length === 0 ? '' : `?${encoded}`;
}
