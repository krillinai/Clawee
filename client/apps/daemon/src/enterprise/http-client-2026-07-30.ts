import type {
  EnterpriseAccountSummary,
  EnterpriseActivityDetailResponse,
  EnterpriseActivityRange,
  EnterpriseActivityRuntimeResponse,
  EnterpriseActivityStatisticsResponse,
  EnterpriseBilibiliDashboardRange,
  EnterpriseBilibiliDashboardResponse,
  EnterpriseBillingOverviewResponse,
  EnterpriseListMeta,
  EnterpriseSkillSpaceListResponse,
  EnterpriseSkillUploadResponse,
  EnterpriseLoginRequest,
  EnterprisePlatformBrandingResponse,
  EnterprisePlatformBrandingImageKind,
  EnterpriseQrLoginStartRequest,
  EnterpriseQrLoginStartResponse,
  EnterpriseQrProvider,
  EnterpriseRechargeOrderPageResponse,
  EnterpriseRechargeSessionResponse,
  EnterpriseRegisterRequest,
  SkillContributionQuery,
  SkillContributionResponse,
  SkillContributionCSV,
  RuntimeErrorCode,
  EnterpriseWorkflowArtifact
} from '@clawee/protocol';
import { httpFailureDetails, httpFailureMessage, safeIncidentIdentifier } from '@clawee/protocol';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  skillAIReviewTaskSchema,
  skillAIReviewClaimSchema,
  type SkillAIReviewTask,
  type SkillAIReviewClaim,
  type SkillAIReviewResult
} from './skill-ai-review-schema.js';
import { workflowArtifactSchema, workflowResponseSchema } from './workflow-schema.js';
import { approvalResponseSchema } from './approvals-schema.js';
import { contributionResponseSchema } from './skill-contributions-schema.js';
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
  email: z.string(),
  phone: z.string().regex(/^1[3-9]\d{9}$/).or(z.literal('')).optional(),
  name: z.string(),
  status: z.string(),
  avatar_url: z.string().min(1).optional()
}).superRefine((account, context) => {
  if (!account.email && !account.phone) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An account login identifier is required' });
  }
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
const sessionRenewalResponseSchema = z.object({
  data: z.object({
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
const sidebarMenuLabelSchema = z.string().refine(value =>
  value === value.trim()
  && Array.from(value).length >= 1
  && Array.from(value).length <= 10
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
);
const platformBrandingSchema = z.object({
  data: z.object({
    admin_url: z.union([z.literal(''), z.string().url().refine(value => /^https?:\/\//.test(value))]).optional(),
    accent_color: z.union([z.literal(''), z.string().regex(/^#[\da-f]{6}$/i)]).optional(),
    sidebar_logo_configured: z.boolean(),
    sidebar_compact_logo_configured: z.boolean(),
    sidebar_logo_dark_configured: z.boolean().optional(),
    sidebar_compact_logo_dark_configured: z.boolean().optional(),
    sidebar_menu_labels: z.object({
      skills: sidebarMenuLabelSchema.optional(),
      knowledge: sidebarMenuLabelSchema.optional(),
      drive: sidebarMenuLabelSchema.optional(),
      dashboard: sidebarMenuLabelSchema.optional()
    }).strict().optional()
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
    account: z.object({
      source_id: z.string(),
      name: z.string(),
      status: z.string(),
      status_reason: z.string(),
      last_success_at: z.string().datetime({ offset: true }).nullable().optional()
    }).optional(),
    range: z.enum(['today', '7d', '30d']).optional(),
    timezone: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    generated_at: z.string().datetime({ offset: true }).optional(),
    last_synced_at: z.string().datetime({ offset: true }).nullable().optional(),
    unavailable_parts: z.array(z.string()).optional().default([]),
    data: z.object({
      captured_at: z.string().datetime({ offset: true }),
      follower_count: z.number().int().nonnegative(),
      following_count: z.number().int().nonnegative().optional(),
      published_count: z.number().int().nonnegative().optional(),
      collected_content_count: z.number().int().nonnegative(),
      view_count: z.number().int().nonnegative(),
      danmaku_count: z.number().int().nonnegative().optional(),
      reply_count: z.number().int().nonnegative().optional(),
      favorite_count: z.number().int().nonnegative().optional(),
      coin_count: z.number().int().nonnegative().optional(),
      share_count: z.number().int().nonnegative().optional(),
      like_count: z.number().int().nonnegative().optional(),
      interaction_count: z.number().int().nonnegative(),
      trend: z.array(z.object({
        date: z.string(),
        follower_count: z.number().int(),
        view_count: z.number().int(),
        interaction_count: z.number().int(),
        follower_count_delta: z.number().int(),
        view_count_delta: z.number().int(),
        interaction_count_delta: z.number().int()
      })).optional().default([]),
      top_contents: z.array(z.object({
        source_id: z.string().optional().default(''),
        account_name: z.string().optional().default(''),
        external_content_id: z.string().min(1),
        title: z.string(),
        published_at: z.string().datetime({ offset: true }).nullable().optional(),
        status: z.string().optional().default(''),
        captured_at: z.string().datetime({ offset: true }),
        view_count: z.number().int().nonnegative(),
        danmaku_count: z.number().int().nonnegative().optional(),
        reply_count: z.number().int().nonnegative().optional(),
        favorite_count: z.number().int().nonnegative().optional(),
        coin_count: z.number().int().nonnegative().optional(),
        share_count: z.number().int().nonnegative().optional(),
        like_count: z.number().int().nonnegative().optional(),
        interaction_count: z.number().int().nonnegative()
      }))
    }).optional()
  })
});
const bilibiliSourcesResponseSchema = z.object({
  data: z.object({
    items: z.array(z.object({
      source_id: z.string().min(1),
      name: z.string().optional().default(''),
      status: z.enum(['active', 'disabled']),
      status_reason: z.string().optional().default(''),
      last_attempt_at: z.string().datetime({ offset: true }).nullable().optional(),
      last_success_at: z.string().datetime({ offset: true }).nullable().optional(),
      next_sync_at: z.string().datetime({ offset: true }).nullable().optional(),
      active_run_status: z.string().optional().default('')
    }))
  })
});
const meResponseSchema = z.object({
  data: z.object({
    session_id: z.string().min(1).optional(),
    account: accountSchema,
    agent: agentSchema,
    applications: z.object({
      frontend: z.boolean(),
      admin: z.boolean().optional()
    }),
    agent_activity_reporting_enabled: z.boolean().optional().default(false),
    external_feedback_allowed: z.boolean().optional()
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
  updated_at: z.string().datetime({ offset: true }),
  space_id: z.string().min(1).optional(),
  space_name: z.string().optional(),
  creator: z.object({
    user_id: z.string().min(1).optional(),
    name: z.string(),
    avatar_url: z.string().min(1).optional()
  }).optional(),
  contributors: z.array(z.object({
    user_id: z.string().min(1),
    name: z.string(),
    avatar_url: z.string().min(1).optional()
  })).optional()
});
const skillListResponseSchema = z.object({
  data: z.array(remoteSkillSchema)
});
const cloudSkillListResponseSchema = z.object({
  data: z.object({
    agent_email: z.string().email(),
    agent_name: z.string().min(1),
    prompt_template: z.string().min(1),
    skills: z.array(remoteSkillSchema.pick({
      skill_id: true,
      name: true,
      description: true,
      version: true,
      updated_at: true
    }))
  })
});
const skillSpaceListResponseSchema = z.object({
  data: z.array(z.object({
    space_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    actions: z.array(z.enum(['read', 'write']))
  }))
});
const skillUploadResponseSchema = z.object({
  data: z.object({
    approval_request_id: z.string().min(1).optional(),
    skill: z.object({ skill_id: z.string().min(1), space_id: z.string().min(1), name: z.string().min(1) }),
    version: z.object({ version: z.string().min(1) })
  })
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
  personal_owner_user_id: z.string().optional(),
  workflow_template_name: z.string().optional(),
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
const activityRuntimePayloadSchema = z.object({
  schema_version: z.literal('office.v1'),
  scope: z.literal('organization'),
  server_time: z.string().datetime({ offset: true }),
  summary: z.object({
    total_agents: z.number().int().nonnegative(),
    online_agents: z.number().int().nonnegative(),
    working_agents: z.number().int().nonnegative(),
    blocked_agents: z.number().int().nonnegative(),
    error_agents: z.number().int().nonnegative()
  }),
  agents: z.array(z.object({
    collector_id: z.string().min(1), agent_id: z.string().min(1), status: z.string().min(1),
    current_task: z.string().optional(), last_seen_at: z.string().datetime({ offset: true })
  }))
});
const activityRuntimeResponseSchema = z.union([
  activityRuntimePayloadSchema,
  z.object({ data: activityRuntimePayloadSchema })
]);

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
      platform_activity: z.object({
        active_users: z.number().int().nonnegative(),
        total_users: z.number().int().nonnegative(),
        rate: z.number().min(0).max(1)
      }).optional(),
      mcp_distribution: z.array(activityUsageDistributionSchema),
      skill_usage: z.array(z.object({
        skill_id: z.string(), skill_name: z.string(), skill_key: z.string(), source: z.string(),
        requested_runs: z.number().int().nonnegative(),
        observed_runs: z.number().int().nonnegative(),
        implicit_runs: z.number().int().nonnegative()
      })).optional(),
      skill_usage_totals: z.object({
        requested_skill_runs: z.number().int().nonnegative(),
        observed_skill_runs: z.number().int().nonnegative(),
        explicit_skill_runs: z.number().int().nonnegative(),
        implicit_skill_runs: z.number().int().nonnegative()
      }).optional()
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
      employee_id: z.string().optional(),
      employee_name: z.string().optional(),
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
const activityAgentUsageResponseSchema = z.object({ data: z.object({
  collector_id: z.string().min(1), agent_id: z.string().min(1),
  range: z.enum(['today', '7d', '30d']), timezone: z.string().min(1),
  start_date: z.string().min(1), end_date: z.string().min(1), generated_at: z.string().min(1),
  session_count: z.number().int().nonnegative(), turn_count: z.number().int().nonnegative(),
  completed_turns: z.number().int().nonnegative(), tool_call_count: z.number().int().nonnegative(),
  granularity: z.enum(['hour', 'day']),
  points: z.array(z.object({ bucket_start: z.string().min(1),
    session_count: z.number().int().nonnegative(), turn_count: z.number().int().nonnegative(),
    completed_turns: z.number().int().nonnegative(), tool_call_count: z.number().int().nonnegative() })),
  mcp_distribution: z.array(activityUsageDistributionSchema),
  mcp_status: z.enum(['available', 'unlinked']),
  skill_usage: activityStatisticsResponseSchema.shape.data.shape.organization.shape.skill_usage.unwrap(),
  skill_usage_totals: activityStatisticsResponseSchema.shape.data.shape.organization.shape.skill_usage_totals.unwrap()
}) });
export type EnterpriseRemoteSkill = {
  skillId: string;
  name: string;
  description?: string;
  versionId: string;
  version: string;
  packageSha256: string;
  updatedAt: string;
  spaceId?: string;
  spaceName?: string;
  creator?: {
    userId?: string;
    name: string;
    avatarUrl?: string;
  };
  contributors?: Array<{
    userId: string;
    name: string;
    avatarUrl?: string;
  }>;
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

export type EnterpriseRemoteCloudSkill = Pick<EnterpriseRemoteSkill, 'skillId' | 'name' | 'description' | 'version' | 'updatedAt'>;
export type EnterpriseCloudSkillList = {
  agentEmail: string;
  agentName: string;
  promptTemplate: string;
  skills: EnterpriseRemoteCloudSkill[];
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
  personalOwnerUserId?: string;
  workflowTemplateName?: string;
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

export type EnterprisePlatformBranding = EnterprisePlatformBrandingResponse;

export type EnterprisePlatformBrandingImage = {
  content: Uint8Array;
  contentType: 'image/png' | 'image/jpeg';
};

export type EnterpriseSkillParticipantAvatarImage = {
  content: Uint8Array;
  contentType: 'image/png' | 'image/jpeg' | 'image/svg+xml';
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
  sessionId?: string;
  adminAllowed?: boolean;
  externalFeedbackAllowed?: boolean;
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

export type EnterpriseApprovalDownloadInput = {
  accessToken: string;
  requestId: string;
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

export type EnterpriseSharedFilePreview = {
  content: Uint8Array;
  contentType: string;
};

export type EnterpriseSharedFileUploadInput = {
  accessToken: string;
  spaceId?: string;
  forUserId?: string;
  logicalPath: string;
  expectedRevision?: number;
  filePath: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
};

export type EnterpriseHttpClient = {
  getAgentPromptPolicy?(accessToken: string): Promise<{
    version: number;
    serverAgentPrompt: string;
    claweeAgentPrompt: string;
    updatedAt: string;
  }>;
  listSkillAIReviewTasks?(accessToken: string): Promise<{ tasks: SkillAIReviewTask[] }>;
  getSkillAIReviewRule?(accessToken: string): Promise<{ text: string; version: string } | null>;
  claimSkillAIReviewTask?(accessToken: string, requestId: string, attemptId: string, rule?: { review_skill_version: string; review_skill_sha256: string; error_code?: string }): Promise<SkillAIReviewClaim>;
  submitSkillAIReviewResult?(accessToken: string, requestId: string, result: SkillAIReviewResult): Promise<void>;
  workflowRequest?(accessToken: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ data: unknown; meta?: unknown }>;
  approvalRequest?(accessToken: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
  uploadWorkflowFile?(request: {
    accessToken: string; taskId: string; idempotencyKey: string; fileName: string; filePath: string; sizeBytes: number; sha256: string; contentType: string;
  }): Promise<EnterpriseWorkflowArtifact>;
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
  renewSession?(accessToken: string): Promise<{ accessToken: string; expiresAt: string }>;
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
    kind: EnterprisePlatformBrandingImageKind
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
  getSharedFilePreview?(
    accessToken: string,
    fileId: string,
    signal?: AbortSignal
  ): Promise<EnterpriseSharedFilePreview>;
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
  hasSkillContributionGrant?(accessToken: string): Promise<boolean>;
  getSkillContributions?(accessToken: string, endpoint: 'summary' | 'records' | 'detail', query: SkillContributionQuery | { skill_id?: string; version_id?: string }): Promise<SkillContributionResponse>;
  exportSkillContributions?(accessToken: string, query: SkillContributionQuery): Promise<SkillContributionCSV>;
  getActivityStatistics?(
    accessToken: string,
    range: EnterpriseActivityRange
  ): Promise<EnterpriseActivityStatisticsResponse>;
  getActivityRuntime?(accessToken: string): Promise<EnterpriseActivityRuntimeResponse>;
  getActivityDetail?(
    accessToken: string,
    collectorId: string,
    agentId: string,
    range?: EnterpriseActivityRange
  ): Promise<EnterpriseActivityDetailResponse>;
  getBillingOverview?(
    accessToken: string,
    range: EnterpriseActivityRange
  ): Promise<EnterpriseBillingOverviewResponse>;
  getBilibiliDashboard?(
    accessToken: string,
    input?: { range?: EnterpriseBilibiliDashboardRange; sourceId?: string }
  ): Promise<EnterpriseBilibiliDashboardResponse>;
  createRechargeSession?(
    accessToken: string
  ): Promise<EnterpriseRechargeSessionResponse>;
  listRechargeOrders?(
    accessToken: string,
    page: number
  ): Promise<EnterpriseRechargeOrderPageResponse>;
  listSkills(accessToken: string): Promise<EnterpriseRemoteSkill[]>;
  getCloudSkills?(accessToken: string): Promise<EnterpriseCloudSkillList>;
  listSkillSpaces(accessToken: string): Promise<EnterpriseSkillSpaceListResponse>;
  uploadSkillVersion(input: {
    skillId?: string;
    accessToken: string;
    spaceId: string;
    version: string;
    changelog: string;
    package: Uint8Array;
  }): Promise<EnterpriseSkillUploadResponse>;
  getSkillDetail(
    accessToken: string,
    skillId: string
  ): Promise<EnterpriseRemoteSkillDetail>;
  getSkillParticipantAvatar?(
    accessToken: string,
    skillId: string,
    userId: string
  ): Promise<EnterpriseSkillParticipantAvatarImage>;
  downloadSkillPackage(
    input: EnterpriseDownloadInput
  ): Promise<{ bytes: number; sha256: string }>;
  downloadApprovalPackage?(
    input: EnterpriseApprovalDownloadInput
  ): Promise<{ bytes: number; sha256: string }>;
};

export type EnterpriseDingTalkHttpClient = EnterpriseHttpClient & Required<Pick<
  EnterpriseHttpClient,
  'prepareDingTalkAuthorization' | 'exchangeDingTalkAuthorizationCode'
  | 'hasAgentActivityGrant'
  | 'getActivityStatistics'
  | 'getActivityRuntime'
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
    super(details ? httpFailureMessage(details) || `${code}: enterprise HTTP ${stage} failed` : `${code}: enterprise HTTP ${stage} failed`);
    this.name = 'EnterpriseHttpError';
  }
}

/** 返回安全的传输元数据及 Skill 包校验说明，不包含请求体或令牌。 */
export function enterpriseHttpErrorDetails(
  error: EnterpriseHttpError
): Record<string, unknown> {
  return {
    ...(error.details?.failureKind ? httpFailureDetails(undefined, error.details) : {}),
    ...(error.code === 'ENTERPRISE_SKILL_PACKAGE_INVALID' && typeof error.details?.packageValidationMessage === 'string'
      ? { packageValidationMessage: error.details.packageValidationMessage }
      : {}),
    ...(error.code === 'ENTERPRISE_SKILL_SOURCE_CONFLICT' && typeof error.details?.upstreamMessage === 'string'
      ? { upstreamMessage: error.details.upstreamMessage }
      : {}),
    stage: error.stage,
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
    ...(error.upstreamCode === undefined ? {} : { upstreamCode: error.upstreamCode }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs })
  };
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
  const transportFetch = input.fetch ?? globalThis.fetch;
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

  const responseContexts = new WeakMap<Response, Record<string, unknown>>();
  async function fetchImpl(url: URL, init: RequestInit, context: {
    timeoutMs: number; startedAt?: number; attempts?: number; maxAttempts?: number;
  }): Promise<Response> {
    const metadata = {
      requestMethod: init.method ?? 'GET', requestUrl: `${url.origin}${url.pathname}`,
      ...context, startedAt: context.startedAt ?? Date.now(),
      attempts: context.attempts ?? 1, maxAttempts: context.maxAttempts ?? 1
    };
    try {
      const response = await transportFetch(url, init);
      responseContexts.set(response, metadata);
      return response;
    } catch (error) {
      throw new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'request', undefined, undefined, undefined, undefined,
        httpFailureDetails(init.signal?.aborted ? init.signal.reason : error, {
          ...metadata, stage: 'request', durationMs: Math.max(0, Date.now() - metadata.startedAt)
        }));
    }
  }

  function responseDetails(response: Response, error: unknown, failureKind: 'response' | 'decode' | 'network') {
    const context = responseContexts.get(response) ?? {};
    return httpFailureDetails(error, {
      ...context, ...(failureKind === 'network' ? {} : { failureKind }), stage: failureKind === 'response' ? 'response' : 'decode', statusCode: response.status,
      durationMs: Math.max(0, Date.now() - Number(context.startedAt ?? Date.now()))
    });
  }

  async function responseError(response: Response, domain?: EnterpriseHttpDomain): Promise<EnterpriseHttpError> {
    const error = await createResponseError(response, domain);
    return new EnterpriseHttpError(error.code, error.stage, error.statusCode, error.upstreamCode, error.retryAfterMs, error.requestId,
      { ...responseDetails(response, undefined, 'response'), ...error.details });
  }

  async function readResponseJson(response: Response): Promise<unknown> {
    try { return await response.json(); }
    catch (error) {
      throw new EnterpriseHttpError(
        error instanceof SyntaxError ? 'ENTERPRISE_PROTOCOL_ERROR' : 'ENTERPRISE_SERVICE_UNAVAILABLE',
        'decode',
        error instanceof SyntaxError ? response.status : undefined, undefined, undefined, undefined,
        responseDetails(response, error, error instanceof SyntaxError ? 'decode' : 'network')
      );
    }
  }

  async function readResponseChunk(reader: ReadableStreamDefaultReader<Uint8Array>, response: Response) {
    try { return await reader.read(); }
    catch (error) {
      throw new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'download', undefined, undefined, undefined, undefined,
        { ...responseDetails(response, error, 'network'), stage: 'download' });
    }
  }

  async function requestJson<T>(request: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    accessToken?: string;
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    domain?: EnterpriseHttpDomain;
    retryTransportFailure?: boolean;
    emptyBody?: boolean;
    formBody?: FormData;
    timeoutMs?: number;
  }): Promise<T> {
    let response!: Response;
    const startedAt = Date.now();
    const maxAttempts = request.retryTransportFailure === true ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        response = await fetchImpl(new URL(request.path, origin), {
          body: request.formBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body)),
          headers: {
            ...jsonHeaders(request.accessToken, request.body !== undefined),
            ...(request.emptyBody === true ? { 'Content-Length': '0' } : {})
          },
          method: request.method,
          signal: AbortSignal.timeout(request.timeoutMs ?? jsonTimeoutMs)
        }, { timeoutMs: request.timeoutMs ?? jsonTimeoutMs, startedAt, attempts: attempt + 1, maxAttempts });
        break;
      } catch (error) {
        if (attempt + 1 < maxAttempts) {
          await waitForRetry(retryDelayMs);
          continue;
        }
        throw error;
      }
    }

    if (!response.ok) {
      throw await responseError(response, request.domain);
    }

    const value = await readResponseJson(response);

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
    const response = await fetchImpl(new URL(request.path, origin), {
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      headers: jsonHeaders(request.accessToken, request.body !== undefined),
      method: request.method,
      signal: AbortSignal.timeout(request.timeoutMs ?? jsonTimeoutMs)
    }, { timeoutMs: request.timeoutMs ?? jsonTimeoutMs });

    if (!response.ok) {
      throw await responseError(response, request.domain);
    }
  }

  function requestImage(accessToken: string, path: string, maxBytes: number): Promise<EnterprisePlatformBrandingImage>;
  function requestImage(accessToken: string, path: string, maxBytes: number, allowGeneratedSvg: true): Promise<EnterpriseSkillParticipantAvatarImage>;
  async function requestImage(
    accessToken: string,
    path: string,
    maxBytes: number,
    allowGeneratedSvg = false
  ): Promise<EnterpriseSkillParticipantAvatarImage> {
    const response = await fetchImpl(
      new URL(path, origin),
      {
        headers: jsonHeaders(accessToken, false),
        method: 'GET',
        signal: AbortSignal.timeout(jsonTimeoutMs)
      }, { timeoutMs: jsonTimeoutMs }
    );
    if (!response.ok) throw await responseError(response);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0];
    if (contentType !== 'image/png' && contentType !== 'image/jpeg' && !(allowGeneratedSvg && contentType === 'image/svg+xml')) {
      throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode', response.status);
    }
    const declaredSize = parseContentLength(response.headers.get('content-length'));
    if (declaredSize !== undefined && (declaredSize === 0 || declaredSize > maxBytes)) {
      throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode', response.status);
    }
    let content: Uint8Array;
    try { content = new Uint8Array(await response.arrayBuffer()); }
    catch (error) {
      throw new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'download', undefined, undefined, undefined, undefined,
        { ...responseDetails(response, error, 'network'), stage: 'download' });
    }
    if (content.byteLength === 0 || content.byteLength > maxBytes) {
      throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode', response.status);
    }
    return { content, contentType };
  }

  return {
    getSkillAIReviewRule(accessToken) {
      return requestJson({
        accessToken, method: 'GET', path: '/api/v1/app/skill-ai-review-rule',
        schema: z.object({ data: z.object({ text: z.string().min(1).max(1024 * 1024), version: z.string().min(1).max(128) }).strict().nullable() })
      }).then(response => response.data);
    },
    listSkillAIReviewTasks(accessToken) {
      return requestJson({
        accessToken, method: 'GET', path: '/api/v1/app/skill-ai-review-tasks',
        schema: z.object({ data: z.object({ tasks: z.array(skillAIReviewTaskSchema) }).strict() })
      }).then(response => response.data);
    },
    claimSkillAIReviewTask(accessToken, requestId, attemptId, rule) {
      return requestJson({
        accessToken, method: 'POST',
        path: `/api/v1/app/skill-ai-review-tasks/${encodeURIComponent(requestId)}/claim`,
        body: { attempt_id: attemptId, ...rule },
        schema: z.object({ data: skillAIReviewClaimSchema })
      }).then(response => response.data);
    },
    async submitSkillAIReviewResult(accessToken, requestId, result) {
      await requestJson({
        accessToken, method: 'POST',
        path: `/api/v1/app/skill-ai-review-tasks/${encodeURIComponent(requestId)}/result`,
        body: result, schema: z.object({ data: z.unknown() }).refine(response => Object.hasOwn(response, 'data'))
      });
    },
    approvalRequest(accessToken, method, path, body) {
      if (!/^\/api\/v1\/app\/approvals(?:\?|\/|$)/.test(path)) throw new Error('Invalid approval path');
      return requestJson({ accessToken, method, path, body, schema: approvalResponseSchema(method, path) });
    },
    workflowRequest(accessToken, method, path, body) {
      if (!path.startsWith('/api/v1/app/workflow-')) {
        throw new Error('Invalid workflow path');
      }
      return requestJson({
        accessToken, method, path, body,
        schema: workflowResponseSchema(method, path)
      }).then(response => ({ data: response.data, meta: response.meta }));
    },
    async uploadWorkflowFile(request) {
      const file = await openAsBlob(request.filePath, { type: request.contentType });
      if (file.size !== request.sizeBytes) throw new EnterpriseHttpError('ENTERPRISE_SHARED_FILE_LENGTH_MISMATCH', 'upload');
      const query = new URLSearchParams({ file_name: request.fileName, idempotency_key: request.idempotencyKey });
      const response = await fetchImpl(new URL(`/api/v1/app/workflow-tasks/${encodeURIComponent(request.taskId)}/files?${query}`, origin), {
        method: 'POST', body: file,
        headers: { Accept: 'application/json', Authorization: `Bearer ${request.accessToken}`, 'Content-Length': String(request.sizeBytes), 'Content-Type': request.contentType, 'X-Content-SHA256': request.sha256 },
        signal: AbortSignal.timeout(sharedFileTransferTimeoutMs)
      }, { timeoutMs: sharedFileTransferTimeoutMs });
      if (!response.ok) throw await responseError(response, 'shared-file');
      const raw = await readResponseJson(response);
      const parsed = z.object({ data: workflowArtifactSchema }).safeParse(raw);
      if (!parsed.success) throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode');
      return parsed.data.data;
    },
    async register(request, agentId) {
      await requestWithoutResult({
        body: {
          ...(request.phone === undefined ? { email: request.email } : { phone: request.phone }),
          ...(request.name === undefined ? {} : { name: request.name }),
          password: request.password,
          client_id: 'clawee-agent',
          agent_id: agentId,
          account_scoped_agent: true
        },
        method: 'POST',
        path: '/api/v1/auth/register'
      });
    },

    async login(request, agentId) {
      const response = await requestJson({
        body: {
          ...(request.phone === undefined ? { email: request.email } : { phone: request.phone }),
          password: request.password,
          client_id: 'clawee-agent',
          agent_id: agentId,
          account_scoped_agent: true
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
        state: request.state,
        account_scoped_agent: 'true'
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
          account_scoped_agent: true,
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
          agent_id: agentId,
          account_scoped_agent: true
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
      const query = new URLSearchParams({ agent_id: agentId, account_scoped_agent: 'true' });
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

    async renewSession(accessToken) {
      const response = await requestJson({
        accessToken,
        method: 'POST',
        path: '/api/v1/auth/session/renew',
        schema: sessionRenewalResponseSchema
      });
      return { accessToken: response.data.access_token, expiresAt: response.data.expires_at };
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
        ...(response.data.session_id === undefined ? {} : { sessionId: response.data.session_id }),
        account: accountSummary(response.data.account),
        agentId: response.data.agent.agent_id,
        status: response.data.account.status,
        frontendAllowed: response.data.applications.frontend,
        ...(response.data.applications.admin === true ? { adminAllowed: true } : {}),
        externalFeedbackAllowed: response.data.external_feedback_allowed,
        activityReportingEnabled:
          response.data.agent_activity_reporting_enabled
      };
    },

    async getAgentPromptPolicy(accessToken) {
      const response = await requestJson({
        accessToken,
        method: 'GET',
        path: '/api/v1/app/agent-prompt-policy',
        schema: z.object({
          data: z.object({
            version: z.number().int().nonnegative(),
            server_agent_prompt: z.string(),
            clawee_agent_prompt: z.string(),
            updated_at: z.string().datetime({ offset: true })
          }).strict()
        }).strict()
      });
      return {
        version: response.data.version,
        serverAgentPrompt: response.data.server_agent_prompt,
        claweeAgentPrompt: response.data.clawee_agent_prompt,
        updatedAt: response.data.updated_at
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
        ...(response.data.admin_url ? { adminUrl: response.data.admin_url } : {}),
        ...(response.data.accent_color ? { accentColor: response.data.accent_color } : {}),
        sidebarLogoConfigured: response.data.sidebar_logo_configured,
        sidebarCompactLogoConfigured: response.data.sidebar_compact_logo_configured,
        sidebarLogoDarkConfigured: response.data.sidebar_logo_dark_configured ?? false,
        sidebarCompactLogoDarkConfigured: response.data.sidebar_compact_logo_dark_configured ?? false,
        ...(response.data.sidebar_menu_labels === undefined
          ? {}
          : { sidebarMenuLabels: response.data.sidebar_menu_labels })
      };
    },

    getPlatformBrandingImage(accessToken, kind) {
      return requestImage(accessToken, `/api/v1/app/platform-branding/${kind}`, 1024 * 1024);
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

    async listSkillSpaces(accessToken) {
      const response = await requestJson({
        accessToken, domain: 'skill', method: 'GET',
        path: '/api/v1/app/skill-spaces', schema: skillSpaceListResponseSchema
      });
      return { spaces: response.data.map(space => ({
        spaceId: space.space_id, name: space.name, description: space.description, actions: space.actions
      })) };
    },

    async uploadSkillVersion(request) {
      const formBody = new FormData();
      if (request.skillId) formBody.append('skill_id', request.skillId);
      formBody.append('space_id', request.spaceId);
      formBody.append('version', request.version);
      if (request.changelog) formBody.append('changelog', request.changelog);
      formBody.append('package', new Blob([new Uint8Array(request.package).buffer], { type: 'application/zip' }), 'skill.zip');
      const response = await requestJson({
        accessToken: request.accessToken, domain: 'skill-upload', method: 'POST',
        path: '/api/v1/app/skills/versions', formBody,
        timeoutMs: documentUploadTimeoutMs, schema: skillUploadResponseSchema
      });
      return { skillId: response.data.skill.skill_id, spaceId: response.data.skill.space_id, name: response.data.skill.name, version: response.data.version.version,
        ...(response.data.approval_request_id ? { approvalRequestId: response.data.approval_request_id, approvalURL: new URL(`/app/approvals/skill/${encodeURIComponent(response.data.approval_request_id)}`, origin).href } : {}) };
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

    async getCloudSkills(accessToken) {
      const response = await requestJson({
        accessToken,
        domain: 'skill',
        method: 'GET',
        path: '/api/v1/app/cloud-skills',
        schema: cloudSkillListResponseSchema
      });
      return {
        agentEmail: response.data.agent_email,
        agentName: response.data.agent_name,
        promptTemplate: response.data.prompt_template,
        skills: response.data.skills.map(skill => ({
          skillId: skill.skill_id,
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          version: skill.version,
          updatedAt: skill.updated_at
        }))
      };
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

    getSkillParticipantAvatar(accessToken, skillId, userId) {
      const query = new URLSearchParams({ skill_id: skillId, user_id: userId });
      return requestImage(accessToken, `/api/v1/app/skills/participant-avatar?${query.toString()}`, 2 * 1024 * 1024, true);
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

      const response = await fetchImpl(
        new URL('/api/v1/app/knowledge-bases/documents', origin),
        {
          body: form,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${request.accessToken}`
          },
          method: 'POST',
          signal: AbortSignal.timeout(documentUploadTimeoutMs)
        }, { timeoutMs: documentUploadTimeoutMs }
      );

      if (!response.ok) {
        throw await responseError(response, 'knowledge');
      }

      const value = await readResponseJson(response);
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

    async getSharedFilePreview(accessToken, fileId, signal) {
      const query = new URLSearchParams({ file_id: fileId, preview: '1' });
      const timeout = AbortSignal.timeout(30_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetchImpl(new URL(`/api/v1/app/shared-files/content?${query}`, origin), {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: requestSignal
        }, { timeoutMs: 30_000 });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
      if (!response.ok) throw await responseError(response, 'shared-file');
      const contentType = response.headers.get('content-type') ?? '';
      const mime = contentType.split(';', 1)[0] ?? '';
      if (!['text/plain', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) || !response.body) {
        await response.body?.cancel();
        throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode', response.status);
      }
      const limit = mime === 'text/plain' ? 1024 * 1024 : 20 * 1024 * 1024;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const result = await readResponseChunk(reader, response);
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > limit) {
            throw new EnterpriseHttpError('ENTERPRISE_SHARED_FILE_TOO_LARGE', 'download', 413);
          }
          chunks.push(result.value);
        }
        return { content: Buffer.concat(chunks), contentType };
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof EnterpriseHttpError) throw error;
        throw new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'download', undefined, undefined, undefined, undefined,
          { ...responseDetails(response, error, 'network'), stage: 'download' });
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },

    async downloadSharedFileContent(request) {
      const query = new URLSearchParams({ file_id: request.fileId });
      const response = await fetchImpl(
        new URL(`/api/v1/app/shared-files/content?${query.toString()}`, origin),
        {
          headers: {
            Accept: 'application/octet-stream',
            Authorization: `Bearer ${request.accessToken}`
          },
          method: 'GET',
          signal: AbortSignal.timeout(sharedFileTransferTimeoutMs)
        }, { timeoutMs: sharedFileTransferTimeoutMs }
      );

      if (!response.ok) {
        throw await responseError(response, 'shared-file');
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
          const result = await readResponseChunk(reader, response);
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
        ...(request.spaceId ? { space_id: request.spaceId } : {}),
        logical_path: request.logicalPath
      });
      if (request.forUserId !== undefined) query.set('for_user_id', request.forUserId);
      if (request.expectedRevision !== undefined) {
        query.set('expected_revision', String(request.expectedRevision));
      }

      const response = await fetchImpl(
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
        }, { timeoutMs: sharedFileTransferTimeoutMs }
      );
      if (!response.ok) {
        throw await responseError(response, 'shared-file');
      }

      const value = await readResponseJson(response);
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

    async hasSkillContributionGrant(accessToken) {
      const response = await requestJson({ accessToken, domain: 'activity', method: 'GET', path: '/api/v1/app/data-views', schema: activityDataViewsResponseSchema });
      return response.data.some(view => view.view_id === 'skill_contributions' && view.actions.includes('read'));
    },

    async getSkillContributions(accessToken, endpoint, query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      const response = await requestJson({ accessToken, domain: 'activity', method: 'GET', path: `/api/v1/app/skill-contributions/${endpoint}?${params}`, schema: contributionResponseSchema(endpoint) });
      return response.data as SkillContributionResponse;
    },

    async exportSkillContributions(accessToken, query) {
      const response = await fetchImpl(new URL('/api/v1/app/skill-contributions/export', origin), {
        method: 'POST', headers: jsonHeaders(accessToken, true), body: JSON.stringify(query), signal: AbortSignal.timeout(downloadTimeoutMs)
      }, { timeoutMs: downloadTimeoutMs });
      if (!response.ok) throw await responseError(response, 'activity');
      if (!response.headers.get('content-type')?.startsWith('text/csv') || response.body === null) throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await readResponseChunk(reader, response);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'download'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const content = '\uFEFF' + new TextDecoder().decode(Buffer.concat(chunks));
      const rowCount = Number(response.headers.get('x-result-count'));
      if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > 10000) throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode');
      return { content, filename: 'skill-contributions.csv', rowCount };
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

    async getActivityRuntime(accessToken) {
      const response = await requestJson({
        accessToken, domain: 'activity', method: 'GET',
        path: '/api/v1/app/activity/runtime',
        schema: activityRuntimeResponseSchema
      });
      const runtime = 'data' in response ? response.data : response;
      return {
        schemaVersion: runtime.schema_version, scope: runtime.scope, serverTime: runtime.server_time,
        summary: {
          totalAgents: runtime.summary.total_agents, onlineAgents: runtime.summary.online_agents,
          workingAgents: runtime.summary.working_agents, blockedAgents: runtime.summary.blocked_agents,
          errorAgents: runtime.summary.error_agents
        },
        agents: runtime.agents.map(agent => ({
          collectorId: agent.collector_id, agentId: agent.agent_id, status: agent.status,
          ...optionalField('currentTask', agent.current_task), lastSeenAt: agent.last_seen_at
        }))
      };
    },

    async getActivityDetail(accessToken, collectorId, agentId, range) {
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
      if (range !== undefined) {
        query.set('range', range);
        try {
          const { data: usage } = await requestJson({
            accessToken, domain: 'activity', method: 'GET',
            path: `/api/v1/app/activity/agent-usage?${query.toString()}`,
            schema: activityAgentUsageResponseSchema
          });
          if (usage.collector_id !== collectorId || usage.agent_id !== agentId || usage.range !== range
            || usage.granularity !== (range === 'today' ? 'hour' : 'day')) {
            throw new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode', 200);
          }
          detail.usage = {
            collectorId, agentId, range, timezone: usage.timezone, startDate: usage.start_date,
            endDate: usage.end_date, generatedAt: usage.generated_at,
            sessionCount: usage.session_count, turnCount: usage.turn_count,
            completedTurns: usage.completed_turns, toolCallCount: usage.tool_call_count,
            granularity: usage.granularity,
            points: usage.points.map(point => ({ bucketStart: point.bucket_start,
              sessionCount: point.session_count, turnCount: point.turn_count,
              completedTurns: point.completed_turns, toolCallCount: point.tool_call_count })),
            mcpDistribution: usage.mcp_distribution.map(item => ({ id: item.id, label: item.label,
              invocationCount: item.invocation_count, share: item.share })),
            mcpStatus: usage.mcp_status,
            skillUsage: usage.skill_usage.map(item => ({ skillId: item.skill_id, skillName: item.skill_name,
              skillKey: item.skill_key, source: item.source, requestedRuns: item.requested_runs,
              observedRuns: item.observed_runs, implicitRuns: item.implicit_runs })),
            skillUsageTotals: { requestedSkillRuns: usage.skill_usage_totals.requested_skill_runs,
              observedSkillRuns: usage.skill_usage_totals.observed_skill_runs,
              explicitSkillRuns: usage.skill_usage_totals.explicit_skill_runs,
              implicitSkillRuns: usage.skill_usage_totals.implicit_skill_runs }
          };
        } catch (error) {
          // Older gateways and temporarily unavailable statistics must not hide execution history.
          if (!(error instanceof EnterpriseHttpError)
            || (error.stage !== 'request' && ![404, 502, 503, 504].includes(error.statusCode ?? 0))) throw error;
        }
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

    async getBilibiliDashboard(accessToken, input = {}) {
      const range = input.range ?? '7d';
      const sourcesResponse = await requestJson({
        accessToken,
        domain: 'business-data',
        method: 'GET',
        path: '/api/v1/app/business-data-sources/bilibili',
        schema: bilibiliSourcesResponseSchema
      });
      const sources = sourcesResponse.data.items;
      const mappedSources = sources.map(item => ({
        sourceId: item.source_id,
        name: item.name || item.source_id,
        status: item.status,
        statusReason: item.status_reason ?? '',
        ...(item.last_attempt_at ? { lastAttemptAt: item.last_attempt_at } : {}),
        ...(item.last_success_at ? { lastSuccessAt: item.last_success_at } : {}),
        ...(item.next_sync_at ? { nextSyncAt: item.next_sync_at } : {}),
        ...(item.active_run_status ? { activeRunStatus: item.active_run_status } : {})
      }));
      const source = input.sourceId === undefined
        ? sources.find(item => item.status === 'active') ?? sources[0]
        : sources.find(item => item.source_id === input.sourceId);
      if (source === undefined) return {
        status: 'unconfigured',
        range,
        unavailableParts: [],
        sources: mappedSources
      };
      const query = new URLSearchParams({
        range,
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
        ...(dashboard.account === undefined ? {} : {
          account: {
            sourceId: dashboard.account.source_id,
            name: dashboard.account.name,
            status: dashboard.account.status,
            statusReason: dashboard.account.status_reason,
            ...(dashboard.account.last_success_at ? { lastSuccessAt: dashboard.account.last_success_at } : {})
          }
        }),
        range: dashboard.range ?? range,
        ...(dashboard.timezone === undefined ? {} : { timezone: dashboard.timezone }),
        ...(dashboard.start_date === undefined ? {} : { startDate: dashboard.start_date }),
        ...(dashboard.end_date === undefined ? {} : { endDate: dashboard.end_date }),
        ...(dashboard.generated_at === undefined ? {} : { generatedAt: dashboard.generated_at }),
        ...(dashboard.last_synced_at ? { lastSyncedAt: dashboard.last_synced_at } : {}),
        unavailableParts: dashboard.unavailable_parts ?? [],
        sources: mappedSources,
        ...(dashboard.data === undefined ? {} : {
          data: {
            capturedAt: dashboard.data.captured_at,
            followerCount: dashboard.data.follower_count,
            ...(dashboard.data.following_count === undefined ? {} : { followingCount: dashboard.data.following_count }),
            ...(dashboard.data.published_count === undefined ? {} : { publishedCount: dashboard.data.published_count }),
            collectedContentCount: dashboard.data.collected_content_count,
            viewCount: dashboard.data.view_count,
            ...(dashboard.data.danmaku_count === undefined ? {} : { danmakuCount: dashboard.data.danmaku_count }),
            ...(dashboard.data.reply_count === undefined ? {} : { replyCount: dashboard.data.reply_count }),
            ...(dashboard.data.favorite_count === undefined ? {} : { favoriteCount: dashboard.data.favorite_count }),
            ...(dashboard.data.coin_count === undefined ? {} : { coinCount: dashboard.data.coin_count }),
            ...(dashboard.data.share_count === undefined ? {} : { shareCount: dashboard.data.share_count }),
            ...(dashboard.data.like_count === undefined ? {} : { likeCount: dashboard.data.like_count }),
            interactionCount: dashboard.data.interaction_count,
            trend: (dashboard.data.trend ?? []).map(point => ({
              date: point.date,
              followerCount: point.follower_count,
              viewCount: point.view_count,
              interactionCount: point.interaction_count,
              followerCountDelta: point.follower_count_delta,
              viewCountDelta: point.view_count_delta,
              interactionCountDelta: point.interaction_count_delta
            })),
            topContents: dashboard.data.top_contents.map(item => ({
              sourceId: item.source_id ?? '',
              accountName: item.account_name ?? '',
              externalContentId: item.external_content_id,
              title: item.title,
              ...(item.published_at ? { publishedAt: item.published_at } : {}),
              status: item.status ?? '',
              capturedAt: item.captured_at,
              viewCount: item.view_count,
              ...(item.danmaku_count === undefined ? {} : { danmakuCount: item.danmaku_count }),
              ...(item.reply_count === undefined ? {} : { replyCount: item.reply_count }),
              ...(item.favorite_count === undefined ? {} : { favoriteCount: item.favorite_count }),
              ...(item.coin_count === undefined ? {} : { coinCount: item.coin_count }),
              ...(item.share_count === undefined ? {} : { shareCount: item.share_count }),
              ...(item.like_count === undefined ? {} : { likeCount: item.like_count }),
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

    downloadSkillPackage(request) {
      const query = new URLSearchParams({
        skill_id: request.skillId,
        version_id: request.versionId
      });
      return downloadPackage({
        accessToken: request.accessToken,
        expectedSha256: request.expectedSha256,
        destinationPath: request.destinationPath,
        path: `/api/v1/app/skills/package?${query.toString()}`
      });
    },

    downloadApprovalPackage(request) {
      return downloadPackage({
        accessToken: request.accessToken,
        expectedSha256: request.expectedSha256,
        destinationPath: request.destinationPath,
        path: `/api/v1/app/approvals/skill/${encodeURIComponent(request.requestId)}/package`
      });
    }
  };

  async function downloadPackage(request: {
    accessToken: string;
    expectedSha256: string;
    destinationPath: string;
    path: string;
  }): Promise<{ bytes: number; sha256: string }> {
      const response = await fetchImpl(
        new URL(request.path, origin),
        {
          headers: {
            Accept: 'application/zip',
            Authorization: `Bearer ${request.accessToken}`
          },
          method: 'GET',
          signal: AbortSignal.timeout(downloadTimeoutMs)
        }, { timeoutMs: downloadTimeoutMs }
      );

      if (!response.ok) {
        throw await responseError(response, 'skill');
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
          const result = await readResponseChunk(reader, response);
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
    ...(account.phone ? { phone: account.phone } : {}),
    name: account.name,
    ...(account.avatar_url === undefined ? {} : { avatarUrl: account.avatar_url })
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
    updatedAt: skill.updated_at,
    ...(skill.space_id === undefined ? {} : { spaceId: skill.space_id }),
    ...(skill.space_name === undefined ? {} : { spaceName: skill.space_name }),
    ...(skill.creator === undefined ? {} : {
      creator: {
        ...(skill.creator.user_id === undefined ? {} : { userId: skill.creator.user_id }),
        name: skill.creator.name,
        ...(skill.creator.avatar_url === undefined ? {} : { avatarUrl: skill.creator.avatar_url })
      }
    }),
    ...(skill.contributors === undefined ? {} : {
      contributors: skill.contributors.map(item => ({
        userId: item.user_id,
        name: item.name,
        ...(item.avatar_url === undefined ? {} : { avatarUrl: item.avatar_url })
      }))
    })
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
    ...(space.personal_owner_user_id ? { personalOwnerUserId: space.personal_owner_user_id } : {}),
    ...(space.workflow_template_name ? { workflowTemplateName: space.workflow_template_name } : {}),
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
      ...(statistics.organization.platform_activity === undefined ? {} : {
        platformActivity: {
          activeUsers: statistics.organization.platform_activity.active_users,
          totalUsers: statistics.organization.platform_activity.total_users,
          rate: statistics.organization.platform_activity.rate
        }
      }),
      mcpDistribution: statistics.organization.mcp_distribution.map(item => ({
        id: item.id,
        label: item.label,
        invocationCount: item.invocation_count,
        share: item.share
      })),
      ...(statistics.organization.skill_usage === undefined ? {} : {
        skillUsage: statistics.organization.skill_usage.map(item => ({
          skillId: item.skill_id, skillName: item.skill_name, skillKey: item.skill_key, source: item.source,
          requestedRuns: item.requested_runs, observedRuns: item.observed_runs, implicitRuns: item.implicit_runs
        }))
      }),
      ...(statistics.organization.skill_usage_totals === undefined ? {} : {
        skillUsageTotals: {
          requestedSkillRuns: statistics.organization.skill_usage_totals.requested_skill_runs,
          observedSkillRuns: statistics.organization.skill_usage_totals.observed_skill_runs,
          explicitSkillRuns: statistics.organization.skill_usage_totals.explicit_skill_runs,
          implicitSkillRuns: statistics.organization.skill_usage_totals.implicit_skill_runs
        }
      })
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
      ...optionalField('employeeId', agent.employee_id),
      ...optionalField('employeeName', agent.employee_name),
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
  | 'skill-upload'
  | 'knowledge'
  | 'shared-file'
  | 'mcp'
  | 'mcp-token';

async function createResponseError(
  response: Response,
  domain: EnterpriseHttpDomain = 'general'
): Promise<EnterpriseHttpError> {
  let upstreamCode: string | undefined;
  let requestId = safeIncidentIdentifier(response.headers.get('x-request-id'));
  let responseReadError: unknown;
  let details: Record<string, unknown> | undefined;
  try {
    const value: unknown = await response.json();
    if (isPlainObject(value)) {
      let upstreamMessage: string | undefined;
      if (isPlainObject(value.error)) {
        if (typeof value.error.code === 'string') upstreamCode = value.error.code;
        if (typeof value.error.request_id === 'string') {
          requestId = safeIncidentIdentifier(value.error.request_id) ?? requestId;
        }
        if (typeof value.error.message === 'string') upstreamMessage = value.error.message;
        details = domain === 'activity' || domain === 'billing' || domain === 'business-data'
          ? undefined
          : mapUpstreamErrorDetails(upstreamCode, value.error.details);
      } else if (
        domain === 'skill-upload'
        && typeof value.code === 'string'
        && typeof value.error === 'string'
      ) {
        upstreamCode = value.code;
        upstreamMessage = value.error;
      }
      const mappedCode = mapResponseCode(response.status, upstreamCode, domain);
      if (domain === 'skill-upload'
        && mappedCode === 'ENTERPRISE_SKILL_PACKAGE_INVALID'
        && upstreamMessage !== undefined) {
        const message = upstreamMessage.trim();
        if (message) details = { ...details, packageValidationMessage: message };
      }
      if (domain === 'skill-upload'
        && mappedCode === 'ENTERPRISE_SKILL_SOURCE_CONFLICT'
        && upstreamMessage !== undefined) {
        const message = upstreamMessage.trim();
        if (message) details = { ...details, upstreamMessage: message };
      }
    }
  } catch (error) {
    responseReadError = error;
  }

  return new EnterpriseHttpError(
    mapResponseCode(response.status, upstreamCode, domain),
    'response',
    response.status,
    upstreamCode,
    parseRetryAfter(response.headers.get('retry-after')),
    requestId,
    { ...details, ...httpFailureDetails(responseReadError, { failureKind: 'response', stage: 'response', statusCode: response.status, upstreamCode, requestId }) }
  );
}

function mapResponseCode(
  statusCode: number,
  upstreamCode: string | undefined,
  domain: EnterpriseHttpDomain
): RuntimeErrorCode {
  if (domain === 'shared-file' && statusCode === 415 && upstreamCode === 'preview_not_supported') return 'ENTERPRISE_INVALID_REQUEST';
  if (domain === 'skill-upload' && statusCode === 400 && upstreamCode === 'package_invalid') return 'ENTERPRISE_SKILL_PACKAGE_INVALID';
  if (statusCode === 400) return 'ENTERPRISE_INVALID_REQUEST';
  if (statusCode === 401) return 'ENTERPRISE_UNAUTHORIZED';
  if (domain === 'skill-upload' && statusCode === 409) return 'ENTERPRISE_SKILL_SOURCE_CONFLICT';
  if (domain === 'skill-upload' && statusCode === 422) return 'ENTERPRISE_SKILL_PACKAGE_INVALID';
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
