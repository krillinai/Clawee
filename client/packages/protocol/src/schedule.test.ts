import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  CreateScheduleRequest, CreateWorkflowScheduleRequest, RunScheduleNowRequest,
  RunScheduleNowResponse, ScheduleAction, ScheduleOperationResponse, ScheduleResponse,
  UpdateWorkflowScheduleRequest, WorkflowScheduleConfiguration
} from './api.js';

describe('定时计划公共契约', () => {
  it('旧 Agent 创建请求保持兼容且动作只能是 agent_run', () => {
    const legacy: CreateScheduleRequest = { name: '旧计划', cron: '0 9 * * *', prompt: '执行任务' };
    expect(legacy.action).toBeUndefined();
    expectTypeOf<CreateScheduleRequest['action']>().toEqualTypeOf<'agent_run' | undefined>();
    expectTypeOf<ScheduleAction>().toEqualTypeOf<'agent_run' | 'workflow_start'>();
  });
  it('工作流动作仅要求模板、输入及本地调度参数', () => {
    expectTypeOf<CreateWorkflowScheduleRequest>().toEqualTypeOf<{
      action: 'workflow_start'; name: string; cron: string; timezone?: string; enabled?: boolean;
      requestId?: string;
      workflow: WorkflowScheduleConfiguration;
    }>();
    expectTypeOf<UpdateWorkflowScheduleRequest>().toEqualTypeOf<Partial<Omit<CreateWorkflowScheduleRequest, 'requestId'>>>();
    expectTypeOf<UpdateWorkflowScheduleRequest>().not.toHaveProperty('requestId');
  });
  it('无 Agent 会话必须使用真实 null，归属不属于公开字段', () => {
    expectTypeOf<ScheduleResponse['threadId']>().toEqualTypeOf<string | null>();
    expectTypeOf<ScheduleResponse>().not.toHaveProperty('owner');
    expectTypeOf<ScheduleResponse>().not.toHaveProperty('requestId');
    expectTypeOf<ScheduleResponse>().not.toHaveProperty('createFingerprint');
    expectTypeOf<ScheduleResponse['workflow']>().toEqualTypeOf<WorkflowScheduleConfiguration | undefined>();
    expectTypeOf<ScheduleResponse['lastWorkflowInstanceId']>().toEqualTypeOf<string | null | undefined>();
  });
  it('原触发重试请求及响应保留普通运行兼容字段', () => {
    expectTypeOf<RunScheduleNowRequest>().toEqualTypeOf<{ triggerId?: string }>();
    expectTypeOf<RunScheduleNowResponse['triggerId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<RunScheduleNowResponse['workflowInstanceId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<RunScheduleNowResponse['run']>().toBeNullable();
    expectTypeOf<RunScheduleNowResponse['skipped']>().toEqualTypeOf<boolean>();
    expectTypeOf<RunScheduleNowResponse['queued']>().toEqualTypeOf<boolean>();
  });
  it('操作记录支持触发与实例关系，不伪造 runId', () => {
    expectTypeOf<ScheduleOperationResponse['triggerId']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ScheduleOperationResponse['workflowInstanceId']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ScheduleOperationResponse['runId']>().toEqualTypeOf<string | null | undefined>();
  });
});
