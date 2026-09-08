package mcpserver

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/krillinai/Clawee/server/internal/buildinfo"
	"github.com/krillinai/Clawee/server/internal/collector/codexrunner"
)

type QuestionRunner interface {
	Ask(context.Context, string) (string, error)
}

type CodexAskInput struct {
	Question string `json:"question" jsonschema:"需要 Codex B 处理的问题"`
}

type CodexAskOutput struct {
	Answer string `json:"answer"`
}

func NewHandler(rootCtx context.Context, runner QuestionRunner, bearerToken string) http.Handler {
	if rootCtx == nil {
		rootCtx = context.Background()
	}
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		return newServer(rootCtx, runner)
	}, nil)
	return requireBearerToken(strings.TrimSpace(bearerToken), handler)
}

func newServer(rootCtx context.Context, runner QuestionRunner) *mcp.Server {
	server := mcp.NewServer(
		&mcp.Implementation{Name: "clawee-collector", Version: buildinfo.FullVersion()},
		nil,
	)
	readOnly, destructive := true, false
	mcp.AddTool(server, &mcp.Tool{
		Name:        "codex.ask",
		Title:       "Ask Codex",
		Description: "向本机 Codex 提问并返回最终回答",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    readOnly,
			DestructiveHint: &destructive,
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, input CodexAskInput) (*mcp.CallToolResult, *CodexAskOutput, error) {
		question := strings.TrimSpace(input.Question)
		if question == "" {
			return toolError("问题不能为空"), nil, nil
		}
		if runner == nil {
			return toolError("执行失败"), nil, nil
		}
		runCtx, cancel := context.WithCancel(ctx)
		stopRootCancellation := context.AfterFunc(rootCtx, cancel)
		defer func() {
			stopRootCancellation()
			cancel()
		}()
		answer, err := runner.Ask(runCtx, question)
		if err != nil {
			return toolError(errorMessage(err)), nil, nil
		}
		return nil, &CodexAskOutput{Answer: answer}, nil
	})
	return server
}

func requireBearerToken(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		authorization := r.Header.Get("Authorization")
		provided := ""
		if strings.HasPrefix(authorization, prefix) {
			provided = strings.TrimSpace(strings.TrimPrefix(authorization, prefix))
		}
		if token == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func toolError(message string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: message}},
	}
}

func errorMessage(err error) string {
	switch {
	case errors.Is(err, codexrunner.ErrBusy):
		return "Codex B 正忙"
	case errors.Is(err, codexrunner.ErrTimeout):
		return "执行超时"
	case errors.Is(err, context.Canceled):
		return "执行已取消"
	default:
		return "执行失败"
	}
}
