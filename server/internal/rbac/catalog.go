package rbac

import (
	"sort"
	"strings"
)

const (
	PermissionAccountRead             = "console:account:read"
	PermissionAccountManage           = "console:account:manage"
	PermissionAccountMerge            = "console:account:merge"
	PermissionRBACRead                = "console:rbac:read"
	PermissionRBACManage              = "console:rbac:manage"
	PermissionAgentRead               = "console:agent:read"
	PermissionAgentManage             = "console:agent:manage"
	PermissionAgentTransfer           = "console:agent:transfer"
	PermissionCollectorRead           = "console:collector:read"
	PermissionCollectorManage         = "console:collector:manage"
	PermissionMCPUpstreamRead         = "console:mcp:upstream:read"
	PermissionMCPUpstreamManage       = "console:mcp:upstream:manage"
	PermissionMCPCapabilityRead       = "console:mcp:capability:read"
	PermissionMCPCapabilityManage     = "console:mcp:capability:manage"
	PermissionMCPGrantRead            = "console:mcp:grant:read"
	PermissionMCPGrantManage          = "console:mcp:grant:manage"
	PermissionMCPGateRead             = "console:mcp:gate:read"
	PermissionMCPGateManage           = "console:mcp:gate:manage"
	PermissionMCPAuditRead            = "console:mcp:audit:read"
	PermissionActivityRead            = "console:activity:read"
	PermissionKnowledgeRead           = "console:knowledge:read"
	PermissionKnowledgeManage         = "console:knowledge:manage"
	PermissionSkillRead               = "console:skill:read"
	PermissionSkillManage             = "console:skill:manage"
	PermissionSharedFilesRead         = "console:shared_files:read"
	PermissionSharedFilesManage       = "console:shared_files:manage"
	PermissionDataResourceGrantRead   = "console:data_resource_grant:read"
	PermissionDataResourceGrantManage = "console:data_resource_grant:manage"
)

type Permission struct {
	Code        string
	Module      string
	Action      string
	Name        string
	Description string
}

var permissionCatalog = []Permission{
	{PermissionAccountRead, "account", "read", "账号查看", "查看账号"},
	{PermissionAccountManage, "account", "manage", "账号管理", "查看、创建、启停账号和重置密码"},
	{PermissionAccountMerge, "account", "merge", "账号合并", "将停用账号的数据与 Agent 合并至有效账号"},
	{PermissionRBACRead, "rbac", "read", "RBAC 查看", "查看角色、权限目录和账号角色"},
	{PermissionRBACManage, "rbac", "manage", "RBAC 管理", "查看并管理自定义角色、角色权限和账号角色"},
	{PermissionAgentRead, "agent", "read", "Agent 查看", "查看企业 Agent 列表、详情和责任账号"},
	{PermissionAgentManage, "agent", "manage", "Agent 管理", "查看、创建和管理 Agent 及其 Token"},
	{PermissionAgentTransfer, "agent", "transfer", "Agent 迁移", "在账号之间迁移 Agent 责任归属"},
	{PermissionCollectorRead, "collector", "read", "Collector 查看", "查看企业 Collector 列表、详情和责任账号"},
	{PermissionCollectorManage, "collector", "manage", "Collector 管理", "查看和管理 Collector、安装命令及 Token"},
	{PermissionMCPUpstreamRead, "mcp_upstream", "read", "MCP 上游查看", "查看上游服务"},
	{PermissionMCPUpstreamManage, "mcp_upstream", "manage", "MCP 上游管理", "查看并管理上游服务"},
	{PermissionMCPCapabilityRead, "mcp_capability", "read", "MCP 能力查看", "查看能力目录和治理配置"},
	{PermissionMCPCapabilityManage, "mcp_capability", "manage", "MCP 能力管理", "查看并管理能力和门禁配置"},
	{PermissionMCPGrantRead, "mcp_grant", "read", "MCP 授权查看", "查看 Agent 能力授权"},
	{PermissionMCPGrantManage, "mcp_grant", "manage", "MCP 授权管理", "查看、新增和撤销 Agent 能力授权"},
	{PermissionMCPGateRead, "mcp_gate", "read", "MCP 门禁查看", "查看管理员门禁"},
	{PermissionMCPGateManage, "mcp_gate", "manage", "MCP 门禁管理", "查看、通过或拒绝管理员审批"},
	{PermissionMCPAuditRead, "mcp_audit", "read", "MCP 审计查看", "查看企业 MCP 调用审计"},
	{PermissionActivityRead, "activity", "read", "Agent 活动查看", "查看企业范围内采集到的 Agent 活动"},
	{PermissionKnowledgeRead, "knowledge", "read", "知识库查看", "查看知识库和文档管理信息"},
	{PermissionKnowledgeManage, "knowledge", "manage", "知识库管理", "查看并管理知识库和文档"},
	{PermissionSkillRead, "skill", "read", "技能查看", "查看技能版本、文件和发布管理信息"},
	{PermissionSkillManage, "skill", "manage", "技能管理", "查看、上传版本和设置当前版本"},
	{PermissionSharedFilesRead, "shared_files", "read", "网盘查看", "查看共享空间、成员和文件元数据"},
	{PermissionSharedFilesManage, "shared_files", "manage", "网盘管理", "管理共享空间、成员及文件上传下载"},
	{PermissionDataResourceGrantRead, "data_resource_grant", "read", "数据权限查看", "查看数据资源 Action 和被授权用户"},
	{PermissionDataResourceGrantManage, "data_resource_grant", "manage", "数据权限管理", "查看并管理账户数据资源授权"},
}

func PermissionCatalog() []Permission {
	out := make([]Permission, len(permissionCatalog))
	copy(out, permissionCatalog)
	return out
}

func permissionCodes() []string {
	out := make([]string, 0, len(permissionCatalog))
	for _, permission := range permissionCatalog {
		out = append(out, permission.Code)
	}
	sort.Strings(out)
	return out
}

func validPermission(code string) bool {
	for _, permission := range permissionCatalog {
		if permission.Code == code {
			return true
		}
	}
	return false
}

func expandPermission(code string, target map[string]struct{}) {
	target[code] = struct{}{}
	if strings.HasSuffix(code, ":manage") {
		readCode := strings.TrimSuffix(code, ":manage") + ":read"
		if validPermission(readCode) {
			target[readCode] = struct{}{}
		}
	}
}
