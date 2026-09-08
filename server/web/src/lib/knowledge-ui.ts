export type KnowledgeStatusVariant = "success" | "danger" | "warning" | "muted";

type KnowledgeStatusPresentation = {
  label: string;
  variant: KnowledgeStatusVariant;
};

const presentations: Record<string, KnowledgeStatusPresentation> = {
  active: { label: "可用", variant: "success" },
  ready: { label: "可检索", variant: "success" },
  creating: { label: "创建中", variant: "warning" },
  uploading: { label: "上传中", variant: "warning" },
  processing: { label: "处理中", variant: "warning" },
  deleting: { label: "删除中", variant: "warning" },
  create_failed: { label: "创建失败", variant: "danger" },
  failed: { label: "处理失败", variant: "danger" },
  delete_failed: { label: "删除失败", variant: "danger" },
  deleted: { label: "已删除", variant: "muted" }
};

export const knowledgeBaseStatusOptions = [
  "active",
  "creating",
  "create_failed",
  "deleting",
  "delete_failed"
] as const;

export function knowledgeStatusPresentation(value: string): KnowledgeStatusPresentation {
  return presentations[value] ?? { label: value || "未知", variant: "muted" };
}
