import type { ThreadManager } from '../threads/types.js';
import { isProjectlessEnterpriseConversation } from '../threads/manager.js';
import { KnowledgeConversationError, type KnowledgeConversationManager } from './knowledge-conversation-2026-08-05.js';
import type { EnterpriseIdentityProvider } from './session-manager-2026-07-30.js';
import type { SkillContributionsManager } from './skill-contributions-manager.js';
import { contributionQuerySchema } from './skill-contributions-schema.js';

export const contributionConversationTitle = 'Skill 贡献对话';

export function createContributionConversationManager(input: { sessionManager: EnterpriseIdentityProvider; threadManager: ThreadManager; contributions: SkillContributionsManager }): KnowledgeConversationManager {
  async function identity() {
    await input.contributions.requireRead();
    return input.sessionManager.requireIdentity();
  }
  return {
    async create() {
      const account = await identity();
      return input.threadManager.createKnowledgeThread({ enterpriseSubjectId: account.subjectId, title: contributionConversationTitle });
    },
    async latest() {
      const account = await identity();
      return input.threadManager.listKnowledgeThreads(account.subjectId, { status: 'active', assignment: 'unassigned', limit: 1 })[0];
    },
    async requireOwnedThread(id) {
      const account = await identity();
      const thread = input.threadManager.getThread(id);
      if (!isProjectlessEnterpriseConversation(thread) || thread.enterpriseSubjectId !== account.subjectId) throw new KnowledgeConversationError(404, 'THREAD_NOT_FOUND');
      return thread;
    }
  };
}

export function contributionExecutionPrompt(prompt: string, body: Record<string, unknown>): string {
  const query = contributionQuerySchema.parse(body.query ?? {});
  if (Object.keys(body).some(key => key !== 'prompt' && key !== 'query')) throw new Error('查询条件无效');
  return [
    '[Clawee Skill 贡献查询]',
    `本轮默认条件：${JSON.stringify(query)}。用户明确条件覆盖默认条件，但不修改页面筛选。`,
    '只使用 skill_contributions_query 和 skill_contributions_export MCP 工具读取贡献数据。缺少工具或模型时明确不可用，禁止读取文件或调用其他系统替代。',
    '工具返回的 query 为实际条件，必须展示。概览仅接收周期与员工；状态和最低分仅支持上传或首次通过明细；员工汇总不支持分数和状态条件。',
    '高分未给门槛须澄清；员工按ID识别，同名须确认。缺失分不能补零或AI分，不得从分页生成全量统计。',
    '上传与首次通过分别按其时间；首次通过每个skill_id仅一次，历史unknown不能计入。无奖励金额、发奖、已奖励状态。',
    '导出只调用贡献导出工具，返回受控下载描述，不生成链接或写文件。',
    `用户问题：${prompt}`
  ].join('\n');
}
