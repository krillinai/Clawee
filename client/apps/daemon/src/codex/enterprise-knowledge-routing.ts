const ENTERPRISE_KNOWLEDGE_ROUTE_PREFIX =
  '[Clawee Runtime 企业知识库路由]';
const ENTERPRISE_KNOWLEDGE_ROUTE_MARKER =
  '\n本轮原始执行输入：\n';

const KNOWLEDGE_REQUEST_PATTERN =
  /知识库|知识空间|内部资料|企业资料|公司资料|enterprise\s+knowledge|knowledge\s+base/iu;
const EXPLICIT_EXTERNAL_PLATFORM_PATTERN =
  /飞书|feishu|lark(?:suite)?|钉钉|dingtalk|notion|confluence|语雀|yuque|腾讯文档/iu;
const EXPLICIT_EXTERNAL_PLATFORM_URL_PATTERN =
  /https?:\/\/[^\s]*(?:feishu\.cn|larksuite\.com|dingtalk\.com|notion\.(?:so|site)|atlassian\.net|yuque\.com|docs\.qq\.com)/iu;

export function buildEnterpriseKnowledgeExecutionPrompt(input: {
  publicPrompt: string;
  executionPrompt: string;
}): string {
  if (
    input.executionPrompt.trimStart().startsWith(
      ENTERPRISE_KNOWLEDGE_ROUTE_PREFIX
    )
    || !isUnqualifiedEnterpriseKnowledgeRequest(input.publicPrompt)
  ) {
    return input.executionPrompt;
  }

  return [
    ENTERPRISE_KNOWLEDGE_ROUTE_PREFIX,
    '- 这是 Clawee Runtime 注入的本轮路由约束，优先于该会话此前对“知识库”的平台判断。',
    '- 用户本轮没有指定第三方平台，因此“知识库”指 Clawee Gateway 提供的企业知识库。',
    '- 先检查当前工具清单中名称、服务名或描述包含 enterprise knowledge、enterprise_knowledge、企业知识库的 MCP 工具。',
    '- 检索或问答意图优先调用企业知识库检索工具，例如逻辑名称 knowledge.search、标题“检索企业知识库”。',
    '- 列表或浏览意图若没有对应工具，直接说明当前企业知识库 MCP 缺少列表或浏览能力；不得伪造检索词代替列表。',
    '- 本轮禁止读取或调用 lark-wiki、飞书、Lark、钉钉、DingTalk 等第三方平台 Skill，也不得发起这些平台的授权。',
    '[路由约束结束]',
    ENTERPRISE_KNOWLEDGE_ROUTE_MARKER.slice(1),
    input.executionPrompt
  ].join('\n');
}

export function extractEnterpriseKnowledgePublicInput(
  input: string
): string | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith(ENTERPRISE_KNOWLEDGE_ROUTE_PREFIX)) {
    return undefined;
  }
  const markerIndex = trimmed.lastIndexOf(
    ENTERPRISE_KNOWLEDGE_ROUTE_MARKER
  );
  if (markerIndex < 0) return undefined;
  const publicInput = trimmed
    .slice(markerIndex + ENTERPRISE_KNOWLEDGE_ROUTE_MARKER.length)
    .trim();
  return publicInput.length === 0 ? undefined : publicInput;
}

export function isUnqualifiedEnterpriseKnowledgeRequest(
  prompt: string
): boolean {
  return KNOWLEDGE_REQUEST_PATTERN.test(prompt)
    && !EXPLICIT_EXTERNAL_PLATFORM_PATTERN.test(prompt)
    && !EXPLICIT_EXTERNAL_PLATFORM_URL_PATTERN.test(prompt);
}
