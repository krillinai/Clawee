import type { RuntimeThread, ThreadManager } from '../threads/types.js';
import { isEnterpriseKnowledgeThread } from '../threads/types.js';
import type { EnterpriseIdentityProvider } from './session-manager-2026-07-30.js';

export type KnowledgeConversationManager = {
  create(projectId: string): Promise<RuntimeThread>;
  latest(): Promise<RuntimeThread | undefined>;
  requireOwnedThread(threadId: string): Promise<RuntimeThread>;
};

export class KnowledgeConversationError extends Error {
  constructor(
    readonly statusCode: 404,
    readonly code: 'THREAD_NOT_FOUND'
  ) {
    super(code);
    this.name = 'KnowledgeConversationError';
  }
}

export function createKnowledgeConversationManager(input: {
  sessionManager: EnterpriseIdentityProvider;
  threadManager: ThreadManager;
}): KnowledgeConversationManager {
  return {
    async create(projectId) {
      const identity = await input.sessionManager.requireIdentity();
      return input.threadManager.createKnowledgeThread({
        enterpriseSubjectId: identity.subjectId,
        projectId,
        title: '知识库对话'
      });
    },

    async latest() {
      const identity = await input.sessionManager.requireIdentity();
      return input.threadManager.listKnowledgeThreads(identity.subjectId, {
        status: 'active',
        limit: 1
      })[0];
    },

    async requireOwnedThread(threadId) {
      const identity = await input.sessionManager.requireIdentity();
      const thread = input.threadManager.getThread(threadId);
      if (
        thread === undefined
        || !isEnterpriseKnowledgeThread(thread)
        || thread.enterpriseSubjectId !== identity.subjectId
      ) {
        throw new KnowledgeConversationError(404, 'THREAD_NOT_FOUND');
      }
      return thread;
    }
  };
}
