export type EnterpriseWorkflowNode = {
  node_id: string;
  order: number;
  type: 'agent' | 'approval';
  title: string;
  assignee_user_id?: string;
  assignee_user_ids?: string[];
  assignee_role_ids?: string[];
  assignee_initiator?: boolean;
  resolved_user_ids?: string[];
  instruction: string;
};

export type EnterpriseWorkflowTemplate = {
  shared_space_id?: string;
  id: string;
  name: string;
  description: string;
  status: string;
  revision: number;
  nodes: EnterpriseWorkflowNode[];
  user_names?: Record<string, string>;
};

export type EnterpriseWorkflowArtifact = {
  file_id: string;
  logical_path: string;
  revision: number;
  sha256: string;
  file_name?: string;
  content_type?: string;
  size_bytes?: number;
};

export type EnterpriseWorkflowSharedContext = {
  shared_space_id?: string;
  instance_path_prefix?: string;
  node_path_prefix?: string;
  upstream_artifacts?: EnterpriseWorkflowArtifact[];
};

export type EnterpriseWorkflowTask = EnterpriseWorkflowSharedContext & {
  artifacts?: EnterpriseWorkflowArtifact[];
  task_id: string;
  instance_id: string;
  node_id: string;
  node_order?: number;
  type: 'agent' | 'approval';
  status: string;
  assignee_user_id?: string;
  assignee_user_ids?: string[];
  instruction: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  decision?: string;
  comment?: string;
  handled_by?: string;
  completed_at?: string | null;
};

export type EnterpriseWorkflowInstance = EnterpriseWorkflowSharedContext & {
  id: string;
  template_id: string;
  template_revision?: number;
  status: string;
  current_node_id?: string;
  nodes: EnterpriseWorkflowNode[];
  tasks?: EnterpriseWorkflowTask[];
  user_names?: Record<string, string>;
  started_by?: string;
  started_at: string;
  ended_at?: string | null;
};

export type EnterpriseWorkflowCompletion = {
  handledBy: string;
  handledByName?: string;
};

export type EnterpriseWorkflowDeliveryFile = {
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  selected: boolean;
};

export type EnterpriseWorkflowDelivery = {
  text: string;
  edited: boolean;
  version: number;
  sourceRunId: string;
  latestText: string;
  files: EnterpriseWorkflowDeliveryFile[];
  locked: boolean;
};

export type EnterpriseWorkflowExecution = {
  status: string;
  runId?: string;
  threadId?: string;
  runStatus?: string;
  completion?: EnterpriseWorkflowCompletion;
  delivery?: EnterpriseWorkflowDelivery;
};

export type EnterpriseWorkflowDraftUpdate = {
  version: number;
  text?: string;
  useLatest?: boolean;
  selectedPaths?: string[];
};

export type EnterpriseWorkflowNextTask = Omit<EnterpriseWorkflowTask, 'input'> & { input: Record<string, unknown> | null };

export type EnterpriseWorkflowResult = EnterpriseWorkflowSharedContext & { instance_id: string; task_id: string; status: string; next_task?: EnterpriseWorkflowNextTask };

export function workflowTaskCandidates(task: Pick<EnterpriseWorkflowTask, 'assignee_user_id' | 'assignee_user_ids'>): string[] {
  return [...new Set(task.assignee_user_ids ?? (task.assignee_user_id ? [task.assignee_user_id] : []))];
}

export function workflowNodeCandidates(node: EnterpriseWorkflowNode): string[] {
  return [...new Set(node.resolved_user_ids ?? [...(node.assignee_user_ids ?? []), ...(node.assignee_user_id ? [node.assignee_user_id] : [])])];
}
