import type { Permission } from "@/lib/rbac-api";

export type PermissionGroupNode = {
  children: PermissionGroupNode[];
  count: number;
  key: string;
  permissionCodes: string[];
  permissions: Permission[];
  segment: string;
};

const permissionGroupLabels: Record<string, string> = {
  account: "账号",
  rbac: "RBAC",
  agent: "Agent",
  collector: "Collector",
  mcp: "MCP 治理",
  "mcp:upstream": "上游服务",
  "mcp:capability": "能力治理",
  "mcp:grant": "Agent 授权",
  "mcp:gate": "管理员门禁",
  "mcp:audit": "调用审计",
  activity: "Agent 活动",
  knowledge: "知识库",
  skill: "技能",
  shared_files: "共享网盘",
  data_resource_grant: "数据资源授权"
};

export function permissionGroupLabel(node: PermissionGroupNode) {
  return permissionGroupLabels[node.key] ?? node.segment.replaceAll("_", " ");
}

export function buildPermissionTree(permissions: Permission[]): PermissionGroupNode[] {
  const roots: PermissionGroupNode[] = [];
  const nodes = new Map<string, PermissionGroupNode>();

  for (const permission of permissions) {
    const codeSegments = permission.code.split(":");
    const pathSegments = (codeSegments[0] === "console" ? codeSegments.slice(1) : codeSegments).slice(0, -1);
    if (pathSegments.length === 0) pathSegments.push(permission.module);

    let siblings = roots;
    let current: PermissionGroupNode | undefined;
    const path: string[] = [];

    for (const segment of pathSegments) {
      path.push(segment);
      const key = path.join(":");
      current = nodes.get(key);
      if (!current) {
        current = { children: [], count: 0, key, permissionCodes: [], permissions: [], segment };
        nodes.set(key, current);
        siblings.push(current);
      }
      current.count += 1;
      current.permissionCodes.push(permission.code);
      siblings = current.children;
    }

    current?.permissions.push(permission);
  }

  return roots;
}
