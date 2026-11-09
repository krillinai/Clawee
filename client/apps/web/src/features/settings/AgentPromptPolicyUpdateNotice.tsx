import { Info, X } from 'lucide-react';

export function AgentPromptPolicyUpdateNotice({
  version,
  onClose
}: {
  version?: number;
  onClose: () => void;
}) {
  if (version === undefined) return null;
  return (
    <aside className="desktop-update-notice" role="status" aria-live="polite" aria-label="Agent 提示词已更新">
      <Info className="desktop-update-notice-icon" size={18} aria-hidden="true" />
      <div className="desktop-update-notice-content">
        <span className="desktop-update-notice-title">Agent 提示词已更新</span>
        <span className="desktop-update-notice-text">新建会话后生效。</span>
      </div>
      <button
        className="icon-button desktop-update-notice-dismiss"
        type="button"
        aria-label="关闭 Agent 提示词更新提示"
        title="关闭 Agent 提示词更新提示"
        onClick={onClose}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
