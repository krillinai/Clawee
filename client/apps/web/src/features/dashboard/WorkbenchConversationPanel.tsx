import type { ThreadResponse } from '@clawee/protocol';
import { MessageSquareText } from 'lucide-react';
import { Timeline } from '../../components/timeline/Timeline.js';
import { ApprovalPanel } from '../approvals/ApprovalPanel.js';
import { Composer } from '../runs/Composer.js';
import { useWorkbenchConversation, type WorkbenchConversationRuntime } from './use-workbench-conversation.js';
import type { WorkbenchModuleContext } from './workbench-module-context.js';

export function WorkbenchConversationPanel(props: {
  runtime?: WorkbenchConversationRuntime;
  context: WorkbenchModuleContext;
  threadId?: string;
  onThreadCreated(thread: ThreadResponse): void;
}) {
  const conversation = useWorkbenchConversation(props);
  return <WorkbenchConversationView runtime={props.runtime} context={props.context} conversation={conversation} />;
}

export function WorkbenchConversationView(props: {
  runtime?: WorkbenchConversationRuntime;
  context: WorkbenchModuleContext;
  conversation: ReturnType<typeof useWorkbenchConversation>;
}) {
  const conversation = props.conversation;
  const config = props.runtime?.config;
  const pendingApproval = conversation.items.find(item => item.kind === 'approval' && item.approval.status === 'pending');
  return <aside className="workbench-conversation-panel" aria-label="模块对话">
    <header className="workbench-conversation-header">
      <h2><MessageSquareText size={16} aria-hidden="true" />模块对话</h2>
      <p>{props.context.summary}</p>
      <span>发送时会将当前模块资料提供给已配置的模型。</span>
      {props.context.partial ? <small>当前为部分数据，分析会注明缺失项。</small> : null}
      {conversation.running && conversation.runContextSummary !== undefined
        ? <small role="status">正在分析：{conversation.runContextSummary}</small> : null}
    </header>
    <div className="workbench-conversation-messages">
      {conversation.items.length === 0 ? <div className="workbench-conversation-empty">
        <strong>围绕当前模块提问</strong>
        <p>{props.context.unavailableReason ?? '例如：分析增长趋势，找出表现最好的稿件。'}</p>
      </div> : <Timeline items={conversation.items} hasMore={conversation.history.hasMore}
        loadingOlder={conversation.history.loadingOlder} onLoadOlder={conversation.history.loadOlder}
        resolvingApprovalIds={conversation.resolvingApprovalIds} approvalErrors={conversation.approvalErrors}
        onApproveApproval={id => void conversation.resolveApproval(id, 'approve')}
        onRejectApproval={id => void conversation.resolveApproval(id, 'reject')} />}
    </div>
    <div className="workbench-conversation-composer">
      {conversation.projectUnavailable ? <div className="workbench-conversation-error" role="alert">
        <p>{conversation.error ?? '当前项目目录不存在或不可访问。'}</p>
        <p className="workbench-conversation-project-path">{props.runtime?.project?.cwd}</p>
        {props.runtime?.onUseDefaultProject === undefined ? <p>请返回工作台，在项目管理中更换有效目录。</p>
          : <button onClick={() => void conversation.useDefaultProject()} disabled={conversation.projectRecoveryDisabled} type="button">
            {conversation.repairingProject ? '正在准备默认项目' : '使用默认项目'}
          </button>}
      </div> : conversation.error === undefined ? null : <div className="workbench-conversation-error" role="alert">
        <p>{conversation.error}</p><button onClick={conversation.retry} type="button">重试连接</button>
      </div>}
      {pendingApproval?.kind === 'approval' ? <ApprovalPanel approval={pendingApproval.approval}
        resolving={conversation.resolvingApprovalIds.has(pendingApproval.approval.id)}
        error={conversation.approvalErrors[pendingApproval.approval.id]}
        onApprove={id => void conversation.resolveApproval(id, 'approve')}
        onReject={id => void conversation.resolveApproval(id, 'reject')} /> : null}
      <Composer projectId={props.runtime?.project?.id ?? ''} projectName={props.runtime?.project?.name ?? '当前项目'}
        projects={props.runtime?.project === undefined ? [] : [props.runtime.project]} showProjectSelector={false}
        permission="workspace-write" readOnly profile={config?.profile ?? 'default'} model={config?.model ?? null}
        reasoning={config?.reasoning ?? null} models={props.runtime?.models} modelsLoading={props.runtime?.modelsLoading}
        modelsError={props.runtime?.modelsError} modelChangeDisabled={conversation.running}
        disabled={conversation.disabledReason !== undefined} disabledReason={conversation.disabledReason}
        running={conversation.running} canceling={conversation.canceling} onSelectProject={() => {}}
        onCancel={() => void conversation.cancel()} onSubmit={conversation.send} />
    </div>
  </aside>;
}
