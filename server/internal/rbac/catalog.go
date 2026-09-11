package rbac

import (
	"sort"
	"strings"
)

const (
	PermissionAccountRead                        = "console:account:read"
	PermissionAccountManage                      = "console:account:manage"
	PermissionAccountCreate                      = "console:account:create"
	PermissionAccountUpdateName                  = "console:account:update_name"
	PermissionAccountUpdateStatus                = "console:account:update_status"
	PermissionAccountResetPassword               = "console:account:reset_password"
	PermissionAccountMerge                       = "console:account:merge"
	PermissionRBACRead                           = "console:rbac:read"
	PermissionRBACManage                         = "console:rbac:manage"
	PermissionRBACRoleCreate                     = "console:rbac:role_create"
	PermissionRBACRoleUpdate                     = "console:rbac:role_update"
	PermissionRBACRoleDelete                     = "console:rbac:role_delete"
	PermissionRBACAccountRoleUpdate              = "console:rbac:account_role_update"
	PermissionAgentRead                          = "console:agent:read"
	PermissionAgentManage                        = "console:agent:manage"
	PermissionAgentCreate                        = "console:agent:create"
	PermissionAgentDelete                        = "console:agent:delete"
	PermissionAgentTokenReveal                   = "console:agent:token_reveal"
	PermissionAgentTokenRotate                   = "console:agent:token_rotate"
	PermissionAgentTokenRevoke                   = "console:agent:token_revoke"
	PermissionAgentBind                          = "console:agent:bind"
	PermissionAgentUnbind                        = "console:agent:unbind"
	PermissionAgentTransfer                      = "console:agent:transfer"
	PermissionCollectorRead                      = "console:collector:read"
	PermissionCollectorManage                    = "console:collector:manage"
	PermissionCollectorRegistrationCodeCreate    = "console:collector:registration_code_create"
	PermissionCollectorTokenRevoke               = "console:collector:token_revoke"
	PermissionCollectorDelete                    = "console:collector:delete"
	PermissionMCPUpstreamRead                    = "console:mcp:upstream:read"
	PermissionMCPUpstreamManage                  = "console:mcp:upstream:manage"
	PermissionMCPUpstreamCreate                  = "console:mcp:upstream:create"
	PermissionMCPUpstreamUpdate                  = "console:mcp:upstream:update"
	PermissionMCPUpstreamDelete                  = "console:mcp:upstream:delete"
	PermissionMCPUpstreamSync                    = "console:mcp:upstream:sync"
	PermissionMCPUpstreamUpdateStatus            = "console:mcp:upstream:update_status"
	PermissionMCPCapabilityRead                  = "console:mcp:capability:read"
	PermissionMCPCapabilityManage                = "console:mcp:capability:manage"
	PermissionMCPCapabilityUpdateStatus          = "console:mcp:capability:update_status"
	PermissionMCPCapabilityRename                = "console:mcp:capability:rename"
	PermissionMCPCapabilityDelete                = "console:mcp:capability:delete"
	PermissionMCPCapabilityUpdateGatePolicy      = "console:mcp:capability:update_gate_policy"
	PermissionMCPGrantRead                       = "console:mcp:grant:read"
	PermissionMCPGrantManage                     = "console:mcp:grant:manage"
	PermissionMCPGrantCreate                     = "console:mcp:grant:create"
	PermissionMCPGrantRevoke                     = "console:mcp:grant:revoke"
	PermissionMCPGateRead                        = "console:mcp:gate:read"
	PermissionMCPGateManage                      = "console:mcp:gate:manage"
	PermissionMCPGateApprove                     = "console:mcp:gate:approve"
	PermissionMCPGateReject                      = "console:mcp:gate:reject"
	PermissionMCPAuditRead                       = "console:mcp:audit:read"
	PermissionActivityRead                       = "console:activity:read"
	PermissionKnowledgeRead                      = "console:knowledge:read"
	PermissionKnowledgeManage                    = "console:knowledge:manage"
	PermissionKnowledgeCreate                    = "console:knowledge:create"
	PermissionKnowledgeUpdate                    = "console:knowledge:update"
	PermissionKnowledgeDelete                    = "console:knowledge:delete"
	PermissionKnowledgeMemberUpdate              = "console:knowledge:member_update"
	PermissionKnowledgeDocumentUpload            = "console:knowledge:document_upload"
	PermissionKnowledgeDocumentSync              = "console:knowledge:document_sync"
	PermissionKnowledgeDocumentDelete            = "console:knowledge:document_delete"
	PermissionSkillRead                          = "console:skill:read"
	PermissionSkillManage                        = "console:skill:manage"
	PermissionSkillVersionUpload                 = "console:skill:version_upload"
	PermissionSkillMove                          = "console:skill:move"
	PermissionSkillPublish                       = "console:skill:publish"
	PermissionSkillUnpublish                     = "console:skill:unpublish"
	PermissionSkillSpaceCreate                   = "console:skill:space_create"
	PermissionSkillSpaceUpdate                   = "console:skill:space_update"
	PermissionSkillSpaceMemberUpdate             = "console:skill:space_member_update"
	PermissionSkillSourceCreate                  = "console:skill:source_create"
	PermissionSkillSourceUpdate                  = "console:skill:source_update"
	PermissionSkillSourceTokenReveal             = "console:skill:source_token_reveal"
	PermissionSkillSourceSync                    = "console:skill:source_sync"
	PermissionSkillSourceScan                    = "console:skill:source_scan"
	PermissionSkillSourceEnable                  = "console:skill:source_enable"
	PermissionSkillSourceDisable                 = "console:skill:source_disable"
	PermissionSkillSourceTokenRemove             = "console:skill:source_token_remove"
	PermissionSkillSourceBind                    = "console:skill:source_bind"
	PermissionSkillSourceUnbind                  = "console:skill:source_unbind"
	PermissionSharedFilesRead                    = "console:shared_files:read"
	PermissionSharedFilesManage                  = "console:shared_files:manage"
	PermissionSharedFilesSpaceCreate             = "console:shared_files:space_create"
	PermissionSharedFilesSpaceUpdate             = "console:shared_files:space_update"
	PermissionSharedFilesMemberUpdate            = "console:shared_files:member_update"
	PermissionSharedFilesDownload                = "console:shared_files:download"
	PermissionSharedFilesUpload                  = "console:shared_files:upload"
	PermissionDataResourceGrantRead              = "console:data_resource_grant:read"
	PermissionDataResourceGrantManage            = "console:data_resource_grant:manage"
	PermissionDataResourceGrantCreate            = "console:data_resource_grant:create"
	PermissionDataResourceGrantUpdate            = "console:data_resource_grant:update"
	PermissionDataResourceGrantDelete            = "console:data_resource_grant:delete"
	PermissionPlatformBrandingRead               = "console:platform_branding:read"
	PermissionPlatformBrandingManage             = "console:platform_branding:manage"
	PermissionPlatformBrandingUpdate             = "console:platform_branding:update"
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
	{PermissionAccountManage, "account", "manage", "账号管理", "查看并执行账号的全部操作"},
	{PermissionAccountCreate, "account", "create", "新增账号", "创建账号"},
	{PermissionAccountUpdateName, "account", "update_name", "修改账号昵称", "修改账号昵称"},
	{PermissionAccountUpdateStatus, "account", "update_status", "更新账号状态", "启用或停用账号"},
	{PermissionAccountResetPassword, "account", "reset_password", "重置账号密码", "重置密码并使现有会话失效"},
	{PermissionAccountMerge, "account", "merge", "账号合并", "将停用账号的数据与 Agent 合并至有效账号"},
	{PermissionRBACRead, "rbac", "read", "RBAC 查看", "查看角色、权限目录和账号角色"},
	{PermissionRBACManage, "rbac", "manage", "RBAC 管理", "查看并执行 RBAC 的全部操作"},
	{PermissionRBACRoleCreate, "rbac", "role_create", "新增角色", "创建自定义角色"},
	{PermissionRBACRoleUpdate, "rbac", "role_update", "编辑角色", "修改自定义角色及其权限"},
	{PermissionRBACRoleDelete, "rbac", "role_delete", "删除角色", "删除未使用的自定义角色"},
	{PermissionRBACAccountRoleUpdate, "rbac", "account_role_update", "分配账号角色", "新增或移除账号的后台角色"},
	{PermissionAgentRead, "agent", "read", "Agent 查看", "查看企业 Agent 列表、详情和责任账号"},
	{PermissionAgentManage, "agent", "manage", "Agent 管理", "查看并执行 Agent 的全部操作"},
	{PermissionAgentCreate, "agent", "create", "新增 Agent", "创建企业 Agent"},
	{PermissionAgentDelete, "agent", "delete", "删除 Agent", "删除 MCP Agent 或采集到的 Agent 实例"},
	{PermissionAgentTokenReveal, "agent", "token_reveal", "查看 Agent Token", "显示并复制账号 MCP Token"},
	{PermissionAgentTokenRotate, "agent", "token_rotate", "轮换 Agent Token", "轮换账号 MCP Token"},
	{PermissionAgentTokenRevoke, "agent", "token_revoke", "吊销 Agent Token", "吊销账号 MCP Token"},
	{PermissionAgentBind, "agent", "bind", "绑定 Agent", "绑定采集 Agent 与 MCP Agent"},
	{PermissionAgentUnbind, "agent", "unbind", "解绑 Agent", "解除采集 Agent 与 MCP Agent 的绑定"},
	{PermissionAgentTransfer, "agent", "transfer", "Agent 迁移", "在账号之间迁移 Agent 责任归属"},
	{PermissionCollectorRead, "collector", "read", "Collector 查看", "查看企业 Collector 列表、详情和责任账号"},
	{PermissionCollectorManage, "collector", "manage", "Collector 管理", "查看并执行 Collector 的全部操作"},
	{PermissionCollectorRegistrationCodeCreate, "collector", "registration_code_create", "生成 Collector 注册码", "生成或重新生成 Collector 注册码"},
	{PermissionCollectorTokenRevoke, "collector", "token_revoke", "撤销 Collector Token", "撤销 Collector Token"},
	{PermissionCollectorDelete, "collector", "delete", "删除 Collector", "删除已撤销 Token 的 Collector"},
	{PermissionMCPUpstreamRead, "mcp_upstream", "read", "MCP 上游查看", "查看上游服务"},
	{PermissionMCPUpstreamManage, "mcp_upstream", "manage", "MCP 上游管理", "查看并执行 MCP 上游的全部操作"},
	{PermissionMCPUpstreamCreate, "mcp_upstream", "create", "新增 MCP 上游", "新增 MCP 上游服务"},
	{PermissionMCPUpstreamUpdate, "mcp_upstream", "update", "编辑 MCP 上游", "编辑 MCP 上游服务"},
	{PermissionMCPUpstreamDelete, "mcp_upstream", "delete", "删除 MCP 上游", "删除已停用的 MCP 上游服务"},
	{PermissionMCPUpstreamSync, "mcp_upstream", "sync", "同步 MCP 上游", "同步 MCP 上游工具"},
	{PermissionMCPUpstreamUpdateStatus, "mcp_upstream", "update_status", "更新 MCP 上游状态", "启用或停用 MCP 上游服务"},
	{PermissionMCPCapabilityRead, "mcp_capability", "read", "MCP 能力查看", "查看能力目录和治理配置"},
	{PermissionMCPCapabilityManage, "mcp_capability", "manage", "MCP 能力管理", "查看并执行 MCP 能力的全部操作"},
	{PermissionMCPCapabilityUpdateStatus, "mcp_capability", "update_status", "更新 MCP 能力状态", "发布、停用或恢复 MCP 能力"},
	{PermissionMCPCapabilityRename, "mcp_capability", "rename", "重命名 MCP 能力", "修改 MCP 能力暴露名称"},
	{PermissionMCPCapabilityDelete, "mcp_capability", "delete", "删除 MCP 能力", "删除缺失的 MCP 能力"},
	{PermissionMCPCapabilityUpdateGatePolicy, "mcp_capability", "update_gate_policy", "配置 MCP 能力门禁", "修改 MCP 能力审批与确认门禁"},
	{PermissionMCPGrantRead, "mcp_grant", "read", "MCP 授权查看", "查看 Agent 能力授权"},
	{PermissionMCPGrantManage, "mcp_grant", "manage", "MCP 授权管理", "查看并执行 MCP 授权的全部操作"},
	{PermissionMCPGrantCreate, "mcp_grant", "create", "新增 MCP 授权", "新增 Agent 能力授权"},
	{PermissionMCPGrantRevoke, "mcp_grant", "revoke", "撤销 MCP 授权", "撤销 Agent 能力授权"},
	{PermissionMCPGateRead, "mcp_gate", "read", "MCP 门禁查看", "查看管理员门禁"},
	{PermissionMCPGateManage, "mcp_gate", "manage", "MCP 门禁管理", "查看并处理管理员门禁的全部操作"},
	{PermissionMCPGateApprove, "mcp_gate", "approve", "通过 MCP 门禁", "通过管理员门禁审批"},
	{PermissionMCPGateReject, "mcp_gate", "reject", "拒绝 MCP 门禁", "拒绝管理员门禁审批"},
	{PermissionMCPAuditRead, "mcp_audit", "read", "MCP 审计查看", "查看企业 MCP 调用审计"},
	{PermissionActivityRead, "activity", "read", "Agent 活动查看", "查看企业范围内采集到的 Agent 活动"},
	{PermissionKnowledgeRead, "knowledge", "read", "知识库查看", "查看知识库和文档管理信息"},
	{PermissionKnowledgeManage, "knowledge", "manage", "知识库管理", "查看并执行知识库的全部操作"},
	{PermissionKnowledgeCreate, "knowledge", "create", "新增知识库", "创建知识库"},
	{PermissionKnowledgeUpdate, "knowledge", "update", "编辑知识库", "修改知识库信息和状态"},
	{PermissionKnowledgeDelete, "knowledge", "delete", "删除知识库", "删除知识库"},
	{PermissionKnowledgeMemberUpdate, "knowledge", "member_update", "管理知识库成员", "新增、修改或移除知识库成员授权"},
	{PermissionKnowledgeDocumentUpload, "knowledge", "document_upload", "上传知识库文档", "上传知识库文档"},
	{PermissionKnowledgeDocumentSync, "knowledge", "document_sync", "同步知识库文档", "触发知识库文档同步"},
	{PermissionKnowledgeDocumentDelete, "knowledge", "document_delete", "删除知识库文档", "删除知识库文档"},
	{PermissionSkillRead, "skill", "read", "技能查看", "查看技能版本、文件和发布管理信息"},
	{PermissionSkillManage, "skill", "manage", "技能管理", "查看并执行技能的全部操作"},
	{PermissionSkillVersionUpload, "skill", "version_upload", "上传技能版本", "上传技能版本"},
	{PermissionSkillMove, "skill", "move", "移动技能", "将技能移动到其他空间"},
	{PermissionSkillPublish, "skill", "publish", "发布技能版本", "将技能版本设为当前版本"},
	{PermissionSkillUnpublish, "skill", "unpublish", "取消技能发布", "取消技能当前发布版本"},
	{PermissionSkillSpaceCreate, "skill", "space_create", "新增技能空间", "创建技能空间"},
	{PermissionSkillSpaceUpdate, "skill", "space_update", "编辑技能空间", "修改技能空间信息"},
	{PermissionSkillSpaceMemberUpdate, "skill", "space_member_update", "管理技能空间成员", "新增、修改或移除技能空间成员授权"},
	{PermissionSkillSourceCreate, "skill", "source_create", "新增技能来源", "创建 GitHub 技能来源"},
	{PermissionSkillSourceUpdate, "skill", "source_update", "编辑技能来源", "修改 GitHub 技能来源"},
	{PermissionSkillSourceTokenReveal, "skill", "source_token_reveal", "查看技能来源 Token", "查看 GitHub 技能来源 Token"},
	{PermissionSkillSourceSync, "skill", "source_sync", "同步技能来源", "触发 GitHub 技能来源同步"},
	{PermissionSkillSourceScan, "skill", "source_scan", "扫描技能来源", "提交本地仓库扫描结果"},
	{PermissionSkillSourceEnable, "skill", "source_enable", "启用技能来源", "启用 GitHub 技能来源"},
	{PermissionSkillSourceDisable, "skill", "source_disable", "停用技能来源", "停用 GitHub 技能来源"},
	{PermissionSkillSourceTokenRemove, "skill", "source_token_remove", "移除技能来源 Token", "移除 GitHub 技能来源 Token"},
	{PermissionSkillSourceBind, "skill", "source_bind", "绑定技能来源条目", "将来源条目绑定到现有技能"},
	{PermissionSkillSourceUnbind, "skill", "source_unbind", "解绑技能来源条目", "解除来源条目与技能的绑定"},
	{PermissionSharedFilesRead, "shared_files", "read", "网盘查看", "查看共享空间、成员和文件元数据"},
	{PermissionSharedFilesManage, "shared_files", "manage", "网盘管理", "查看并执行共享网盘的全部操作"},
	{PermissionSharedFilesSpaceCreate, "shared_files", "space_create", "新增共享空间", "创建共享空间"},
	{PermissionSharedFilesSpaceUpdate, "shared_files", "space_update", "编辑共享空间", "修改共享空间信息"},
	{PermissionSharedFilesMemberUpdate, "shared_files", "member_update", "管理共享空间成员", "新增、修改或移除共享空间成员授权"},
	{PermissionSharedFilesDownload, "shared_files", "download", "下载共享文件", "下载共享空间文件"},
	{PermissionSharedFilesUpload, "shared_files", "upload", "上传共享文件", "上传文件或新版本"},
	{PermissionDataResourceGrantRead, "data_resource_grant", "read", "数据权限查看", "查看数据资源 Action 和被授权用户"},
	{PermissionDataResourceGrantManage, "data_resource_grant", "manage", "数据权限管理", "查看并执行数据资源授权的全部操作"},
	{PermissionDataResourceGrantCreate, "data_resource_grant", "create", "新增数据资源授权", "新增账户数据资源授权"},
	{PermissionDataResourceGrantUpdate, "data_resource_grant", "update", "编辑数据资源授权", "修改账户数据资源授权"},
	{PermissionDataResourceGrantDelete, "data_resource_grant", "delete", "删除数据资源授权", "删除账户数据资源授权"},
	{PermissionPlatformBrandingRead, "platform_branding", "read", "平台外观查看", "查看客户端平台外观配置"},
	{PermissionPlatformBrandingManage, "platform_branding", "manage", "平台外观管理", "查看并管理客户端平台外观"},
	{PermissionPlatformBrandingUpdate, "platform_branding", "update", "更新平台外观", "修改客户端平台外观"},
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
		module := ""
		for _, permission := range permissionCatalog {
			if permission.Code == code {
				module = permission.Module
				break
			}
		}
		for _, permission := range permissionCatalog {
			if permission.Module == module {
				target[permission.Code] = struct{}{}
			}
		}
	}
}
