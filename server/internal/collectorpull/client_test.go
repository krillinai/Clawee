package collectorpull

import (
	"context"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestClientListsFixedCodexAskTool(t *testing.T) {
	client := NewClient(NewBroker())
	tools, err := client.ListTools(context.Background(), pullServer(), "must-not-be-used")
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].Name != "codex.ask" || tools[0].InputSchema["type"] != "object" {
		t.Fatalf("tools = %#v", tools)
	}
}

func TestClientSyncsCodexAskThroughGatewayService(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	server := pullServer()
	server.Namespace = "codexb.dev"
	server.Status = mcpgateway.StatusActive
	if err := store.SaveUpstreamServer(context.Background(), server); err != nil {
		t.Fatal(err)
	}
	service := mcpgateway.NewService(mcpgateway.Config{Store: store, UpstreamClient: NewClient(NewBroker())})
	if err := service.SyncTools(context.Background(), server.ID, "agent-token-must-not-be-used"); err != nil {
		t.Fatal(err)
	}
	capabilities, err := store.ListCapabilities(context.Background(), mcpgateway.CapabilityFilter{UpstreamServerID: server.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(capabilities) != 1 || capabilities[0].UpstreamName != "codex.ask" || capabilities[0].ExposedName != "codexb.dev.codex.ask" {
		t.Fatalf("capabilities = %#v", capabilities)
	}
}

func TestClientCallsBrokerAndReturnsStructuredAnswer(t *testing.T) {
	broker := NewBroker()
	client := NewClient(broker)
	go func() {
		delivery, ok, err := broker.Pull(context.Background(), "collector-1")
		if err != nil || !ok {
			return
		}
		_ = broker.Complete("collector-1", collectorapi.TaskResultRequest{
			TaskID: delivery.TaskID, ClaimID: delivery.ClaimID, Status: collectorapi.TaskResultSucceeded,
			Output: &collectorapi.TaskResultOutput{Answer: "已处理"},
		})
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, mcpgateway.UpstreamCallRequest{
		Server: pullServer(), Capability: mcpgateway.Capability{UpstreamName: "codex.ask"},
		Arguments: mcpgateway.JSONMap{"question": " 请处理 "}, TraceID: "trace-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	answer, ok := result.StructuredContent.(mcpgateway.JSONMap)
	if !ok || answer["answer"] != "已处理" || result.IsError {
		t.Fatalf("result = %#v", result)
	}
}

func TestClientReturnsToolErrorWhenCollectorIsBusy(t *testing.T) {
	broker := NewBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for i := 0; i < maxInFlightPerCollector; i++ {
		go func() {
			_, _ = broker.Submit(ctx, Submission{CollectorID: "collector-1", UpstreamServerID: "codexb-dev", Tool: "codex.ask"})
		}()
	}
	deadline := time.Now().Add(time.Second)
	for {
		broker.mu.Lock()
		count := broker.inFlightLocked("collector-1")
		broker.mu.Unlock()
		if count == maxInFlightPerCollector {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("broker did not fill")
		}
		time.Sleep(time.Millisecond)
	}
	result, err := NewClient(broker).CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Server: pullServer(), Capability: mcpgateway.Capability{UpstreamName: "codex.ask"},
		Arguments: mcpgateway.JSONMap{"question": "处理"},
	})
	if err != nil || !result.IsError || len(result.Content) != 1 {
		t.Fatalf("CallTool() = (%#v, %v)", result, err)
	}
}

func pullServer() mcpgateway.UpstreamServer {
	return mcpgateway.UpstreamServer{ID: "codexb-dev", Transport: mcpgateway.TransportCollectorPull, CollectorID: "collector-1"}
}
