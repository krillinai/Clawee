package dataaccess

import (
	"errors"
	"time"
)

const (
	ResourceKnowledgeBase = "knowledge_base"
	ResourceSharedSpace   = "shared_space"
	ResourceSkillSpace    = "skill_space"
	ResourceDataView      = "data_view"

	ViewAgentActivity        = "agent_activity"
	ViewXiaohongshuOperation = "xiaohongshu_operation"
	ViewDouyinAds            = "douyin_ads"
	ViewBilibiliOperation    = "bilibili_operation"

	ActionRead    = "read"
	ActionUpload  = "upload"
	ActionMCP     = "mcp"
	ActionWrite   = "write"
	ActionConnect = "connect"
	ActionManage  = "manage"
)

type ActionDefinition struct {
	Action         string
	Name           string
	Description    string
	Required       bool
	DefaultChecked bool
}

type ResourceDefinition struct {
	ResourceType string
	Name         string
	Actions      []ActionDefinition
}

var resourceCatalog = []ResourceDefinition{
	{
		ResourceType: ResourceSharedSpace,
		Name:         "共享空间",
		Actions: []ActionDefinition{
			{Action: ActionRead, Name: "查看空间与文件", Required: true},
			{Action: ActionWrite, Name: "上传及修改文件", DefaultChecked: true},
		},
	},
	{
		ResourceType: ResourceKnowledgeBase,
		Name:         "知识库",
		Actions: []ActionDefinition{
			{Action: ActionRead, Name: "查看知识库与文档", Required: true},
			{Action: ActionUpload, Name: "上传文档"},
			{Action: ActionMCP, Name: "MCP 调用", Description: "允许该账户下已获得相关 MCP Tool 授权的 Agent 调用此知识库。"},
		},
	},
	{
		ResourceType: ResourceSkillSpace,
		Name:         "技能空间",
		Actions: []ActionDefinition{
			{Action: ActionRead, Name: "查看空间与技能", Required: true},
			{Action: ActionWrite, Name: "上传技能", DefaultChecked: true},
		},
	},
	{
		ResourceType: ResourceDataView,
		Name:         "数据视图",
		Actions: []ActionDefinition{
			{Action: ActionRead, Name: "查看数据视图", Required: true},
			{Action: ActionConnect, Name: "连接与同步账号", Description: "允许连接、重新授权和手动同步平台账号。"},
			{Action: ActionManage, Name: "管理账号同步", Description: "允许停止或恢复平台账号同步。"},
		},
	},
}

func ResourceCatalog() []ResourceDefinition {
	definitions := make([]ResourceDefinition, len(resourceCatalog))
	for index, definition := range resourceCatalog {
		definitions[index] = definition
		definitions[index].Actions = append([]ActionDefinition(nil), definition.Actions...)
	}
	return definitions
}

func ResourceDefinitionFor(resourceType string) (ResourceDefinition, bool) {
	for _, definition := range resourceCatalog {
		if definition.ResourceType == resourceType {
			definition.Actions = append([]ActionDefinition(nil), definition.Actions...)
			return definition, true
		}
	}
	return ResourceDefinition{}, false
}

func ActionDefinitionsFor(resourceType, resourceID string) []ActionDefinition {
	definition, ok := ResourceDefinitionFor(resourceType)
	if !ok {
		return []ActionDefinition{}
	}
	if resourceType != ResourceDataView || resourceID == ViewBilibiliOperation || resourceID == "" {
		return definition.Actions
	}
	actions := make([]ActionDefinition, 0, len(definition.Actions))
	for _, action := range definition.Actions {
		if action.Action != ActionConnect && action.Action != ActionManage {
			actions = append(actions, action)
		}
	}
	return actions
}

var (
	ErrInvalidRequest = errors.New("invalid data resource grant request")
	ErrNotFound       = errors.New("data resource grant not found")
	ErrConflict       = errors.New("data resource grant conflict")
)

type Grant struct {
	GrantID      string    `json:"grant_id"`
	UserID       string    `json:"user_id"`
	ResourceType string    `json:"resource_type"`
	ResourceID   string    `json:"resource_id"`
	Action       string    `json:"action"`
	CreatedBy    string    `json:"created_by"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Filter struct {
	UserID       string
	ResourceType string
	ResourceID   string
	Action       string
}

type SetInput struct {
	UserID       string
	ResourceType string
	ResourceID   string
	Actions      []string
	CreatedBy    string
	OperatorID   string
	RequestID    string
}

type Audit struct {
	AuditID       string
	OperatorID    string
	TargetUserID  string
	ResourceType  string
	ResourceID    string
	BeforeActions []string
	AfterActions  []string
	Result        string
	RequestID     string
	CreatedAt     time.Time
}
