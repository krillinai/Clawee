const ZERO_WIDTH_CHARACTERS = /\p{Default_Ignorable_Code_Point}/gu;
const WHITESPACE = /\s+/gu;

const DIRECT_PROTECTED_MARKERS = [
  'skill.md',
  '.codex/skills',
  '.codex\\skills',
  '系统提示词',
  '开发者指令',
  '内部提示词'
];

const SKILL_DETAIL_MARKERS = [
  '内容',
  '文件',
  '原文',
  '源码',
  '提示词',
  '指令',
  '规则',
  '脚本',
  '资源',
  '存储路径',
  '配置'
];
const PROTECTED_SKILL_DETAIL = new RegExp(
  `skill\\s*的?\\s*(?:(?:完整|全部|内部|执行|原始)\\s*)*(?:${SKILL_DETAIL_MARKERS.join('|')})`,
  'u'
);

const DISCLOSURE_ACTIONS = [
  '输出',
  '展示',
  '查看',
  '读取',
  '复述',
  '总结',
  '翻译',
  '编码',
  '拆分',
  '写入文件',
  '工具调用',
  '外部传输',
  '导出',
  '下载',
  '复制',
  '打包',
  '发送',
  '上传',
  '打印',
  '暴露',
  '泄露',
  '列出',
  '还原'
];

export function isServerSkillDisclosureRequest(prompt: string): boolean {
  const normalized = normalizePrompt(prompt);
  if (DIRECT_PROTECTED_MARKERS.some(marker => normalized.includes(marker))) {
    return true;
  }
  if (normalized.includes('codex_home') && normalized.includes('skills')) {
    return true;
  }

  const referencesProtectedSkill =
    /(?:服务端|服务器|远程|内部)\s*的?\s*skill/u.test(normalized)
    || PROTECTED_SKILL_DETAIL.test(normalized);
  return referencesProtectedSkill
    && DISCLOSURE_ACTIONS.some(action => normalized.includes(action));
}

function normalizePrompt(prompt: string): string {
  return prompt
    .normalize('NFKC')
    .toLowerCase()
    .replace(ZERO_WIDTH_CHARACTERS, '')
    .replace(WHITESPACE, ' ')
    .trim();
}
