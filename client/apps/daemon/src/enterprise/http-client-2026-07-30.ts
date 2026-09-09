import type {
  EnterpriseAccountSummary,
  EnterpriseActivityDetailResponse,
  EnterpriseActivityRange,
  EnterpriseActivityStatisticsResponse,
  EnterpriseBilibiliDashboardResponse,
  EnterpriseBillingOverviewResponse,
  EnterpriseListMeta,
  EnterpriseLoginRequest,
  EnterpriseQrLoginStartRequest,
  EnterpriseQrLoginStartResponse,
  EnterpriseQrProvider,
  EnterpriseRechargeOrderPageResponse,
  EnterpriseRechargeSessionResponse,
  EnterpriseRegisterRequest,
  RuntimeErrorCode
} from '@clawee/protocol';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  ENTERPRISE_DOCUMENT_UPLOAD_TIMEOUT_MS,
  ENTERPRISE_DOWNLOAD_TIMEOUT_MS,
  ENTERPRISE_JSON_TIMEOUT_MS,
  ENTERPRISE_PACKAGE_MAX_BYTES,
  ENTERPRISE_SHARED_FILE_MAX_BYTES,
  ENTERPRISE_SHARED_FILE_TRANSFER_TIMEOUT_MS,
  resolveEnterpriseOrigin
} from './config-2026-07-30.js';
import type {
  EnterpriseActivityEventsRequest
} from './activity-event-projector-2026-08-28.js';

const accountSchema = z.object({
  account_id: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  email: z.string().min(1),
  name: z.string(),
  status: z.string()
}).superRefine((account, context) => {
  if (account.account_id === undefined && account.user_id === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A stable account identifier is required'
    });
  }
  if (
    account.account_id !== undefined
    && account.user_id !== undefined
    && account.account_id !== account.user_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Account identifiers do not match'
    });
  }
});
const agentSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string()
});
const loginResponseSchema = z.object({
  data: z.object({
    account: accountSchema,
    agent: agentSchema,
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_at: z.string().datetime({ offset: true })
  })
});
const modelConfigurationSchema = z.object({
  data: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('platform_managed'),
      base_url: z.string().url(),
      model: z.string().min(1),
      default_model: z.string().min(1).optional(),
      api_key: z.string().min(1),
      credential_version: z.number().int().positive()
    }),
    z.object({
      mode: z.literal('enterprise_managed')
    })
  ])
});
const platformBrandingSchema = z.object({
  data: z.object({
    sidebar_logo_configured: z.boolean(),
    sidebar_compact_logo_configured: z.boolean()
  }).strict()
}).strict();
const authMethodsResponseSchema = z.object({
  data: z.object({
    password: z.boolean(),
    dingtalk: z.object({
      enabled: z.boolean()
    })
  })
});
const qrProviderSchema = z.enum(['feishu', 'dingtalk', 'wecom']);
const qrLoginStartResponseSchema = z.object({
  data: z.object({
    request_id: z.string().min(1),
    provider: qrProviderSchema,
    qr_code_url: z.string().min(1),
    expires_at: z.string().datetime({ offset: true }),
    poll_after_ms: z.number().int().min(250).max(10_000)
  })
});
const qrLoginPendingDataSchema = z.object({
  request_id: z.string().min(1),
  provider: qrProviderSchema,
  status: z.enum(['pending', 'scanned', 'expired', 'denied']),
  poll_after_ms: z.number().int().min(250).max(10_000).optional()
});
const qrLoginSignedInDataSchema = z.object({
  request_id: z.string().min(1),
  provider: qrProviderSchema,
  status: z.literal('signed_in'),
  account: accountSchema,
  agent: agentSchema,
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_at: z.string().datetime({ offset: true })
});
const qrLoginStatusResponseSchema = z.object({
  data: z.union([qrLoginPendingDataSchema, qrLoginSignedInDataSchema])
});
const bilibiliDashboardResponseSchema = z.object({
  data: z.object({
    status: z.enum(['unconfigured', 'available', 'partial', 'unavailable']),
    data: z.object({
      captured_at: z.string().datetime({ offset: true }),
      follower_count: z.number().int().nonnegative(),
      collected_content_count: z.number().int().nonnegative(),
      view_count: z.number().int().nonnegative(),
      interaction_count: z.number().int().nonnegative(),
      top_contents: z.array(z.object({
        external_content_id: z.string().min(1),
        title: z.string(),
        captured_at: z.string().datetime({ offset: true }),
        view_count: z.number().int().nonnegative(),
        interaction_count: z.number().int().nonnegative()
      }))
    }).optional()
  })
});
const bilibiliSourcesResponseSchema = z.object({
  data: z.object({
    items: z.array(z.object({
      source_id: z.string().min(1),
      status: z.enum(['active', 'disabled'])
    }))
  })
});
const meResponseSchema = z.object({
  data: z.object({
    account: accountSchema,
    agent: agentSchema,
    applications: z.object({
      frontend: z.boolean()
    }),
    agent_activity_reporting_enabled: z.boolean().optional().default(false)
  })
});
const accountMcpTokenResponseSchema = z.object({
  data: z.object({
    token: z.string().min(1),
    authorization_header: z.string().min(1),
    token_info: z.object({
      user_id: z.string().min(1),
      token_id: z.string().min(1),
      token_fingerprint: z.string().min(1),
      token_status: z.literal('active'),
      token_expires_at: z.string().datetime({ offset: true }).nullable(),
      token_scopes: z.array(z.string().min(1)),
      created_at: z.string().datetime({ offset: true })
    })
  })
});
const remoteMcpToolSchema = z.object({
  id: z.string().min(1),
  upstream_name: z.string().min(1),
  name: z.string().min(1),
  exposed_name: z.string().min(1),
  title: z.string(),
  description: z.string(),
  risk_level: z.string(),
  confirm_required: z.boolean(),
  status: z.string().min(1),
  authorized: z.boolean(),
  authorization_expires_at: z.string().datetime({ offset: true }).nullable()
});
const remoteMcpUpstreamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  domain: z.string(),
  mcp_endpoint: z.string().url(),
  upstream_transport: z.string().min(1),
  namespace: z.string().min(1),
  status: z.string().min(1),
  tools: z.array(remoteMcpToolSchema)
});
const mcpCatalogResponseSchema = z.object({
  data: z.object({
    upstreams: z.array(remoteMcpUpstreamSchema)
  })
});
const remoteSkillSchema = z.object({
  skill_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  version_id: z.string().min(1),
  version: z.string(),
  package_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  updated_at: z.string().datetime({ offset: true })
});
const skillListResponseSchema = z.object({
  data: z.array(remoteSkillSchema)
});
const skillDetailResponseSchema = z.object({
  data: remoteSkillSchema.extend({
    changelog: z.string().optional()
  })
});
const listMetaSchema = z.object({
  next_cursor: z.string(),
  has_next: z.boolean()
});
const knowledgePermissionsSchema = z.object({
  read: z.boolean(),
  upload: z.boolean(),
  search: z.boolean().optional()
});
const remoteKnowledgeBaseSchema = z.object({
  knowledge_base_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  status: z.string(),
  document_count: z.number().int().nonnegative(),
  permissions: knowledgePermissionsSchema
});
const knowledgeBaseListResponseSchema = z.object({
  data: z.array(remoteKnowledgeBaseSchema),
  meta: listMetaSchema
});
const remoteKnowledgeDocumentSchema = z.object({
  document_id: z.string().min(1),
  knowledge_base_id: z.string().min(1),
  name: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  mime_type: z.string(),
  status: z.string(),
  error_message: z.string(),
  uploaded_by: z.string(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true })
});
const knowledgeDocumentListResponseSchema = z.object({
  data: z.array(remoteKnowledgeDocumentSchema),
  meta: listMetaSchema
});
const knowledgeDocumentUploadResponseSchema = z.object({
  data: remoteKnowledgeDocumentSchema
});
const sharedSpacePermissionsSchema = z.object({
  read: z.boolean().optional(),
  write: z.boolean().optional()
});
const remoteSharedSpaceSchema = z.object({
  space_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  updated_at: z.string().datetime({ offset: true }),
  permissions: sharedSpacePermissionsSchema.optional()
});
const sharedSpaceListResponseSchema = z.object({
  data: z.array(remoteSharedSpaceSchema),
  meta: listMetaSchema.extend({
    max_file_size_bytes: z.number().int().nonnegative()
  })
});
const remoteSharedFileSchema = z.object({
  file_id: z.string().min(1),
  space_id: z.string().min(1),
  space_name: z.string(),
  logical_path: z.string().min(1),
  file_name: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  content_type: z.string(),
  revision: z.number().int().positive(),
  updated_by_user_id: z.string(),
  updated_by_agent_id: z.string(),
  updated_at: z.string().datetime({ offset: true })
});
const sharedFileListResponseSchema = z.object({
  data: z.array(remoteSharedFileSchema),
  meta: listMetaSchema
});
const sharedFileDetailResponseSchema = z.object({
  data: remoteSharedFileSchema.extend({
    created_by_user_id: z.string(),
    created_by_agent_id: z.string(),
    created_at: z.string().datetime({ offset: true })
  })
});
const sharedFileMutationResponseSchema = z.object({
  data: z.object({
    file_id: z.string().min(1),
    space_id: z.string().min(1),
    logical_path: z.string().min(1),
    file_name: z.string().min(1),
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    content_type: z.string(),
    revision: z.number().int().positive(),
    created: z.boolean(),
    updated_at: z.string().datetime({ offset: true })
  })
});
const activityDataViewsResponseSchema = z.object({
  data: z.array(z.object({
    view_id: z.string().min(1),
    actions: z.array(z.string().min(1))
  }))
});
const activityTokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative()
});
const activityUsageDistributionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  invocation_count: z.number().int().nonnegative(),
  share: z.number().min(0).max(1)
});
const activityStatisticsResponseSchema = z.object({
  data: z.object({
    range: z.enum(['today', '7d', '30d']),
    timezone: z.string().min(1),
    start_date: z.string().min(1),
    end_date: z.string().min(1),
    generated_at: z.string().min(1),
    organization: z.object({
      usage: activityTokenUsageSchema,
      active_employees: z.number().int().nonnegative(),
      active_agents: z.number().int().nonnegative(),
      completed_turns: z.number().int().nonnegative(),
      mcp_distribution: z.array(activityUsageDistributionSchema)
    }),
    trend: z.object({
      granularity: z.enum(['hour', 'day']),
      points: z.array(activityTokenUsageSchema.extend({
        bucket_start: z.string().min(1)
      }))
    }),
    model_distribution: z.array(z.object({
      model: z.string().min(1),
      requests: z.number().int().nonnegative(),
      input_tokens: z.number().int().nonnegative(),
      cached_input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
      share: z.number().min(0).max(1)
    })),
    token_usage_ranking: z.array(z.object({
      rank: z.number().int().positive(),
      name: z.string().min(1),
      requests: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative()
    })).optional(),
    agents: z.array(z.object({
      collector_id: z.string().min(1),
      agent_id: z.string().min(1),
      name: z.string().min(1),
      status: z.string().min(1),
      session_count: z.number().int().nonnegative(),
      turn_count: z.number().int().nonnegative(),
      last_activity_at: z.string().min(1).optional()
    })),
    data_status: z.union([
      z.object({
        model_usage: z.string().min(1),
        activity: z.string().min(1)
      }),
      z.object({
        sub2api: z.string().min(1),
        activity: z.string().min(1)
      })
    ])
  })
});
const billingOverviewResponseSchema = z.object({
  data: z.object({
    currency: z.literal('CNY'),
    balance_cny: z.number().finite().nonnegative(),
    generated_at: z.string().datetime({ offset: true })
  })
});
const rechargeSessionResponseSchema = z.object({
  data: z.object({
    recharge_url: z.string().url(),
    expires_at: z.string().datetime({ offset: true })
  })
});
const rechargeOrderStatusSchema = z.enum([
  'pending_payment',
  'crediting',
  'succeeded',
  'credit_failed',
  'cancelled',
  'refunding',
  'refunded',
  'refund_failed'
]);
const rechargeOrderSchema = z.object({
  order_no: z.string().trim().min(1),
  amount_cents: z.number().int().safe().positive(),
  currency: z.literal('CNY'),
  channel: z.enum(['alipay', 'manual']),
  status: rechargeOrderStatusSchema,
  payment_status: z.enum(['pending', 'paid', 'cancelled', 'refunded']),
  fulfillment_status: z.enum([
    'pending',
    'processing',
    'succeeded',
    'failed',
    'refunding',
    'refunded',
    'refund_failed'
  ]),
  created_at: z.string().datetime({ offset: true }),
  paid_at: z.string().datetime({ offset: true }).nullable(),
  fulfilled_at: z.string().datetime({ offset: true }).nullable()
});
const rechargeOrderPageResponseSchema = z.object({
  data: z.object({
    items: z.array(rechargeOrderSchema),
    page: z.number().int().safe().positive(),
    page_size: z.literal(20),
    total: z.number().int().safe().nonnegative()
  })
});
const nullableStringSchema = z.string().nullable().optional();
const activitySessionSchema = z.object({
  session_id: nullableStringSchema,
  id: nullableStringSchema,
  title: nullableStringSchema,
  status: nullableStringSchema,
  summary: nullableStringSchema,
  workspace_name: nullableStringSchema,
  started_at: nullableStringSchema,
  ended_at: nullableStringSchema,
  duration_ms: z.number().int().nonnegative().nullable().optional()
});
const activityTurnSchema = z.object({
  turn_id: nullableStringSchema,
  id: nullableStringSchema,
  session_id: nullableStringSchema,
  title: nullableStringSchema,
  status: nullableStringSchema,
  prompt_summary: nullableStringSchema,
  user_prompt: nullableStringSchema,
  assistant_summary: nullableStringSchema,
  last_assistant_message: nullableStringSchema,
  model: nullableStringSchema,
  started_at: nullableStringSchema,
  completed_at: nullableStringSchema
});
const activitySubAgentSchema = z.object({
  sub_agent_id: nullableStringSchema,
  agent_id: nullableStringSchema,
  id: nullableStringSchema,
  name: nullableStringSchema,
  display_name: nullableStringSchema,
  status: nullableStringSchema,
  completed_turns: z.number().int().nonnegative().nullable().optional(),
  started_at: nullableStringSchema,
  completed_at: nullableStringSchema
});
const activityToolCallSchema = z.object({
  tool_call_id: nullableStringSchema,
  external_tool_call_id: nullableStringSchema,
  id: nullableStringSchema,
  name: nullableStringSchema,
  tool_name: nullableStringSchema,
  type: nullableStringSchema,
  tool_type: nullableStringSchema,
  status: nullableStringSchema,
  occurred_at: nullableStringSchema,
  timestamp: nullableStringSchema,
  started_at: nullableStringSchema,
  completed_at: nullableStringSchema,
  duration_ms: z.number().int().nonnegative().nullable().optional()
});
const activityStatusTimelineSchema = z.object({
  status: nullableStringSchema,
  occurred_at: nullableStringSchema,
  timestamp: nullableStringSchema,
  started_at: nullableStringSchema,
  completed_at: nullableStringSchema,
  message: nullableStringSchema
});
const activityRecentItemSchema = z.object({
  activity_id: nullableStringSchema,
  id: nullableStringSchema,
  type: nullableStringSchema,
  activity_type: nullableStringSchema,
  title: nullableStringSchema,
  status: nullableStringSchema,
  occurred_at: nullableStringSchema,
  timestamp: nullableStringSchema,
  started_at: nullableStringSchema,
  completed_at: nullableStringSchema
});
const activityDetailPayloadSchema = z.object({
  schema_version: z.literal('office.v1'),
  server_time: z.string().min(1),
  agent: z.object({
    collector_id: z.string().min(1),
    agent_id: z.string().min(1),
    display_name: z.string().min(1),
    agent_type: z.string().min(1),
    workspace_name: z.string(),
    status: z.string().min(1),
    sub_agents: z.object({
      active_count: z.number().int().nonnegative(),
      total_count: z.number().int().nonnegative()
    }),
    recent_tool_calls: z.number().int().nonnegative(),
    last_seen_at: nullableStringSchema,
    updated_at: nullableStringSchema
  }),
  sessions: z.array(activitySessionSchema),
  turns: z.array(activityTurnSchema),
  sub_agents: z.array(activitySubAgentSchema),
  tool_calls: z.array(activityToolCallSchema),
  status_timeline: z.array(activityStatusTimelineSchema),
  recent_activities: z.array(activityRecentItemSchema),
  stats: z.object({
    session_duration_ms: z.number().int().nonnegative(),
    active_sub_agents: z.number().int().nonnegative(),
    total_sub_agents: z.number().int().nonnegative(),
    recent_activity_count: z.number().int().nonnegative(),
    business_risk_level: z.string().min(1),
    active_sessions: z.number().int().nonnegative(),
    active_work_ms: z.number().int().nonnegative(),
    tool_type_variety: z.number().int().nonnegative(),
    tool_call_count: z.number().int().nonnegative()
  })
});
const activityDetailResponseSchema = z.union([
  activityDetailPayloadSchema,
  z.object({ data: activityDetailPayloadSchema })
]);
export type EnterpriseRemoteSkill = {
  skillId: string;
  name: string;
  description?: string;
  versionId: string;
  version: string;
  packageSha256: string;
  updatedAt: string;
};

export type EnterpriseAccountMcpToken = {
  userId: string;
  tokenId: string;
  token: string;
  fingerprint: string;
  expiresAt: string | null;
  scopes: string[];
  createdAt: string;
};

export type EnterpriseRemoteMcpTool = {
  toolId: string;
  upstreamName: string;
  name: string;
  exposedName: string;
  title: string;
  description: string;
  riskLevel: string;
  confirmRequired: boolean;
  status: string;
  authorized: boolean;
  authorizationExpiresAt: string | null;
};

export type EnterpriseRemoteMcpUpstream = {
  upstreamId: string;
  name: string;
  domain: string;
  endpoint: string;
  upstreamTransport: string;
  namespace: string;
  status: string;
  tools: EnterpriseRemoteMcpTool[];
};

export type EnterpriseRemoteMcpCatalog = {
  upstreams: EnterpriseRemoteMcpUpstream[];
};

export type EnterpriseRemoteSkillDetail = EnterpriseRemoteSkill & {
  changelog?: string;
};

export type EnterpriseRemoteKnowledgeBase = {
  knowledgeBaseId: string;
  name: string;
  description: string;
  status: string;
  documentCount: number;
  permissions: {
    read: boolean;
    upload: boolean;
    search: boolean;
  };
};

export type EnterpriseRemoteKnowledgeDocument = {
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

export type EnterpriseRemoteSharedSpace = {
  spaceId: string;
  name: string;
  description: string;
  updatedAt: string;
  permissions: {
    read: boolean;
    write: boolean;
  };
};

export type EnterpriseRemoteSharedFile = {
  fileId: string;
  spaceId: string;
  spaceName: string;
  logicalPath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  revision: number;
  createdByUserId?: string;
  createdByAgentId?: string;
  updatedByUserId: string;
  updatedByAgentId: string;
  createdAt?: string;
  updatedAt: string;
};

export type EnterpriseRemoteSharedFileMutation = {
  fileId: string;
  spaceId: string;
  logicalPath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  revision: number;
  created: boolean;
  updatedAt: string;
};

export type EnterpriseLoginResult = {
  account: EnterpriseAccountSummary;
  agentId: string;
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
};

export type EnterpriseModelConfiguration =
  | {
      mode: 'platform_managed';
      baseUrl: string;
      model: string;
      defaultModel?: string;
      apiKey: string;
      credentialVersion: number;
    }
  | { mode: 'enterprise_managed' };

export type EnterprisePlatformBranding = {
  sidebarLogoConfigured: boolean;
  sidebarCompactLogoConfigured: boolean;
};

export type EnterprisePlatformBrandingImage = {
  content: Uint8Array;
  contentType: 'image/png' | 'image/jpeg';
};

export type EnterpriseDingTalkAuthorizationInput = {
  agentId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

export type EnterpriseDingTalkTokenInput = {
  agentId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
};

export type EnterpriseQrLoginPollResult = {
  requestId: string;
  provider: EnterpriseQrProvider;
  status: 'pending' | 'scanned' | 'expired' | 'denied';
  pollAfterMs?: number;
} | {
  requestId: string;
  provider: EnterpriseQrProvider;
  status: 'signed_in';
  login: EnterpriseLoginResult;
};

export type EnterpriseMeResult = {
  account: EnterpriseAccountSummary;
  agentId: string;
  status: string;
  frontendAllowed: boolean;
  activityReportingEnabled?: boolean;
};

export type EnterpriseDownloadInput = {
  accessToken: string;
  skillId: string;
  versionId: string;
  expectedSha256: string;
  destinationPath: string;
};

export type EnterpriseSharedFileListInput = {
  accessToken: string;
  spaceId?: string;
  query?: string;
  logicalPathPrefix?: string;
  limit?: number;
  cursor?: string;
};

export type EnterpriseSharedFileDownloadInput = {
  accessToken: string;
  fileId: string;
  destinationPath: string;
};

export type EnterpriseSharedFileUploadInput = {
  accessToken: string;
  spaceId: string;
  logicalPath: string;
  expectedRevision?: number;
  filePath: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
};

export type EnterpriseHttpClient = {
  register(input: EnterpriseRegisterRequest, agentId: string): Promise<void>;
  login(input: EnterpriseLoginRequest, agentId: string): Promise<EnterpriseLoginResult>;
  prepareDingTalkAuthorization?(
    input: EnterpriseDingTalkAuthorizationInput
  ): Promise<string>;
  exchangeDingTalkAuthorizationCode?(
    input: EnterpriseDingTalkTokenInput
  ): Promise<EnterpriseLoginResult>;
  startQrLogin?(
    input: EnterpriseQrLoginStartRequest,
    agentId: string
  ): Promise<EnterpriseQrLoginStartResponse>;
  pollQrLogin?(
    requestId: string,
    agentId: string
  ): Promise<EnterpriseQrLoginPollResult>;
  getMe(accessToken: string): Promise<EnterpriseMeResult>;
  logout(accessToken: string): Promise<void>;
  reportAgentActivity?(
    accessToken: string,
    request: EnterpriseActivityEventsRequest
  ): Promise<void>;
  getModelConfiguration?(
    accessToken: string
  ): Promise<EnterpriseModelConfiguration>;
  getPlatformBranding?(
    accessToken: string
  ): Promise<EnterprisePlatformBranding>;
  getPlatformBrandingImage?(
    accessToken: string,
    kind: 'sidebar-logo' | 'sidebar-compact-logo'
  ): Promise<EnterprisePlatformBrandingImage>;
  revealAccountMcpToken(accessToken: string): Promise<EnterpriseAccountMcpToken>;
  getMcpCatalog(accessToken: string): Promise<EnterpriseRemoteMcpCatalog>;
  listKnowledgeBases(accessToken: string): Promise<{
    knowledgeBases: EnterpriseRemoteKnowledgeBase[];
    meta: EnterpriseListMeta;
  }>;
  listKnowledgeDocuments(
    accessToken: string,
    knowledgeBaseId: string
  ): Promise<{
    documents: EnterpriseRemoteKnowledgeDocument[];
    meta: EnterpriseListMeta;
  }>;
  uploadKnowledgeDocument(input: {
    accessToken: string;
    knowledgeBaseId: string;
    filePath: string;
    fileName: string;
    mimeType: string;
  }): Promise<EnterpriseRemoteKnowledgeDocument>;
  listSharedSpaces(
    accessToken: string,
    input?: { limit?: number; cursor?: string }
  ): Promise<{
    spaces: EnterpriseRemoteSharedSpace[];
    meta: EnterpriseListMeta & { maxFileSizeBytes: number };
  }>;
  listSharedFiles(input: EnterpriseSharedFileListInput): Promise<{
    files: EnterpriseRemoteSharedFile[];
    meta: EnterpriseListMeta;
  }>;
  getSharedFileDetail(
    accessToken: string,
    fileId: string
  ): Promise<EnterpriseRemoteSharedFile>;
  downloadSharedFileContent(
    input: EnterpriseSharedFileDownloadInput
  ): Promise<{
    bytes: number;
    sha256: string;
    revision: number;
    contentType: string;
  }>;
  uploadSharedFileContent(
    input: EnterpriseSharedFileUploadInput
  ): Promise<EnterpriseRemoteSharedFileMutation>;
  hasAgentActivityGrant?(accessToken: string): Promise<boolean>;
  getActivityStatistics?(
    accessToken: string,
    range: EnterpriseActivityRange
  ): Promise<EnterpriseActivityStatisticsResponse>;
  getActivityDetail?(
    accessToken: string,
    collectorId: string,
    agentId: string
  ): Promise<EnterpriseActivityDetailResponse>;
  getBillingOverview?(
    accessToken: string,
    range: EnterpriseActivityRange
  ): Promise<EnterpriseBillingOverviewResponse>;
  getBilibiliDashboard?(
    accessToken: string
  ): Promise<EnterpriseBilibiliDashboardResponse>;
  createRechargeSession?(
    accessToken: string
  ): Promise<EnterpriseRechargeSessionResponse>;
  listRechargeOrders?(
    accessToken: string,
    page: number
  ): Promise<EnterpriseRechargeOrderPageResponse>;
  listSkills(accessToken: string): Promise<EnterpriseRemoteSkill[]>;
  getSkillDetail(
    accessToken: string,
    skillId: string
  ): Promise<EnterpriseRemoteSkillDetail>;
  downloadSkillPackage(
    input: EnterpriseDownloadInput
  ): Promise<{ bytes: number; sha256: string }>;
};

export type EnterpriseDingTalkHttpClient = EnterpriseHttpClient & Required<Pick<
  EnterpriseHttpClient,
  'prepareDingTalkAuthorization' | 'exchangeDingTalkAuthorizationCode'
  | 'hasAgentActivityGrant'
  | 'getActivityStatistics'
  | 'getActivityDetail' | 'getModelConfiguration'
>>;

export class EnterpriseHttpError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    readonly stage: 'request' | 'response' | 'decode' | 'download' | 'upload',
    readonly statusCode?: number,
    readonly upstreamCode?: string,
    readonly retryAfterMs?: number,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(`${code}: enterprise HTTP ${stage} failed`);
    this.name = 'EnterpriseHttpError';
  }
}

export function createEnterpriseHttpClient(input: {
  origin?: string;
  fetch?: typeof globalThis.fetch;
  jsonTimeoutMs?: number;
  retryDelayMs?: number;
  downloadTimeoutMs?: number;
  documentUploadTimeoutMs?: number;
  maxPackageBytes?: number;
  sharedFileTransferTimeoutMs?: number;
  maxSharedFileBytes?: number;
} = {}): EnterpriseDingTalkHttpClient {
  const { origin } = resolveEnterpriseOrigin(input.origin);
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const jsonTimeoutMs = input.jsonTimeoutMs ?? ENTERPRISE_JSON_TIMEOUT_MS;
  const retryDelayMs = input.retryDelayMs ?? 250;
  const downloadTimeoutMs =
    input.downloadTimeoutMs ?? ENTERPRISE_DOWNLOAD_TIMEOUT_MS;
  const documentUploadTimeoutMs =
    input.documentUploadTimeoutMs ?? ENTERPRISE_DOCUMENT_UPLOAD_TIMEOUT_MS;
  const maxPackageBytes =
    input.maxPackageBytes ?? ENTERPRISE_PACKAGE_MAX_BYTES;
  const sharedFileTransferTimeoutMs =
    input.sharedFileTransferTimeoutMs
    ?? ENTERPRISE_SHARED_FILE_TRANSFER_TIMEOUT_MS;
  const maxSharedFileBytes =
    input.maxSharedFileBytes ?? ENTERPRISE_SHARED_FILE_MAX_BYTES;

  async function requestJson<T>(request: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    accessToken?: string;
    schema: z.ZodType<T>;
    domain?: EnterpriseHttpDomain;
    retryTransportFailure?: boolean;
    emptyBody?: boolean;
  }): Promise<T> {
    let response!: Response;
    const maxAttempts = request.retryTransportFailure === true ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        response = await fetchImpl(new URL(request.path, origin), {
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          headers: {
            ...jsonHeaders(request.accessToken, request.body !== undefined),
            ...(request.emptyBody === true ? { 'Content-Length': '0' } : {})
          },
          method: request.method,
          signal: AbortSignal.timeout(jsonTimeoutMs)
        });
        break;
      } catch {
        if (attempt + 1 < maxAttempts) {
          await waitForRetry(retryDelayMs);
          continue;
        }
        throw new EnterpriseHttpError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'request'
        );
      }
    }

    if (!response.ok) {
      throw await createResponseError(response, request.domain);
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new EnterpriseHttpError(
        'ENTERPRISE_PROTOCOL_ERROR',
        'decode',
        response.status
      );
    }

    const parsed = request.schema.safeParse(value);
    if (!parsed.success) {
      throw new EnterpriseHttpError(
        'ENTERPRISE_PROTOCOL_ERROR',
        'decode',
        response.status
      );
    }
    return parsed.data;
  }

  async function requestWithoutResult(request: {
    method: 'POST';
    path: string;
    body?: unknown;
    accessToken?: string;
    domain?: EnterpriseHttpDomain;
    timeoutMs?: number;
  }): Promise<void> {
    let response: Response;
    try {
      response = await fetchImpl(new URL(request.path, origin), {
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        headers: jsonHeaders(request.accessToken, request.body !== undefined),
        method: request.method,
        signal: AbortSignal.timeout(request.timeoutMs ?? jsonTimeoutMs)
      });
    } catch {
      throw new EnterpriseHttpError(
        'ENTERPRISE_SERVICE_UNAVAILABLE',
        'request'
      );
    }

    if (!response.ok) {
      throw await createResponseError(response, request.domain);
    }
  }

  async function requestPlatformBrandingImage(
    accessToken: string,
    kind: 'sidebar-logo' | 'sidebar-compact-logo'
  ): Promise<EnterprisePlatformBrandingImage> {
    let response: Response;
    try {
      response = await fetchImpl(
        new URL(`/api/v1/app/platform-branding/${kind}`, origin),
        {
          headers: jsonHeaders(accessToken, false),
          method: 'GET',
          signal: AbortSignal.timeout(jsonTimeoutMs)
        }
      );
    } catch {
      throw new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'request');
    }
    if (!response.ok) throw await createResponseError(response);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0];
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
      throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode', response.status);
    }
    const declaredSize = parseContentLength(response.headers.get('content-length'));
    if (declaredSize !== undefined && (declaredSize === 0 || declaredSize > 1024 * 1024)) {
      throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode', response.status);
    }
    const content = new Uint8Array(await response.arrayBuffer());
    if (content.byteLength === 0 || content.byteLength > 1024 * 1024) {
      throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode', response.status);
    }
    return { content, contentType };
  }

  return {
    async register(request, agentId) {
      await requestWithoutResult({
        body: {
          email: request.email,
          ...(request.name === undefined ? {} : { name: request.name }),
          password: request.password,
          client_id: 'clawee-agent',
          agent_id: agentId
        },
        method: 'POST',
        path: '/api/v1/auth/register'
      });
    },

    async login(request, agentId) {
      const response = await requestJson({
        body: {
          email: request.email,
          password: request.password,
          client_id: 'clawee-agent',
          agent_id: agentId
        },
        method: 'POST',
        path: '/api/v1/auth/login',
        schema: loginResponseSchema
      });
      return {
        account: accountSummary(response.data.account),
        agentId: response.data.agent.agent_id,
        accessToken: response.data.access_token,
        tokenType: response.data.token_type,
        expiresAt: response.data.expires_at
      };
    },

    async prepareDingTalkAuthorization(request) {
      const methods = await requestJson({
        domain: 'auth',
        method: 'GET',
        path: '/api/v1/auth/methods',
        schema: authMethodsResponseSchema
      });
      if (!methods.data.dingtalk.enabled) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'response',
          404,
          'dingtalk_disabled'
        );
      }
      const query = new URLSearchParams({
        agent_id: request.agentId,
        redirect_uri: request.redirectUri,
        code_challenge: request.codeChallenge,
        code_challenge_method: 'S256',
        state: request.state
      });
      return new URL(
        `/api/v1/auth/dingtalk/clawee/start?${query.toString()}`,
        origin
      ).toString();
    },

    async exchangeDingTalkAuthorizationCode(request) {
      const response = await requestJson({
        body: {
          grant_type: 'authorization_code',
          client_id: 'clawee-agent',
          agent_id: request.agentId,
          code: request.code,
          redirect_uri: request.redirectUri,
          code_verifier: request.codeVerifier
        },
        domain: 'auth',
        method: 'POST',
        path: '/api/v1/auth/dingtalk/clawee/token',
        schema: loginResponseSchema
      });
      return {
        account: accountSummary(response.data.account),
        agentId: response.data.agent.agent_id,
        accessToken: response.data.access_token,
        tokenType: response.data.token_type,
        expiresAt: response.data.expires_at
      };
    },

    async startQrLogin(request, agentId) {
      const response = await requestJson({
        body: {
          provider: request.provider,
          client_id: 'clawee-agent',
          agent_id: agentId
        },
        method: 'POST',
        path: '/api/v1/auth/qr-login',
        domain: 'auth',
        schema: qrLoginStartResponseSchema
      });
      return {
        requestId: response.data.request_id,
        provider: response.data.provider,
        qrCodeUrl: response.data.qr_code_url,
        expiresAt: response.data.expires_at,
        pollAfterMs: response.data.poll_after_ms
      };
    },

    async pollQrLogin(requestId, agentId) {
      const query = new URLSearchParams({ agent_id: agentId });
      const response = await requestJson({
        method: 'GET',
        path: `/api/v1/auth/qr-login/${encodeURIComponent(requestId)}?${query.toString()}`,
        domain: 'auth',
        schema: qrLoginStatusResponseSchema
      });
      const result = response.data;
      if (result.status !== 'signed_in') {
        return {
          requestId: result.request_id,
          provider: result.provider,
          status: result.status,
          ...(result.poll_after_ms === undefined
            ? {}
            : { pollAfterMs: result.poll_after_ms })
        };
      }
      return {
        requestId: result.request_id,
        provider: result.provider,
        status: 'signed_in',
        login: {
          account: accountSummary(result.account),
          agentId: result.agent.agent_id,
          accessToken: result.access_token,
          tokenType: result.token_type,
          expiresAt: result.expires_at
        }
      };
    },

    async getMe(accessToken) {
      const response = await requestJson({
        accessToken,
        method: 'GET',
        path: '/api/v1/auth/me',
        retryTransportFailure: true,
        schema: meResponseSchema
      });
      return {
        account: accountSummary(response.data.account),
        agentId: response.data.agent.agent_id,
        status: response.data.account.status,
        frontendAllowed: response.data.applications.frontend,
        activityReportingEnabled:
          response.data.agent_activity_reporting_enabled
      };
    },

    async reportAgentActivity(accessToken, request) {
      await requestWithoutResult({
        accessToken,
        body: request,
        domain: 'activity',
        method: 'POST',
        path: '/api/v1/app/agent-activity/events',
        timeoutMs: 3_000
      });
    },

    async logout(accessToken) {
      await requestWithoutResult({
        accessToken,
        method: 'POST',
        path: '/api/v1/auth/logout'
      });
    },

    async getModelConfiguration(accessToken) {
      const response = await requestJson({
        accessToken,
        method: 'POST',
        path: '/api/v1/app/model-configuration',
        schema: modelConfigurationSchema
      });
      if (response.data.mode === 'enterprise_managed') {
        return { mode: response.data.mode };
      }
      return {
        mode: response.data.mode,
        baseUrl: response.data.base_url,
        model: response.data.model,
        defaultModel: response.data.default_model ?? response.data.model,
        apiKey: response.data.api_key,
        credentialVersion: response.data.credential_version
      };
    },

    async getPlatformBranding(accessToken) {
      const response = await requestJson({
        accessToken,
        method: 'GET',
        path: '/api/v1/app/platform-branding',
        schema: platformBrandingSchema
      });
      return {
        sidebarLogoConfigured: response.data.sidebar_logo_configured,
        sidebarCompactLogoConfigured: response.data.sidebar_compact_logo_configured
      };
    },

    getPlatformBrandingImage(accessToken, kind) {
      return requestPlatformBrandingImage(accessToken, kind);
    },

    async revealAccountMcpToken(accessToken) {
      const response = await requestJson({
        accessToken,
        domain: 'mcp-token',
        method: 'POST',
        path: '/api/v1/app/mcp/token/reveal',
        schema: accountMcpTokenResponseSchema
      });
      if (
        !response.data.token_info.token_scopes.includes('mcp:call')
        || (
          response.data.token_info.token_expires_at !== null
          && Date.parse(response.data.token_info.token_expires_at) <= Date.now()
        )
      ) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          200
        );
      }
      return {
        userId: response.data.token_info.user_id,
        tokenId: response.data.token_info.token_id,
        token: response.data.token,
        fingerprint: response.data.token_info.token_fingerprint,
        expiresAt: response.data.token_info.token_expires_at,
        scopes: [...response.data.token_info.token_scopes],
        createdAt: response.data.token_info.created_at
      };
    },

    async getMcpCatalog(accessToken) {
      const response = await requestJson({
        accessToken,
        domain: 'mcp',
        method: 'GET',
        path: '/api/v1/app/mcp/catalog',
        schema: mcpCatalogResponseSchema
      });
      return {
        upstreams: response.data.upstreams.map(mapRemoteMcpUpstream)
      };
    },

    async listSkills(accessToken) {
      const response = await requestJson({
        accessToken,
        domain: 'skill',
        method: 'GET',
        path: '/api/v1/app/skills',
        schema: skillListResponseSchema
      });
      return response.data.map(mapRemoteSkill);
    },

    async getSkillDetail(accessToken, skillId) {
      const query = new URLSearchParams({ skill_id: skillId });
      const response = await requestJson({
        accessToken,
        domain: 'skill',
        method: 'GET',
        path: `/api/v1/app/skills/detail?${query.toString()}`,
        schema: skillDetailResponseSchema
      });
      return {
        ...mapRemoteSkill(response.data),
        ...(response.data.changelog === undefined
          ? {}
          : { changelog: response.data.changelog })
      };
    },

    async listKnowledgeBases(accessToken) {
      const response = await requestJson({
        accessToken,
        domain: 'knowledge',
        method: 'GET',
        path: '/api/v1/app/knowledge-bases',
        schema: knowledgeBaseListResponseSchema
      });
      return {
        knowledgeBases: response.data.map(mapRemoteKnowledgeBase),
        meta: mapListMeta(response.meta)
      };
    },

    async listKnowledgeDocuments(accessToken, knowledgeBaseId) {
      const query = new URLSearchParams({
        knowledge_base_id: knowledgeBaseId
      });
      const response = await requestJson({
        accessToken,
        domain: 'knowledge',
        method: 'GET',
        path: `/api/v1/app/knowledge-bases/documents?${query.toString()}`,
        schema: knowledgeDocumentListResponseSchema
      });
      return {
        documents: response.data.map(mapRemoteKnowledgeDocument),
        meta: mapListMeta(response.meta)
      };
    },

    async uploadKnowledgeDocument(request) {
      const file = await openAsBlob(request.filePath, {
        type: request.mimeType
      });
      const form = new FormData();
      form.append('knowledge_base_id', request.knowledgeBaseId);
      form.append('file', file, request.fileName);

      let response: Response;
      try {
        response = await fetchImpl(
          new URL('/api/v1/app/knowledge-bases/documents', origin),
          {
            body: form,
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${request.accessToken}`
            },
            method: 'POST',
            signal: AbortSignal.timeout(documentUploadTimeoutMs)
          }
        );
      } catch {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'request'
        );
      }

      if (!response.ok) {
        throw await createResponseError(response, 'knowledge');
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          response.status
        );
      }
      const parsed = knowledgeDocumentUploadResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          response.status
        );
      }
      return mapRemoteKnowledgeDocument(parsed.data.data);
    },

    async listSharedSpaces(accessToken, input = {}) {
      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      const response = await requestJson({
        accessToken,
        domain: 'shared-file',
        method: 'GET',
        path: `/api/v1/app/shared-spaces${suffix}`,
        schema: sharedSpaceListResponseSchema
      });
      return {
        spaces: response.data.map(mapRemoteSharedSpace),
        meta: {
          ...mapListMeta(response.meta),
          maxFileSizeBytes: response.meta.max_file_size_bytes
        }
      };
    },

    async listSharedFiles(request) {
      const query = new URLSearchParams();
      if (request.spaceId !== undefined) query.set('space_id', request.spaceId);
      if (request.query !== undefined) query.set('query', request.query);
      if (request.logicalPathPrefix !== undefined) {
        query.set('logical_path_prefix', request.logicalPathPrefix);
      }
      if (request.limit !== undefined) query.set('limit', String(request.limit));
      if (request.cursor !== undefined) query.set('cursor', request.cursor);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      const response = await requestJson({
        accessToken: request.accessToken,
        domain: 'shared-file',
        method: 'GET',
        path: `/api/v1/app/shared-files${suffix}`,
        schema: sharedFileListResponseSchema
      });
      return {
        files: response.data.map(mapRemoteSharedFile),
        meta: mapListMeta(response.meta)
      };
    },

    async getSharedFileDetail(accessToken, fileId) {
      const query = new URLSearchParams({ file_id: fileId });
      const response = await requestJson({
        accessToken,
        domain: 'shared-file',
        method: 'GET',
        path: `/api/v1/app/shared-files/detail?${query.toString()}`,
        schema: sharedFileDetailResponseSchema
      });
      return mapRemoteSharedFile(response.data);
    },

    async downloadSharedFileContent(request) {
      const query = new URLSearchParams({ file_id: request.fileId });
      let response: Response;
      try {
        response = await fetchImpl(
          new URL(`/api/v1/app/shared-files/content?${query.toString()}`, origin),
          {
            headers: {
              Accept: 'application/octet-stream',
              Authorization: `Bearer ${request.accessToken}`
            },
            method: 'GET',
            signal: AbortSignal.timeout(sharedFileTransferTimeoutMs)
          }
        );
      } catch {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'request'
        );
      }

      if (!response.ok) {
        throw await createResponseError(response, 'shared-file');
      }
      const declaredLength = requireContentLength(
        response.headers.get('content-length')
      );
      if (declaredLength > maxSharedFileBytes) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SHARED_FILE_TOO_LARGE',
          'download',
          response.status
        );
      }
      const expectedSha256 = requireSha256Header(
        response.headers.get('x-content-sha256')
      );
      const revision = requirePositiveIntegerHeader(
        response.headers.get('x-file-revision')
      );
      const responseFileId = response.headers.get('x-shared-file-id');
      if (responseFileId !== request.fileId || response.body === null) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'download',
          response.status
        );
      }

      const hash = createHash('sha256');
      const reader = response.body.getReader();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let bytes = 0;
      try {
        handle = await open(request.destinationPath, 'wx', 0o600);
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > maxSharedFileBytes || bytes > declaredLength) {
            throw new EnterpriseHttpError(
              'ENTERPRISE_SHARED_FILE_LENGTH_MISMATCH',
              'download',
              response.status
            );
          }
          hash.update(result.value);
          await writeAll(handle, result.value);
        }
        const sha256 = hash.digest('hex');
        if (bytes !== declaredLength) {
          throw new EnterpriseHttpError(
            'ENTERPRISE_SHARED_FILE_LENGTH_MISMATCH',
            'download',
            response.status
          );
        }
        if (sha256 !== expectedSha256) {
          throw new EnterpriseHttpError(
            'ENTERPRISE_SHARED_FILE_DIGEST_MISMATCH',
            'download',
            response.status
          );
        }
        await handle.close();
        handle = undefined;
        return {
          bytes,
          sha256,
          revision,
          contentType:
            response.headers.get('content-type') ?? 'application/octet-stream'
        };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(request.destinationPath, { force: true }).catch(() => undefined);
        if (error instanceof EnterpriseHttpError) throw error;
        throw new EnterpriseHttpError(
          'ENTERPRISE_SHARED_FILE_STORAGE_UNAVAILABLE',
          'download',
          response.status
        );
      } finally {
        reader.releaseLock();
      }
    },

    async uploadSharedFileContent(request) {
      const file = await openAsBlob(request.filePath, {
        type: request.contentType
      });
      if (file.size !== request.sizeBytes) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SHARED_FILE_LENGTH_MISMATCH',
          'upload'
        );
      }
      const query = new URLSearchParams({
        space_id: request.spaceId,
        logical_path: request.logicalPath
      });
      if (request.expectedRevision !== undefined) {
        query.set('expected_revision', String(request.expectedRevision));
      }

      let response: Response;
      try {
        response = await fetchImpl(
          new URL(`/api/v1/app/shared-files/content?${query.toString()}`, origin),
          {
            body: file,
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${request.accessToken}`,
              'Content-Length': String(request.sizeBytes),
              'Content-Type': request.contentType,
              'X-Content-SHA256': request.sha256
            },
            method: 'POST',
            signal: AbortSignal.timeout(sharedFileTransferTimeoutMs)
          }
        );
      } catch {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'request'
        );
      }
      if (!response.ok) {
        throw await createResponseError(response, 'shared-file');
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          response.status
        );
      }
      const parsed = sharedFileMutationResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          response.status
        );
      }
      return mapRemoteSharedFileMutation(parsed.data.data);
    },

    async hasAgentActivityGrant(accessToken) {
      const response = await requestJson({
        accessToken,
        domain: 'activity',
        method: 'GET',
        path: '/api/v1/app/data-views',
        schema: activityDataViewsResponseSchema
      });
      return response.data.some(view => (
        view.view_id === 'agent_activity' && view.actions.includes('read')
      ));
    },

    async getActivityStatistics(accessToken, range) {
      const query = new URLSearchParams({ range });
      const response = await requestJson({
        accessToken,
        domain: 'activity',
        method: 'GET',
        path: `/api/v1/app/activity/statistics?${query.toString()}`,
        schema: activityStatisticsResponseSchema
      });
      const statistics = mapActivityStatistics(response.data);
      if (
        statistics.range !== range
        || (
          range === 'today'
            ? statistics.trend.granularity !== 'hour'
            : statistics.trend.granularity !== 'day'
        )
      ) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          200
        );
      }
      return statistics;
    },

    async getActivityDetail(accessToken, collectorId, agentId) {
      const query = new URLSearchParams({
        collector_id: collectorId,
        agent_id: agentId
      });
      const response = await requestJson({
        accessToken,
        domain: 'activity',
        method: 'GET',
        path: `/api/v1/app/activity/detail?${query.toString()}`,
        schema: activityDetailResponseSchema
      });
      const detail = mapActivityDetail(
        'data' in response ? response.data : response
      );
      if (
        detail.agent.collectorId !== collectorId
        || detail.agent.agentId !== agentId
      ) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          200
        );
      }
      return detail;
    },

    async getBillingOverview(accessToken, range) {
      const query = new URLSearchParams({ range });
      const response = await requestJson({
        accessToken,
        domain: 'billing',
        method: 'GET',
        path: `/api/v1/app/billing/overview?${query.toString()}`,
        schema: billingOverviewResponseSchema
      });
      return {
        balanceCny: response.data.balance_cny,
        generatedAt: response.data.generated_at
      };
    },

    async getBilibiliDashboard(accessToken) {
      const sourcesResponse = await requestJson({
        accessToken,
        domain: 'business-data',
        method: 'GET',
        path: '/api/v1/app/business-data-sources/bilibili',
        schema: bilibiliSourcesResponseSchema
      });
      const sources = sourcesResponse.data.items;
      const source = sources.find(item => item.status === 'active') ?? sources[0];
      if (source === undefined) return { status: 'unconfigured' };
      const query = new URLSearchParams({
        range: '7d',
        source_id: source.source_id
      });
      const response = await requestJson({
        accessToken,
        domain: 'business-data',
        method: 'GET',
        path: `/api/v1/app/business-dashboards/bilibili-operation?${query.toString()}`,
        schema: bilibiliDashboardResponseSchema
      });
      const dashboard = response.data;
      return {
        status: dashboard.status,
        ...(dashboard.data === undefined ? {} : {
          data: {
            capturedAt: dashboard.data.captured_at,
            followerCount: dashboard.data.follower_count,
            collectedContentCount: dashboard.data.collected_content_count,
            viewCount: dashboard.data.view_count,
            interactionCount: dashboard.data.interaction_count,
            topContents: dashboard.data.top_contents.map(item => ({
              externalContentId: item.external_content_id,
              title: item.title,
              capturedAt: item.captured_at,
              viewCount: item.view_count,
              interactionCount: item.interaction_count
            }))
          }
        })
      };
    },

    async createRechargeSession(accessToken) {
      const response = await requestJson({
        accessToken,
        domain: 'billing',
        emptyBody: true,
        method: 'POST',
        path: '/api/v1/app/billing/recharge-session',
        schema: rechargeSessionResponseSchema
      });
      const rechargeUrl = new URL(response.data.recharge_url);
      if (
        rechargeUrl.protocol !== 'https:'
        || rechargeUrl.username.length > 0
        || rechargeUrl.password.length > 0
        || Date.parse(response.data.expires_at) <= Date.now()
      ) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          200
        );
      }
      return { rechargeUrl: rechargeUrl.toString() };
    },

    async listRechargeOrders(accessToken, page) {
      const query = new URLSearchParams({
        page: String(page),
        page_size: '20'
      });
      const response = await requestJson({
        accessToken,
        domain: 'billing',
        method: 'GET',
        path: `/api/v1/app/billing/recharge-orders?${query.toString()}`,
        schema: rechargeOrderPageResponseSchema
      });
      if (response.data.page !== page) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          200
        );
      }
      return {
        items: response.data.items.map(order => ({
          orderNo: order.order_no,
          amountCents: order.amount_cents,
          currency: order.currency,
          channel: order.channel,
          status: order.status,
          paymentStatus: order.payment_status,
          fulfillmentStatus: order.fulfillment_status,
          createdAt: order.created_at,
          ...(order.paid_at === null ? {} : { paidAt: order.paid_at }),
          ...(order.fulfilled_at === null
            ? {}
            : { fulfilledAt: order.fulfilled_at })
        })),
        page: response.data.page,
        total: response.data.total
      };
    },

    async downloadSkillPackage(request) {
      const query = new URLSearchParams({
        skill_id: request.skillId,
        version_id: request.versionId
      });
      let response: Response;
      try {
        response = await fetchImpl(
          new URL(`/api/v1/app/skills/package?${query.toString()}`, origin),
          {
            headers: {
              Accept: 'application/zip',
              Authorization: `Bearer ${request.accessToken}`
            },
            method: 'GET',
            signal: AbortSignal.timeout(downloadTimeoutMs)
          }
        );
      } catch {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'request'
        );
      }

      if (!response.ok) {
        throw await createResponseError(response, 'skill');
      }

      const declaredLength = parseContentLength(response.headers.get('content-length'));
      if (declaredLength !== undefined && declaredLength > maxPackageBytes) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SKILL_PACKAGE_TOO_LARGE',
          'download',
          response.status
        );
      }
      if (response.body === null) {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'download',
          response.status
        );
      }

      const hash = createHash('sha256');
      const reader = response.body.getReader();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let bytes = 0;
      try {
        handle = await open(request.destinationPath, 'wx', 0o600);
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > maxPackageBytes) {
            throw new EnterpriseHttpError(
              'ENTERPRISE_SKILL_PACKAGE_TOO_LARGE',
              'download',
              response.status
            );
          }
          hash.update(result.value);
          await writeAll(handle, result.value);
        }
        const sha256 = hash.digest('hex');
        if (sha256 !== request.expectedSha256) {
          throw new EnterpriseHttpError(
            'ENTERPRISE_SKILL_PACKAGE_HASH_MISMATCH',
            'download',
            response.status
          );
        }
        await handle.close();
        handle = undefined;
        return { bytes, sha256 };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(request.destinationPath, { force: true }).catch(() => undefined);
        if (error instanceof EnterpriseHttpError) throw error;
        throw new EnterpriseHttpError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'download',
          response.status
        );
      } finally {
        reader.releaseLock();
      }
    }
  };
}

function jsonHeaders(
  accessToken: string | undefined,
  hasBody: boolean
): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(accessToken === undefined
      ? {}
      : { Authorization: `Bearer ${accessToken}` })
  };
}

function accountSummary(account: z.infer<typeof accountSchema>): EnterpriseAccountSummary {
  return {
    subjectId: account.account_id ?? account.user_id!,
    email: account.email,
    name: account.name
  };
}

function mapRemoteSkill(
  skill: z.infer<typeof remoteSkillSchema>
): EnterpriseRemoteSkill {
  return {
    skillId: skill.skill_id,
    name: skill.name,
    ...(skill.description === undefined
      ? {}
      : { description: skill.description }),
    versionId: skill.version_id,
    version: skill.version,
    packageSha256: skill.package_sha256,
    updatedAt: skill.updated_at
  };
}

function mapRemoteMcpUpstream(
  upstream: z.infer<typeof remoteMcpUpstreamSchema>
): EnterpriseRemoteMcpUpstream {
  return {
    upstreamId: upstream.id,
    name: upstream.name,
    domain: upstream.domain,
    endpoint: upstream.mcp_endpoint,
    upstreamTransport: upstream.upstream_transport,
    namespace: upstream.namespace,
    status: upstream.status,
    tools: upstream.tools.map(tool => ({
      toolId: tool.id,
      upstreamName: tool.upstream_name,
      name: tool.name,
      exposedName: tool.exposed_name,
      title: tool.title,
      description: tool.description,
      riskLevel: tool.risk_level,
      confirmRequired: tool.confirm_required,
      status: tool.status,
      authorized: tool.authorized,
      authorizationExpiresAt: tool.authorization_expires_at
    }))
  };
}

function mapRemoteKnowledgeBase(
  knowledgeBase: z.infer<typeof remoteKnowledgeBaseSchema>
): EnterpriseRemoteKnowledgeBase {
  return {
    knowledgeBaseId: knowledgeBase.knowledge_base_id,
    name: knowledgeBase.name,
    description: knowledgeBase.description,
    status: knowledgeBase.status,
    documentCount: knowledgeBase.document_count,
    permissions: {
      read: knowledgeBase.permissions.read,
      upload: knowledgeBase.permissions.upload,
      search: knowledgeBase.permissions.search ?? false
    }
  };
}

function mapRemoteKnowledgeDocument(
  document: z.infer<typeof remoteKnowledgeDocumentSchema>
): EnterpriseRemoteKnowledgeDocument {
  return {
    documentId: document.document_id,
    knowledgeBaseId: document.knowledge_base_id,
    name: document.name,
    sizeBytes: document.size_bytes,
    mimeType: document.mime_type,
    status: document.status,
    errorMessage: document.error_message,
    uploadedBy: document.uploaded_by,
    createdAt: document.created_at,
    updatedAt: document.updated_at
  };
}

function mapRemoteSharedSpace(
  space: z.infer<typeof remoteSharedSpaceSchema>
): EnterpriseRemoteSharedSpace {
  return {
    spaceId: space.space_id,
    name: space.name,
    description: space.description,
    updatedAt: space.updated_at,
    permissions: {
      read: space.permissions?.read ?? true,
      write: space.permissions?.write ?? false
    }
  };
}

function mapRemoteSharedFile(
  file: z.infer<typeof remoteSharedFileSchema> & {
    created_by_user_id?: string;
    created_by_agent_id?: string;
    created_at?: string;
  }
): EnterpriseRemoteSharedFile {
  return {
    fileId: file.file_id,
    spaceId: file.space_id,
    spaceName: file.space_name,
    logicalPath: file.logical_path,
    fileName: file.file_name,
    sizeBytes: file.size_bytes,
    sha256: file.sha256,
    contentType: file.content_type,
    revision: file.revision,
    ...(file.created_by_user_id === undefined
      ? {}
      : { createdByUserId: file.created_by_user_id }),
    ...(file.created_by_agent_id === undefined
      ? {}
      : { createdByAgentId: file.created_by_agent_id }),
    updatedByUserId: file.updated_by_user_id,
    updatedByAgentId: file.updated_by_agent_id,
    ...(file.created_at === undefined ? {} : { createdAt: file.created_at }),
    updatedAt: file.updated_at
  };
}

function mapRemoteSharedFileMutation(
  file: z.infer<typeof sharedFileMutationResponseSchema>['data']
): EnterpriseRemoteSharedFileMutation {
  return {
    fileId: file.file_id,
    spaceId: file.space_id,
    logicalPath: file.logical_path,
    fileName: file.file_name,
    sizeBytes: file.size_bytes,
    sha256: file.sha256,
    contentType: file.content_type,
    revision: file.revision,
    created: file.created,
    updatedAt: file.updated_at
  };
}

function mapListMeta(meta: z.infer<typeof listMetaSchema>): EnterpriseListMeta {
  return {
    nextCursor: meta.next_cursor,
    hasNext: meta.has_next
  };
}

function mapActivityStatistics(
  statistics: z.infer<typeof activityStatisticsResponseSchema>['data']
): EnterpriseActivityStatisticsResponse {
  return {
    range: statistics.range,
    timezone: statistics.timezone,
    startDate: statistics.start_date,
    endDate: statistics.end_date,
    generatedAt: statistics.generated_at,
    organization: {
      usage: mapActivityTokenUsage(statistics.organization.usage),
      activeEmployees: statistics.organization.active_employees,
      activeAgents: statistics.organization.active_agents,
      completedTurns: statistics.organization.completed_turns,
      mcpDistribution: statistics.organization.mcp_distribution.map(item => ({
        id: item.id,
        label: item.label,
        invocationCount: item.invocation_count,
        share: item.share
      }))
    },
    trend: {
      granularity: statistics.trend.granularity,
      points: statistics.trend.points.map(point => ({
        bucketStart: point.bucket_start,
        ...mapActivityTokenUsage(point)
      }))
    },
    modelDistribution: statistics.model_distribution.map(item => ({
      model: item.model,
      requests: item.requests,
      inputTokens: item.input_tokens,
      cachedInputTokens: item.cached_input_tokens,
      outputTokens: item.output_tokens,
      totalTokens: item.total_tokens,
      share: item.share
    })),
    tokenUsageRanking: (statistics.token_usage_ranking ?? []).map(item => ({
      rank: item.rank,
      name: item.name,
      requests: item.requests,
      totalTokens: item.total_tokens
    })),
    agents: statistics.agents.map(agent => ({
      collectorId: agent.collector_id,
      agentId: agent.agent_id,
      name: agent.name,
      status: agent.status,
      sessionCount: agent.session_count,
      turnCount: agent.turn_count,
      ...(agent.last_activity_at === undefined
        ? {}
        : { lastActivityAt: agent.last_activity_at })
    })),
    dataStatus: {
      sub2api: 'model_usage' in statistics.data_status
        ? statistics.data_status.model_usage
        : statistics.data_status.sub2api,
      activity: statistics.data_status.activity
    }
  };
}

function mapActivityTokenUsage(
  usage: z.infer<typeof activityTokenUsageSchema>
) {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens
  };
}

function mapActivityDetail(
  detail: z.infer<typeof activityDetailPayloadSchema>
): EnterpriseActivityDetailResponse {
  return {
    schemaVersion: detail.schema_version,
    serverTime: detail.server_time,
    agent: {
      collectorId: detail.agent.collector_id,
      agentId: detail.agent.agent_id,
      displayName: detail.agent.display_name,
      agentType: detail.agent.agent_type,
      workspaceName: detail.agent.workspace_name,
      status: detail.agent.status,
      activeSubAgentCount: detail.agent.sub_agents.active_count,
      totalSubAgentCount: detail.agent.sub_agents.total_count,
      recentToolCalls: detail.agent.recent_tool_calls,
      ...optionalField('lastSeenAt', detail.agent.last_seen_at),
      ...optionalField('updatedAt', detail.agent.updated_at)
    },
    sessions: detail.sessions.map(session => ({
      ...optionalField('sessionId', firstString(session.session_id, session.id)),
      ...optionalField('title', session.title),
      ...optionalField('status', session.status),
      ...optionalField('summary', session.summary),
      ...optionalField('workspaceName', session.workspace_name),
      ...optionalField('startedAt', session.started_at),
      ...optionalField('endedAt', session.ended_at),
      ...optionalNumberField('durationMs', session.duration_ms)
    })),
    turns: detail.turns.map(turn => ({
      ...optionalField('turnId', firstString(turn.turn_id, turn.id)),
      ...optionalField('sessionId', turn.session_id),
      ...optionalField('title', turn.title),
      ...optionalField('status', turn.status),
      ...optionalField(
        'prompt',
        firstString(turn.prompt_summary, turn.user_prompt)
      ),
      ...optionalField(
        'assistantSummary',
        firstString(turn.assistant_summary, turn.last_assistant_message)
      ),
      ...optionalField('model', turn.model),
      ...optionalField('startedAt', turn.started_at),
      ...optionalField('completedAt', turn.completed_at)
    })),
    subAgents: detail.sub_agents.map(agent => ({
      ...optionalField(
        'subAgentId',
        firstString(agent.sub_agent_id, agent.agent_id, agent.id)
      ),
      ...optionalField('name', firstString(agent.name, agent.display_name)),
      ...optionalField('status', agent.status),
      ...optionalNumberField('completedTurns', agent.completed_turns),
      ...optionalField('startedAt', agent.started_at),
      ...optionalField('completedAt', agent.completed_at)
    })),
    toolCalls: detail.tool_calls.map(tool => ({
      ...optionalField(
        'toolCallId',
        firstString(tool.tool_call_id, tool.external_tool_call_id, tool.id)
      ),
      ...optionalField('name', firstString(tool.name, tool.tool_name)),
      ...optionalField('type', firstString(tool.type, tool.tool_type)),
      ...optionalField('status', tool.status),
      ...optionalField(
        'occurredAt',
        firstString(
          tool.occurred_at,
          tool.timestamp,
          tool.started_at,
          tool.completed_at
        )
      ),
      ...optionalNumberField('durationMs', tool.duration_ms)
    })),
    statusTimeline: detail.status_timeline.map(item => ({
      ...optionalField('status', item.status),
      ...optionalField(
        'occurredAt',
        firstString(
          item.occurred_at,
          item.timestamp,
          item.completed_at,
          item.started_at
        )
      ),
      ...optionalField('message', item.message)
    })),
    recentActivities: detail.recent_activities.map(item => ({
      ...optionalField('activityId', firstString(item.activity_id, item.id)),
      ...optionalField('type', firstString(item.type, item.activity_type)),
      ...optionalField('title', item.title),
      ...optionalField('status', item.status),
      ...optionalField(
        'occurredAt',
        firstString(
          item.occurred_at,
          item.timestamp,
          item.completed_at,
          item.started_at
        )
      )
    })),
    stats: {
      sessionDurationMs: detail.stats.session_duration_ms,
      activeSubAgents: detail.stats.active_sub_agents,
      totalSubAgents: detail.stats.total_sub_agents,
      recentActivityCount: detail.stats.recent_activity_count,
      businessRiskLevel: detail.stats.business_risk_level,
      activeSessions: detail.stats.active_sessions,
      activeWorkMs: detail.stats.active_work_ms,
      toolTypeVariety: detail.stats.tool_type_variety,
      toolCallCount: detail.stats.tool_call_count
    }
  };
}

async function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>(resolve => setTimeout(resolve, delayMs));
}

function firstString(
  ...values: Array<string | null | undefined>
): string | undefined {
  return values.find((value): value is string => (
    typeof value === 'string' && value.length > 0
  ));
}

function optionalField<Key extends string>(
  key: Key,
  value: string | null | undefined
): Partial<Record<Key, string>> {
  return typeof value === 'string' && value.length > 0
    ? { [key]: value } as Record<Key, string>
    : {};
}

function optionalNumberField<Key extends string>(
  key: Key,
  value: number | null | undefined
): Partial<Record<Key, number>> {
  return typeof value === 'number'
    ? { [key]: value } as Record<Key, number>
    : {};
}

type EnterpriseHttpDomain =
  | 'general'
  | 'auth'
  | 'activity'
  | 'billing'
  | 'business-data'
  | 'skill'
  | 'knowledge'
  | 'shared-file'
  | 'mcp'
  | 'mcp-token';

async function createResponseError(
  response: Response,
  domain: EnterpriseHttpDomain = 'general'
): Promise<EnterpriseHttpError> {
  let upstreamCode: string | undefined;
  let requestId = response.headers.get('x-request-id') ?? undefined;
  let details: Record<string, unknown> | undefined;
  try {
    const value: unknown = await response.json();
    if (isPlainObject(value) && isPlainObject(value.error)) {
      if (typeof value.error.code === 'string') upstreamCode = value.error.code;
      if (typeof value.error.request_id === 'string') {
        requestId = value.error.request_id;
      }
      details = domain === 'activity' || domain === 'billing' || domain === 'business-data'
        ? undefined
        : mapUpstreamErrorDetails(upstreamCode, value.error.details);
    }
  } catch {
    // Error bodies are intentionally discarded.
  }

  return new EnterpriseHttpError(
    mapResponseCode(response.status, upstreamCode, domain),
    'response',
    response.status,
    upstreamCode,
    parseRetryAfter(response.headers.get('retry-after')),
    requestId,
    details
  );
}

function mapResponseCode(
  statusCode: number,
  upstreamCode: string | undefined,
  domain: EnterpriseHttpDomain
): RuntimeErrorCode {
  if (statusCode === 400) return 'ENTERPRISE_INVALID_REQUEST';
  if (statusCode === 401) return 'ENTERPRISE_UNAUTHORIZED';
  if (
    domain === 'business-data'
    && statusCode === 403
    && upstreamCode === 'business_data_view_forbidden'
  ) {
    return 'ENTERPRISE_DATA_VIEW_FORBIDDEN';
  }
  if (
    domain === 'billing'
    && statusCode === 409
    && upstreamCode === 'billing_not_managed'
  ) {
    return 'ENTERPRISE_BILLING_NOT_MANAGED';
  }
  if (
    domain === 'billing'
    && statusCode === 503
    && (
      upstreamCode === 'billing_unavailable'
      || upstreamCode === 'recharge_unavailable'
      || upstreamCode === 'recharge_records_unavailable'
    )
  ) {
    return 'ENTERPRISE_BILLING_UNAVAILABLE';
  }
  if (
    domain === 'billing'
    && statusCode === 403
    && upstreamCode === 'data_view_forbidden'
  ) {
    return 'ENTERPRISE_DATA_VIEW_FORBIDDEN';
  }
  if (
    domain === 'activity'
    && statusCode === 403
    && upstreamCode === 'data_view_forbidden'
  ) {
    return 'ENTERPRISE_DATA_VIEW_FORBIDDEN';
  }
  if (
    domain === 'activity'
    && statusCode === 503
    && upstreamCode === 'data_authorization_unavailable'
  ) {
    return 'ENTERPRISE_DATA_AUTHORIZATION_UNAVAILABLE';
  }
  if (
    domain === 'activity'
    && statusCode === 503
    && upstreamCode === 'activity_unavailable'
  ) {
    return 'ENTERPRISE_ACTIVITY_UNAVAILABLE';
  }
  if (
    domain === 'activity'
    && statusCode === 404
  ) {
    return 'ENTERPRISE_ACTIVITY_NOT_FOUND';
  }
  if (
    domain === 'activity'
    && (
      upstreamCode === 'activity_statistics_failed'
      || upstreamCode === 'sub2api_unavailable'
      || upstreamCode === 'sub2api_auth_failed'
      || upstreamCode === 'sub2api_forbidden'
      || upstreamCode === 'sub2api_error'
      || upstreamCode === 'sub2api_invalid_response'
      || upstreamCode === 'sub2api_rate_limited'
      || upstreamCode === 'internal_error'
    )
  ) {
    return 'ENTERPRISE_ACTIVITY_PROVIDER_ERROR';
  }
  if (statusCode === 403 && upstreamCode === 'agent_forbidden') {
    return 'ENTERPRISE_AGENT_FORBIDDEN';
  }
  if (
    statusCode === 403
    && upstreamCode === 'document_upload_forbidden'
  ) {
    return 'ENTERPRISE_DOCUMENT_UPLOAD_FORBIDDEN';
  }
  if (
    statusCode === 403
    && upstreamCode === 'shared_file_write_forbidden'
  ) {
    return 'ENTERPRISE_SHARED_FILE_WRITE_FORBIDDEN';
  }
  if (statusCode === 403) return 'ENTERPRISE_FORBIDDEN';
  if (statusCode === 404 && domain === 'mcp-token') {
    return 'ENTERPRISE_MCP_TOKEN_NOT_FOUND';
  }
  if (statusCode === 404 && domain === 'mcp') {
    return 'ENTERPRISE_MCP_UPSTREAM_NOT_FOUND';
  }
  if (
    statusCode === 404
    && upstreamCode === 'shared_space_not_found'
  ) {
    return 'ENTERPRISE_SHARED_SPACE_NOT_FOUND';
  }
  if (
    statusCode === 404
    && upstreamCode === 'shared_file_not_found'
  ) {
    return 'ENTERPRISE_SHARED_FILE_NOT_FOUND';
  }
  if (statusCode === 404 && domain === 'knowledge') {
    return 'ENTERPRISE_KNOWLEDGE_BASE_NOT_FOUND';
  }
  if (statusCode === 404 && domain === 'shared-file') {
    return 'ENTERPRISE_SHARED_FILE_NOT_FOUND';
  }
  if (statusCode === 404 && domain === 'auth') {
    return 'ENTERPRISE_SERVICE_UNAVAILABLE';
  }
  if (statusCode === 404) return 'ENTERPRISE_SKILL_NOT_FOUND';
  if (statusCode === 409 && upstreamCode === 'agent_id_conflict') {
    return 'ENTERPRISE_AGENT_ID_CONFLICT';
  }
  if (
    statusCode === 409
    && (
      domain === 'knowledge'
      || upstreamCode === 'conflict'
    )
  ) {
    return 'ENTERPRISE_KNOWLEDGE_CONFLICT';
  }
  if (
    statusCode === 409
    && upstreamCode === 'file_already_exists'
  ) {
    return 'ENTERPRISE_SHARED_FILE_ALREADY_EXISTS';
  }
  if (
    statusCode === 409
    && upstreamCode === 'revision_conflict'
  ) {
    return 'ENTERPRISE_SHARED_FILE_REVISION_CONFLICT';
  }
  if (statusCode === 409 && domain === 'shared-file') {
    return 'ENTERPRISE_SHARED_FILE_REVISION_CONFLICT';
  }
  if (statusCode === 409 || upstreamCode === 'version_changed') {
    return 'ENTERPRISE_SKILL_VERSION_CHANGED';
  }
  if (statusCode === 413 && domain === 'shared-file') {
    return 'ENTERPRISE_SHARED_FILE_TOO_LARGE';
  }
  if (statusCode === 413 && domain === 'knowledge') {
    return 'ENTERPRISE_DOCUMENT_TOO_LARGE';
  }
  if (statusCode === 413) return 'ENTERPRISE_SKILL_PACKAGE_TOO_LARGE';
  if (
    statusCode === 422
    && upstreamCode === 'content_length_mismatch'
  ) {
    return 'ENTERPRISE_SHARED_FILE_LENGTH_MISMATCH';
  }
  if (
    statusCode === 422
    && upstreamCode === 'digest_mismatch'
  ) {
    return 'ENTERPRISE_SHARED_FILE_DIGEST_MISMATCH';
  }
  if (statusCode === 415 && domain === 'knowledge') {
    return 'ENTERPRISE_DOCUMENT_TYPE_UNSUPPORTED';
  }
  if (statusCode === 429) return 'ENTERPRISE_RATE_LIMITED';
  if (
    statusCode === 502
    && (
      domain === 'knowledge'
      || upstreamCode === 'knowledge_provider_error'
    )
  ) {
    return 'ENTERPRISE_KNOWLEDGE_PROVIDER_ERROR';
  }
  if (
    statusCode >= 500
    && upstreamCode === 'storage_unavailable'
  ) {
    return 'ENTERPRISE_SHARED_FILE_STORAGE_UNAVAILABLE';
  }
  if (statusCode >= 500) return 'ENTERPRISE_SERVICE_UNAVAILABLE';
  return 'ENTERPRISE_PROTOCOL_ERROR';
}

function mapUpstreamErrorDetails(
  upstreamCode: string | undefined,
  value: unknown
): Record<string, unknown> | undefined {
  if (upstreamCode !== 'revision_conflict') {
    return isPlainObject(value) ? value : undefined;
  }
  if (isPlainObject(value)) {
    const currentRevision =
      value.currentRevision ?? value.current_revision;
    return isPositiveSafeInteger(currentRevision)
      ? { currentRevision }
      : value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    if (
      isPlainObject(item)
      && item.field === 'expected_revision'
      && isPositiveSafeInteger(item.current_revision)
    ) {
      return { currentRevision: item.current_revision };
    }
  }
  return undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
  );
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new EnterpriseHttpError(
      'ENTERPRISE_PROTOCOL_ERROR',
      'download'
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new EnterpriseHttpError(
      'ENTERPRISE_PROTOCOL_ERROR',
      'download'
    );
  }
  return parsed;
}

function requireContentLength(value: string | null): number {
  const parsed = parseContentLength(value);
  if (parsed === undefined) {
    throw new EnterpriseHttpError(
      'ENTERPRISE_PROTOCOL_ERROR',
      'download'
    );
  }
  return parsed;
}

function requirePositiveIntegerHeader(value: string | null): number {
  if (value === null || !/^[1-9]\d*$/.test(value)) {
    throw new EnterpriseHttpError(
      'ENTERPRISE_PROTOCOL_ERROR',
      'download'
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new EnterpriseHttpError(
      'ENTERPRISE_PROTOCOL_ERROR',
      'download'
    );
  }
  return parsed;
}

function requireSha256Header(value: string | null): string {
  if (value === null || !/^[0-9a-f]{64}$/.test(value)) {
    throw new EnterpriseHttpError(
      'ENTERPRISE_PROTOCOL_ERROR',
      'download'
    );
  }
  return value;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : undefined;
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  value: Uint8Array
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const result = await handle.write(
      value,
      offset,
      value.byteLength - offset
    );
    offset += result.bytesWritten;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
