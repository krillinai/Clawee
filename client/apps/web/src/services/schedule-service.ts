import type {
  CreateScheduleRequest,
  CreateWorkflowScheduleRequest,
  RunScheduleNowRequest,
  RunScheduleNowResponse,
  ScheduleDetailResponse,
  ScheduleListResponse,
  ScheduleOperationListResponse,
  ScheduleResponse,
  UpdateScheduleRequest,
  UpdateWorkflowScheduleRequest
} from '@clawee/protocol';
import type { RuntimeClient } from '../runtime/client.js';

export function createScheduleService(client: RuntimeClient) {
  return {
    listSchedules(workflowOnly = false): Promise<ScheduleListResponse> {
      return client.get(workflowOnly ? '/schedules?action=workflow_start' : '/schedules');
    },
    getSchedule(id: string): Promise<ScheduleDetailResponse> {
      return client.get(`/schedules/${encodeURIComponent(id)}`);
    },
    createSchedule(input: CreateScheduleRequest): Promise<ScheduleResponse> {
      return client.post('/schedules', input);
    },
    createWorkflowSchedule(input: CreateWorkflowScheduleRequest): Promise<ScheduleResponse> {
      return client.post('/schedules', input);
    },
    updateSchedule(id: string, input: UpdateScheduleRequest | UpdateWorkflowScheduleRequest): Promise<ScheduleResponse> {
      return client.patch(`/schedules/${encodeURIComponent(id)}`, input);
    },
    deleteSchedule(id: string): Promise<{ deleted: true }> {
      return client.delete(`/schedules/${encodeURIComponent(id)}`);
    },
    runNow(id: string, input?: RunScheduleNowRequest): Promise<RunScheduleNowResponse> {
      const path = `/schedules/${encodeURIComponent(id)}/run-now`;
      return input === undefined ? client.post(path) : client.post(path, input);
    },
    listOperations(id: string, limit = 50): Promise<ScheduleOperationListResponse> {
      return client.get(
        `/schedules/${encodeURIComponent(id)}/operations?limit=${limit}`
      );
    }
  };
}
