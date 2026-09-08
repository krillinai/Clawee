import { describe, expect, it } from 'vitest';
import {
  buildEnterpriseKnowledgeExecutionPrompt,
  extractEnterpriseKnowledgePublicInput,
  isUnqualifiedEnterpriseKnowledgeRequest
} from '../../src/codex/enterprise-knowledge-routing.js';

describe('enterprise knowledge routing', () => {
  it('routes unqualified knowledge requests to the Gateway MCP', () => {
    expect(isUnqualifiedEnterpriseKnowledgeRequest('查看下我的知识库')).toBe(true);
    expect(isUnqualifiedEnterpriseKnowledgeRequest('搜索公司内部资料')).toBe(true);

    const prompt = buildEnterpriseKnowledgeExecutionPrompt({
      publicPrompt: '查看下我的知识库',
      executionPrompt: '查看下我的知识库'
    });

    expect(prompt).toContain('Clawee Gateway 提供的企业知识库');
    expect(prompt).toContain('knowledge.search');
    expect(prompt).toContain('禁止读取或调用 lark-wiki');
    expect(extractEnterpriseKnowledgePublicInput(prompt)).toBe(
      '查看下我的知识库'
    );
  });

  it('does not override explicitly named third-party knowledge platforms', () => {
    for (const prompt of [
      '查看我的飞书知识库',
      '列出 Lark knowledge base',
      '看看钉钉知识库',
      '打开 https://example.feishu.cn/wiki/abc'
    ]) {
      expect(isUnqualifiedEnterpriseKnowledgeRequest(prompt)).toBe(false);
      expect(buildEnterpriseKnowledgeExecutionPrompt({
        publicPrompt: prompt,
        executionPrompt: prompt
      })).toBe(prompt);
    }
  });

  it('preserves existing execution context inside a single route wrapper', () => {
    const memoryPrompt = [
      '[Clawee 用户显式管理的上下文]',
      '- 记忆：优先中文回答',
      '[上下文结束]',
      '',
      '用户当前请求：',
      '搜索知识库里的报销制度'
    ].join('\n');
    const routed = buildEnterpriseKnowledgeExecutionPrompt({
      publicPrompt: '搜索知识库里的报销制度',
      executionPrompt: memoryPrompt
    });

    expect(routed).toContain(memoryPrompt);
    expect(buildEnterpriseKnowledgeExecutionPrompt({
      publicPrompt: '搜索知识库里的报销制度',
      executionPrompt: routed
    })).toBe(routed);
  });
});
