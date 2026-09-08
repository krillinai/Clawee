package accountgovernance

import (
	"errors"
	"time"
)

const (
	ActionAgentTransfer = "agent_transfer"
	ActionAccountMerge  = "account_merge"
)

var (
	ErrInvalidRequest           = errors.New("治理请求参数无效")
	ErrSameAccount              = errors.New("源账号和目标账号不能相同")
	ErrAccountNotFound          = errors.New("账号不存在")
	ErrAgentNotFound            = errors.New("Agent 不存在或未绑定账号")
	ErrSourceAccountNotDisabled = errors.New("源账号必须处于 disabled 状态")
	ErrTargetAccountNotActive   = errors.New("目标账号必须处于 active 状态")
	ErrAgentOwnerConflict       = errors.New("Agent 当前归属与源账号不一致")
	ErrAgentOwnerInconsistent   = errors.New("Agent 归属数据不一致")
	ErrIdentityConflict         = errors.New("目标账号已绑定相同类型的外部身份")
	ErrAccountGrantConflict     = errors.New("源账号与目标账号的 MCP Grant 语义冲突")
	ErrPendingGate              = errors.New("Agent 存在待处理或执行中的门禁请求")
)

type TransferAgentInput struct {
	AgentID        string
	SourceUserID   string
	TargetUserID   string
	Reason         string
	OperatorUserID string
	RequestID      string
}

type MergeAccountsInput struct {
	SourceUserID   string
	TargetUserID   string
	Reason         string
	OperatorUserID string
	RequestID      string
}

type Result struct {
	Action          string    `json:"action"`
	AgentIDs        []string  `json:"agent_ids"`
	SourceUserID    string    `json:"source_user_id"`
	TargetUserID    string    `json:"target_user_id"`
	TokensPreserved bool      `json:"tokens_preserved"`
	GrantsPreserved bool      `json:"grants_preserved"`
	TokenCount      int       `json:"token_count"`
	GrantCount      int       `json:"grant_count"`
	CompletedAt     time.Time `json:"completed_at"`
}
