package collectorpull

import (
	"context"
	"errors"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type Client struct {
	broker *Broker
}

func NewClient(broker *Broker) *Client {
	return &Client{broker: broker}
}

func (c *Client) ListTools(_ context.Context, server mcpgateway.UpstreamServer, _ string) ([]mcpgateway.UpstreamTool, error) {
	if err := validateServer(server); err != nil {
		return nil, err
	}
	return []mcpgateway.UpstreamTool{{
		Name:        "codex.ask",
		Title:       "Ask Codex",
		Description: "向 Codex B 提问并返回最终回答",
		InputSchema: mcpgateway.JSONMap{
			"type":     "object",
			"required": []any{"question"},
			"properties": mcpgateway.JSONMap{
				"question": mcpgateway.JSONMap{"type": "string", "minLength": 1},
			},
			"additionalProperties": false,
		},
		OutputSchema: mcpgateway.JSONMap{
			"type":     "object",
			"required": []any{"answer"},
			"properties": mcpgateway.JSONMap{
				"answer": mcpgateway.JSONMap{"type": "string"},
			},
			"additionalProperties": false,
		},
		Annotations: mcpgateway.JSONMap{"readOnlyHint": true, "destructiveHint": false},
	}}, nil
}

func (c *Client) CallTool(ctx context.Context, req mcpgateway.UpstreamCallRequest) (mcpgateway.UpstreamCallResult, error) {
	if err := validateServer(req.Server); err != nil {
		return mcpgateway.UpstreamCallResult{}, err
	}
	if req.Capability.UpstreamName != "codex.ask" {
		return mcpgateway.UpstreamCallResult{}, mcpgateway.ErrInvalidUpstreamConfig
	}
	question, ok := req.Arguments["question"].(string)
	question = strings.TrimSpace(question)
	if !ok || question == "" {
		return mcpgateway.UpstreamCallResult{}, ErrInvalid
	}
	if c == nil || c.broker == nil {
		return mcpgateway.UpstreamCallResult{}, errors.New("collector pull broker is not configured")
	}
	completion, err := c.broker.Submit(ctx, Submission{
		CollectorID:      req.Server.CollectorID,
		UpstreamServerID: req.Server.ID,
		TraceID:          req.TraceID,
		Tool:             req.Capability.UpstreamName,
		Arguments:        map[string]any{"question": question},
	})
	if err != nil {
		if errors.Is(err, ErrBusy) {
			return mcpgateway.UpstreamCallResult{
				IsError:           true,
				Content:           []mcp.Content{&mcp.TextContent{Text: "Codex B 正忙"}},
				StructuredContent: mcpgateway.JSONMap{"error": "Codex B 正忙"},
				ResponseHeaders:   mcpgateway.JSONMap{},
			}, nil
		}
		return mcpgateway.UpstreamCallResult{}, err
	}
	result := mcpgateway.UpstreamCallResult{SessionID: completion.TaskID, ResponseHeaders: mcpgateway.JSONMap{}}
	if completion.Status == collectorapi.TaskResultSucceeded && completion.Output != nil {
		result.StructuredContent = mcpgateway.JSONMap{"answer": completion.Output.Answer}
		result.Content = []mcp.Content{&mcp.TextContent{Text: completion.Output.Answer}}
		return result, nil
	}
	message := "执行失败"
	if completion.Error != nil && strings.TrimSpace(completion.Error.Message) != "" {
		message = strings.TrimSpace(completion.Error.Message)
	}
	result.IsError = true
	result.Content = []mcp.Content{&mcp.TextContent{Text: message}}
	result.StructuredContent = mcpgateway.JSONMap{"error": message}
	return result, nil
}

func validateServer(server mcpgateway.UpstreamServer) error {
	if server.Transport != mcpgateway.TransportCollectorPull || strings.TrimSpace(server.CollectorID) == "" {
		return mcpgateway.ErrInvalidUpstreamConfig
	}
	return nil
}
