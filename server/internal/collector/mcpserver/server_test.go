package mcpserver

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/krillinai/Clawee/server/internal/collector/codexrunner"
)

type runnerFunc func(context.Context, string) (string, error)

func (fn runnerFunc) Ask(ctx context.Context, question string) (string, error) {
	return fn(ctx, question)
}

type bearerRoundTripper struct {
	token string
}

func (t bearerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.Header = req.Header.Clone()
	clone.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(clone)
}

func TestHandlerRequiresBearerToken(t *testing.T) {
	handler := NewHandler(context.Background(), runnerFunc(func(context.Context, string) (string, error) {
		return "answer", nil
	}), "secret")
	for _, authorization := range []string{"", "Bearer wrong"} {
		req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
		req.Header.Set("Authorization", authorization)
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, req)

		if response.Code != http.StatusUnauthorized {
			t.Fatalf("authorization %q status = %d, want 401", authorization, response.Code)
		}
	}
}

func TestHandlerExposesOnlyCodexAskAndReturnsStructuredAnswer(t *testing.T) {
	var gotQuestion string
	session := connect(t, context.Background(), runnerFunc(func(_ context.Context, question string) (string, error) {
		gotQuestion = question
		return "最终回答", nil
	}))
	defer session.Close()

	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 1 || tools.Tools[0].Name != "codex.ask" {
		t.Fatalf("tools = %#v, want only codex.ask", tools.Tools)
	}
	annotations := tools.Tools[0].Annotations
	if annotations == nil || !annotations.ReadOnlyHint || annotations.DestructiveHint == nil || *annotations.DestructiveHint {
		t.Fatalf("annotations = %#v", annotations)
	}

	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name: "codex.ask", Arguments: map[string]any{"question": "  请处理  "},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError || gotQuestion != "请处理" {
		t.Fatalf("result = %#v, question = %q", result, gotQuestion)
	}
	structured, ok := result.StructuredContent.(map[string]any)
	if !ok || structured["answer"] != "最终回答" {
		t.Fatalf("structured content = %#v", result.StructuredContent)
	}
}

func TestCodexAskReturnsStableToolErrors(t *testing.T) {
	for _, test := range []struct {
		name       string
		question   string
		runnerErr  error
		want       string
		wantCalled bool
	}{
		{name: "blank question", question: "  ", want: "问题不能为空"},
		{name: "busy", question: "q", runnerErr: codexrunner.ErrBusy, want: "Codex B 正忙", wantCalled: true},
		{name: "timeout", question: "q", runnerErr: codexrunner.ErrTimeout, want: "执行超时", wantCalled: true},
		{name: "canceled", question: "q", runnerErr: context.Canceled, want: "执行已取消", wantCalled: true},
		{name: "failure", question: "q", runnerErr: errors.New("details must not leak"), want: "执行失败", wantCalled: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			called := false
			session := connect(t, context.Background(), runnerFunc(func(context.Context, string) (string, error) {
				called = true
				return "", test.runnerErr
			}))
			defer session.Close()

			result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
				Name: "codex.ask", Arguments: map[string]any{"question": test.question},
			})
			if err != nil {
				t.Fatalf("tool error became protocol error: %v", err)
			}
			if !result.IsError || called != test.wantCalled {
				t.Fatalf("result = %#v, called = %v", result, called)
			}
			content, ok := result.Content[0].(*mcp.TextContent)
			if !ok || content.Text != test.want {
				t.Fatalf("content = %#v, want %q", result.Content, test.want)
			}
		})
	}
}

func TestRootContextCancellationReachesRunnerAcrossMCPSession(t *testing.T) {
	rootCtx, cancelRoot := context.WithCancel(context.Background())
	started := make(chan struct{})
	runnerDone := make(chan error, 1)
	session := connect(t, rootCtx, runnerFunc(func(ctx context.Context, _ string) (string, error) {
		close(started)
		<-ctx.Done()
		runnerDone <- ctx.Err()
		return "", ctx.Err()
	}))
	defer session.Close()

	type callResult struct {
		result *mcp.CallToolResult
		err    error
	}
	done := make(chan callResult, 1)
	go func() {
		result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
			Name: "codex.ask", Arguments: map[string]any{"question": "question"},
		})
		done <- callResult{result: result, err: err}
	}()
	<-started
	cancelRoot()

	select {
	case call := <-done:
		if call.err == nil && (call.result == nil || !call.result.IsError) {
			t.Fatalf("result = %#v, error = nil; want failed tool call after root context cancellation", call.result)
		}
	case <-time.After(time.Second):
		t.Fatal("tool call did not stop after root context cancellation")
	}
	select {
	case err := <-runnerDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("runner context error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("runner did not observe root context cancellation")
	}
}

func connect(t *testing.T, rootCtx context.Context, runner QuestionRunner) *mcp.ClientSession {
	t.Helper()
	server := httptest.NewUnstartedServer(NewHandler(rootCtx, runner, "secret"))
	server.Config.BaseContext = func(net.Listener) context.Context {
		return rootCtx
	}
	server.Start()
	t.Cleanup(server.Close)
	client := mcp.NewClient(&mcp.Implementation{Name: "collector-mcp-test", Version: "v0.1.0"}, nil)
	session, err := client.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:             server.URL,
		HTTPClient:           &http.Client{Transport: bearerRoundTripper{token: "secret"}},
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return session
}
