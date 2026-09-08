import { describe, expect, it } from 'vitest';
import {
  createConversationTitle,
  extractPublicConversationInput
} from '../../src/threads/conversation-title.js';

describe('createConversationTitle', () => {
  it('keeps an already concise title unchanged', () => {
    expect(createConversationTitle('启动服务')).toBe('启动服务');
  });

  it('extracts the actual request from a schedule assistant prompt', () => {
    expect(createConversationTitle([
      '你是 Clawee 的计划任务配置助手。',
      '不要调用工具，不要修改文件，只根据用户描述生成一个计划任务草稿。',
      '用户所在时区：Asia/Shanghai',
      '只输出一个 JSON 对象，不要输出 Markdown 或解释。',
      '用户描述：每个工作日上午九点总结当前项目最近的进展和需要跟进的事项',
    ].join('\n'))).toBe('工作日总结项目进展');
  });

  it('uses a concise compatibility title for truncated legacy assistant prompts', () => {
    expect(createConversationTitle(
      '你是 Clawee 的计划任务配置助手。 不要调用工具，不要修改文件，只根据用户描述生成一个计划任务草稿。 用户所在时区：Asia/Shanghai 只输出一…'
    )).toBe('创建计划任务');
  });

  it('removes attachment metadata and uses the user request', () => {
    expect(createConversationTitle(`
# Files mentioned by the user:

## screenshot.png: /tmp/screenshot.png

## My request for Codex:
为什么 ChatGPT App 看不到 GPT-5.6，但 Codex CLI 可以使用
    `)).toBe('ChatGPT App 看不到 GPT-5.6');
  });

  it('removes a leading skill invocation and conversational filler', () => {
    expect(createConversationTitle(
      '[$brainstorming](/Users/test/.codex/skills/brainstorming/SKILL.md) 请帮我重新详细梳理下 AI 任务创建的逻辑，现有功能还有哪些问题'
    )).toBe('梳理 AI 任务创建逻辑');
  });

  it('normalizes common resource questions into useful titles', () => {
    expect(createConversationTitle('你都有什么mcp')).toBe('查看可用 MCP');
    expect(createConversationTitle('都有什么mcp')).toBe('查看可用 MCP');
    expect(createConversationTitle('我都有什么定时任务')).toBe('查看定时任务');
  });

  it('rejects uninformative prefixes produced by detail separators', () => {
    expect(createConversationTitle('你还有哪些能力')).toBe('你还有哪些能力');
    expect(createConversationTitle('项目为什么无法启动')).toBe('项目为什么无法启动');
    expect(createConversationTitle('配置项为什么无效')).toBe('配置项为什么无效');
    expect(createConversationTitle('如何使用mcp')).toBe('如何使用 MCP');
    expect(createConversationTitle('我同时需要检查配置')).toBe('我同时需要检查配置');
  });

  it('keeps genuinely short user requests unchanged', () => {
    expect(createConversationTitle('登录')).toBe('登录');
    expect(createConversationTitle('报错')).toBe('报错');
  });

  it('uses a short fallback for attachment-only and blank requests', () => {
    expect(createConversationTitle('# Files mentioned by the user:\n\n## image.png: /tmp/image.png'))
      .toBe('查看附件');
    expect(createConversationTitle('   ')).toBe('新对话');
  });

  it('limits long titles by visual width', () => {
    expect(createConversationTitle(
      '分析 admin-api 里面的 AI 任务功能为什么显示顾问列表加载失败以及如何修复'
    )).toBe('分析 admin-api 的 AI 任务功能');
    expect(createConversationTitle(
      'Use the r4_smoke_skill_1783880138172 skill and reply with the marker'
    )).toBe('Use the r4_smoke_skill_17838…');
  });

  it('extracts only the public request from Clawee-managed context wrappers', () => {
    expect(extractPublicConversationInput([
      '[Clawee 用户显式管理的上下文]',
      '- 会话摘要：内部摘要',
      '[上下文结束]',
      '',
      '用户当前请求：',
      '修复重复请求'
    ].join('\n'))).toBe('修复重复请求');

    expect(extractPublicConversationInput([
      '[Clawee 执行上下文恢复摘要]',
      '- 已完成：内部恢复信息',
      '',
      '本次公开任务输入：',
      '继续运行测试'
    ].join('\n'))).toBe('继续运行测试');

    expect(extractPublicConversationInput([
      '[Clawee Runtime 企业知识库路由]',
      '- 本轮知识库指企业知识库。',
      '[路由约束结束]',
      '本轮原始执行输入：',
      '[Clawee 用户显式管理的上下文]',
      '- 会话摘要：内部摘要',
      '[上下文结束]',
      '',
      '用户当前请求：',
      '查看下我的知识库'
    ].join('\n'))).toBe('查看下我的知识库');
  });

  it('hides malformed or empty Clawee context wrappers instead of exposing internal text', () => {
    expect(extractPublicConversationInput(
      '[Clawee 用户显式管理的上下文]\n- 会话摘要：内部摘要'
    )).toBeUndefined();
    expect(extractPublicConversationInput([
      '[Clawee 执行上下文恢复摘要]',
      '本次公开任务输入：',
      '   '
    ].join('\n'))).toBeUndefined();
  });
});
