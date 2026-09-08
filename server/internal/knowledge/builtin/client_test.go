package builtin

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/knowledge"
	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestClientListsStableSearchTool(t *testing.T) {
	client, err := NewClient(&stubProvider{}, knowledge.ProviderBailian)
	if err != nil {
		t.Fatal(err)
	}
	tools, err := client.ListTools(context.Background(), mcpgateway.UpstreamServer{ID: knowledge.AdapterServerID}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].Name != knowledge.SearchUpstreamName || tools[0].InputSchema["additionalProperties"] != false {
		t.Fatalf("tools = %#v", tools)
	}
}

func TestClientSearchesBoundKnowledgeBase(t *testing.T) {
	p := &stubProvider{searchResult: provider.SearchResult{Chunks: []provider.SearchChunk{{Text: "制度内容", DocumentName: "guide.md", SourceID: "source-1"}}}}
	client, err := NewClient(p, knowledge.ProviderBailian)
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Server:            mcpgateway.UpstreamServer{ID: knowledge.AdapterServerID},
		Capability:        mcpgateway.Capability{UpstreamName: knowledge.SearchUpstreamName},
		Arguments:         mcpgateway.JSONMap{"query": "policy", "top_k": 3},
		KnowledgeBindings: []mcpgateway.KnowledgeBinding{{KnowledgeBaseID: "kb-1", KnowledgeBaseName: "制度库", ProviderType: knowledge.ProviderBailian, ExternalKnowledgeBaseID: "provider-kb"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.searchRequest.ExternalKnowledgeBaseID != "provider-kb" || p.searchRequest.Query != "policy" || p.searchRequest.TopK != 3 {
		t.Fatalf("search request = %#v", p.searchRequest)
	}
	body, ok := result.StructuredContent.(mcpgateway.JSONMap)
	if !ok || body["chunks"] == nil {
		t.Fatalf("structured content = %#v", result.StructuredContent)
	}
}

func TestClientRejectsMissingBinding(t *testing.T) {
	client, err := NewClient(&stubProvider{}, knowledge.ProviderBailian)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: knowledge.SearchUpstreamName},
		Arguments:  mcpgateway.JSONMap{"query": "policy"},
	})
	if !errors.Is(err, ErrInvalidKnowledgeScope) {
		t.Fatalf("CallTool() error = %v, want ErrInvalidKnowledgeScope", err)
	}
}

func TestClientSearchesKnowledgeBasesConcurrentlyAndAppliesGlobalTopK(t *testing.T) {
	highScore, mediumScore, lowScore := 0.95, 0.80, 0.60
	p := &concurrentSearchProvider{
		started: make(chan string, 2),
		release: make(chan struct{}),
		results: map[string]provider.SearchResult{
			"provider-a": {Chunks: []provider.SearchChunk{
				{Text: "A high", DocumentName: "a.md", SourceID: "a-high", Score: &highScore},
				{Text: "A low", DocumentName: "a.md", SourceID: "a-low", Score: &lowScore},
			}},
			"provider-b": {Chunks: []provider.SearchChunk{
				{Text: "B medium", DocumentName: "b.md", SourceID: "b-medium", Score: &mediumScore},
			}},
		},
	}
	client, err := NewClient(p, knowledge.ProviderBailian)
	if err != nil {
		t.Fatal(err)
	}
	type callResult struct {
		result mcpgateway.UpstreamCallResult
		err    error
	}
	done := make(chan callResult, 1)
	go func() {
		result, callErr := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
			Capability: mcpgateway.Capability{UpstreamName: knowledge.SearchUpstreamName},
			Arguments:  mcpgateway.JSONMap{"query": "policy", "top_k": 2},
			KnowledgeBindings: []mcpgateway.KnowledgeBinding{
				{KnowledgeBaseID: "kb-a", KnowledgeBaseName: "制度库", ProviderType: knowledge.ProviderBailian, ExternalKnowledgeBaseID: "provider-a"},
				{KnowledgeBaseID: "kb-b", KnowledgeBaseName: "产品库", ProviderType: knowledge.ProviderBailian, ExternalKnowledgeBaseID: "provider-b"},
			},
		})
		done <- callResult{result: result, err: callErr}
	}()
	for range 2 {
		select {
		case <-p.started:
		case <-time.After(time.Second):
			t.Fatal("knowledge searches did not start concurrently")
		}
	}
	close(p.release)
	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}
	body := got.result.StructuredContent.(mcpgateway.JSONMap)
	chunks := body["chunks"].([]any)
	if len(chunks) != 2 || chunks[0].(mcpgateway.JSONMap)["source_id"] != "a-high" || chunks[1].(mcpgateway.JSONMap)["source_id"] != "b-medium" {
		t.Fatalf("chunks = %#v", chunks)
	}
	if chunks[0].(mcpgateway.JSONMap)["knowledge_base_id"] != "kb-a" || body["searched_knowledge_base_count"] != 2 || body["partial"] != false {
		t.Fatalf("body = %#v", body)
	}
}

func TestClientReturnsPartialResultsWithSanitizedFailures(t *testing.T) {
	p := &concurrentSearchProvider{
		results: map[string]provider.SearchResult{"provider-a": {Chunks: []provider.SearchChunk{{Text: "A", DocumentName: "a.md", SourceID: "a"}}}},
		errors:  map[string]error{"provider-b": &provider.ProviderError{Code: provider.ErrorRateLimited, ProviderMessage: "secret"}},
	}
	client, err := NewClient(p, knowledge.ProviderBailian)
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: knowledge.SearchUpstreamName},
		Arguments:  mcpgateway.JSONMap{"query": "policy", "top_k": 5},
		KnowledgeBindings: []mcpgateway.KnowledgeBinding{
			{KnowledgeBaseID: "kb-a", ProviderType: knowledge.ProviderBailian, ExternalKnowledgeBaseID: "provider-a"},
			{KnowledgeBaseID: "kb-b", ProviderType: knowledge.ProviderBailian, ExternalKnowledgeBaseID: "provider-b"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	body := result.StructuredContent.(mcpgateway.JSONMap)
	failures := body["failures"].([]any)
	if body["partial"] != true || body["successful_knowledge_base_count"] != 1 || len(failures) != 1 {
		t.Fatalf("body = %#v", body)
	}
	failure := failures[0].(mcpgateway.JSONMap)
	if failure["knowledge_base_id"] != "kb-b" || failure["code"] != provider.ErrorRateLimited {
		t.Fatalf("failure = %#v", failure)
	}
}

func TestClientReturnsErrorWhenEveryKnowledgeBaseFails(t *testing.T) {
	p := &concurrentSearchProvider{errors: map[string]error{
		"provider-a": &provider.ProviderError{Code: provider.ErrorTimeout},
		"provider-b": &provider.ProviderError{Code: provider.ErrorRateLimited},
	}}
	client, err := NewClient(p, knowledge.ProviderBailian)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: knowledge.SearchUpstreamName},
		Arguments:  mcpgateway.JSONMap{"query": "policy", "top_k": 5},
		KnowledgeBindings: []mcpgateway.KnowledgeBinding{
			{KnowledgeBaseID: "kb-a", ProviderType: knowledge.ProviderBailian, ExternalKnowledgeBaseID: "provider-a"},
			{KnowledgeBaseID: "kb-b", ProviderType: knowledge.ProviderBailian, ExternalKnowledgeBaseID: "provider-b"},
		},
	})
	if err == nil {
		t.Fatal("CallTool() error = nil")
	}
}

type stubProvider struct {
	searchRequest provider.SearchRequest
	searchResult  provider.SearchResult
	searchErr     error
}

type concurrentSearchProvider struct {
	stubProvider
	mu      sync.Mutex
	started chan string
	release chan struct{}
	results map[string]provider.SearchResult
	errors  map[string]error
}

func (p *concurrentSearchProvider) Search(ctx context.Context, req provider.SearchRequest) (provider.SearchResult, error) {
	if p.started != nil {
		p.started <- req.ExternalKnowledgeBaseID
	}
	if p.release != nil {
		select {
		case <-p.release:
		case <-ctx.Done():
			return provider.SearchResult{}, ctx.Err()
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.results[req.ExternalKnowledgeBaseID], p.errors[req.ExternalKnowledgeBaseID]
}

func (p *stubProvider) CreateKnowledgeBase(context.Context, provider.CreateKnowledgeBaseRequest) (provider.ProviderKnowledgeBase, error) {
	return provider.ProviderKnowledgeBase{}, nil
}
func (p *stubProvider) DeleteKnowledgeBase(context.Context, string) error { return nil }
func (p *stubProvider) UploadDocument(context.Context, string, provider.DocumentFile) (provider.ProviderDocument, error) {
	return provider.ProviderDocument{}, nil
}
func (p *stubProvider) ListDocuments(context.Context, string) ([]provider.ProviderDocument, error) {
	return nil, nil
}
func (p *stubProvider) DeleteDocument(context.Context, string, string) error { return nil }
func (p *stubProvider) Search(_ context.Context, req provider.SearchRequest) (provider.SearchResult, error) {
	p.searchRequest = req
	return p.searchResult, p.searchErr
}
