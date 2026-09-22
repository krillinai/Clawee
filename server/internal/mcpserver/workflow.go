package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/krillinai/Clawee/server/internal/mcpauth"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/workflow"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type workflowListInput struct {
	Cursor string `json:"cursor,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}
type workflowGetInput struct {
	TaskID string `json:"task_id"`
}
type workflowCompleteInput struct {
	TaskID string          `json:"task_id"`
	Output json.RawMessage `json:"output"`
	Key    string          `json:"idempotency_key"`
}
type workflowListOutput struct {
	Tasks      []workflow.Task `json:"tasks"`
	NextCursor string          `json:"next_cursor"`
}

func workflowObjectSchema[T any](nullable bool) *jsonschema.Schema {
	rawSchema := &jsonschema.Schema{Type: "object"}
	if nullable {
		rawSchema = &jsonschema.Schema{Types: []string{"object", "null"}}
	}
	schema, err := jsonschema.For[T](&jsonschema.ForOptions{TypeSchemas: map[reflect.Type]*jsonschema.Schema{
		reflect.TypeFor[json.RawMessage](): rawSchema,
	}})
	if err != nil {
		panic(err)
	}
	return schema
}

func workflowToolError(err error) *mcp.CallToolResult {
	code := "internal_error"
	switch {
	case errors.Is(err, workflow.ErrInvalid):
		code = "invalid_request"
	case errors.Is(err, workflow.ErrLarge):
		code = "payload_too_large"
	case errors.Is(err, workflow.ErrMissing):
		code = "not_found"
	case errors.Is(err, workflow.ErrForbidden):
		code = "forbidden"
	case errors.Is(err, workflow.ErrConflict):
		code = "conflict"
	}
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: code}}}
}

func workflowIdentity(ctx context.Context, req *mcp.CallToolRequest, opts Options) (mcpgateway.AgentIdentity, error) {
	if req == nil || req.Extra == nil || opts.Accounts == nil || opts.ProxyGateway == nil {
		return mcpgateway.AgentIdentity{}, workflow.ErrForbidden
	}
	identity, err := mcpauth.IdentityFromTokenInfo(req.Extra.TokenInfo)
	if err != nil || identity.UserID == "" || identity.AgentID == "" || req.Extra.Header.Get("X-Claw-Agent-ID") != identity.AgentID {
		return mcpgateway.AgentIdentity{}, workflow.ErrForbidden
	}
	owner, err := opts.Accounts.AccountForAgent(ctx, identity.AgentID)
	if err != nil || owner.UserID != identity.UserID || owner.Status != "active" {
		return mcpgateway.AgentIdentity{}, workflow.ErrForbidden
	}
	agent, err := opts.ProxyGateway.Store().GetAgent(ctx, identity.AgentID)
	if err != nil || agent.Status != mcpgateway.StatusActive {
		return mcpgateway.AgentIdentity{}, workflow.ErrForbidden
	}
	return identity, nil
}

func addWorkflowTools(server *mcp.Server, opts Options) {
	mcp.AddTool(server, &mcp.Tool{Name: "workflow_list_tasks", Description: "列出当前账号的 Agent 工作流待办", OutputSchema: workflowObjectSchema[workflowListOutput](true)}, func(ctx context.Context, req *mcp.CallToolRequest, input workflowListInput) (*mcp.CallToolResult, *workflowListOutput, error) {
		identity, err := workflowIdentity(ctx, req, opts)
		if err != nil {
			return workflowToolError(err), nil, nil
		}
		items, next, err := opts.Workflow.Tasks(ctx, identity.UserID, "agent", input.Limit, input.Cursor)
		if err != nil {
			return workflowToolError(err), nil, nil
		}
		for i := range items {
			items[i].Input = nil
		}
		return nil, &workflowListOutput{Tasks: items, NextCursor: next}, nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "workflow_get_task", Description: "读取本人当前 Agent 节点的指令和输入", OutputSchema: workflowObjectSchema[workflow.Task](true)}, func(ctx context.Context, req *mcp.CallToolRequest, input workflowGetInput) (*mcp.CallToolResult, *workflow.Task, error) {
		identity, err := workflowIdentity(ctx, req, opts)
		if err != nil {
			return workflowToolError(err), nil, nil
		}
		item, err := opts.Workflow.Task(ctx, input.TaskID, identity.UserID, "agent")
		if err != nil {
			return workflowToolError(err), nil, nil
		}
		return nil, &item, nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "workflow_complete_task", Description: "提交本人 Agent 节点的 JSON 对象输出", InputSchema: workflowObjectSchema[workflowCompleteInput](false), OutputSchema: workflowObjectSchema[workflow.Result](true)}, func(ctx context.Context, req *mcp.CallToolRequest, input workflowCompleteInput) (*mcp.CallToolResult, *workflow.Result, error) {
		identity, err := workflowIdentity(ctx, req, opts)
		if err != nil {
			return workflowToolError(err), nil, nil
		}
		result, err := opts.Workflow.Complete(ctx, input.TaskID, identity.UserID, identity.AgentID, input.Key, "", "", input.Output)
		if err != nil {
			return workflowToolError(err), nil, nil
		}
		if result.NextTask != nil && result.NextTask.Assignee != identity.UserID {
			result.NextTask.ID = ""
		}
		return nil, &result, nil
	})
}
