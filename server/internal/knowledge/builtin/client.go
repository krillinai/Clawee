package builtin

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"

	"github.com/krillinai/Clawee/server/internal/knowledge"
	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

var ErrInvalidKnowledgeScope = errors.New("invalid_knowledge_scope")

type Client struct {
	provider     provider.KnowledgeProvider
	providerType string
}

func NewClient(p provider.KnowledgeProvider, providerType string) (*Client, error) {
	if p == nil || strings.TrimSpace(providerType) == "" {
		return nil, errors.New("invalid builtin knowledge configuration")
	}
	return &Client{provider: p, providerType: providerType}, nil
}

func (c *Client) ListTools(context.Context, mcpgateway.UpstreamServer, string) ([]mcpgateway.UpstreamTool, error) {
	return []mcpgateway.UpstreamTool{{
		Name:         knowledge.SearchUpstreamName,
		Title:        "检索企业知识库",
		Description:  "检索已授权的企业知识库",
		InputSchema:  searchInputSchema(),
		OutputSchema: searchOutputSchema(),
		Annotations: mcpgateway.JSONMap{
			"readOnlyHint":    true,
			"destructiveHint": false,
		},
	}}, nil
}

func (c *Client) CallTool(ctx context.Context, req mcpgateway.UpstreamCallRequest) (mcpgateway.UpstreamCallResult, error) {
	if req.Capability.UpstreamName != knowledge.SearchUpstreamName {
		return mcpgateway.UpstreamCallResult{}, errors.New("unsupported builtin knowledge tool")
	}
	bindings := req.KnowledgeBindings
	if len(bindings) == 0 {
		return mcpgateway.UpstreamCallResult{}, ErrInvalidKnowledgeScope
	}
	for _, binding := range bindings {
		if strings.TrimSpace(binding.KnowledgeBaseID) == "" {
			return mcpgateway.UpstreamCallResult{}, ErrInvalidKnowledgeScope
		}
		if binding.ErrorCode == "" && (binding.ProviderType != c.providerType || strings.TrimSpace(binding.ExternalKnowledgeBaseID) == "") {
			return mcpgateway.UpstreamCallResult{}, ErrInvalidKnowledgeScope
		}
	}
	query, _ := req.Arguments["query"].(string)
	query = strings.TrimSpace(query)
	topK, ok := integerArgument(req.Arguments["top_k"])
	if !ok || query == "" || topK < 1 || topK > 20 {
		return mcpgateway.UpstreamCallResult{}, errors.New("invalid_input")
	}

	providerCtx, cancel := context.WithTimeout(ctx, knowledge.KnowledgeOperationTimeout)
	defer cancel()
	type searchOutcome struct {
		binding knowledge.Binding
		result  provider.SearchResult
		err     error
	}
	outcomes := make([]searchOutcome, len(bindings))
	semaphore := make(chan struct{}, knowledge.MaxConcurrentSearches)
	var wait sync.WaitGroup
	for index, binding := range bindings {
		wait.Add(1)
		go func() {
			defer wait.Done()
			outcomes[index].binding = binding
			if binding.ErrorCode != "" {
				outcomes[index].err = &provider.ProviderError{Code: binding.ErrorCode}
				return
			}
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-providerCtx.Done():
				outcomes[index].err = providerCtx.Err()
				return
			}
			outcomes[index].result, outcomes[index].err = c.provider.Search(providerCtx, provider.SearchRequest{
				ExternalKnowledgeBaseID: binding.ExternalKnowledgeBaseID,
				Query:                   query,
				TopK:                    topK,
			})
		}()
	}
	wait.Wait()

	type rankedChunk struct {
		binding knowledge.Binding
		chunk   provider.SearchChunk
	}
	ranked := make([]rankedChunk, 0, len(bindings)*topK)
	failures := make([]any, 0)
	successful := 0
	var firstErr error
	for _, outcome := range outcomes {
		if outcome.err != nil {
			if firstErr == nil {
				firstErr = outcome.err
			}
			failures = append(failures, mcpgateway.JSONMap{
				"knowledge_base_id": outcome.binding.KnowledgeBaseID,
				"code":              knowledgeSearchErrorCode(outcome.err),
			})
			continue
		}
		successful++
		for _, chunk := range outcome.result.Chunks {
			ranked = append(ranked, rankedChunk{binding: outcome.binding, chunk: chunk})
		}
	}
	if successful == 0 {
		return mcpgateway.UpstreamCallResult{}, firstErr
	}

	deduplicated := make([]rankedChunk, 0, len(ranked))
	indexBySource := make(map[string]int, len(ranked))
	for _, item := range ranked {
		key := item.binding.KnowledgeBaseID + "\x00" + item.chunk.SourceID
		if existing, ok := indexBySource[key]; ok {
			if higherScore(item.chunk.Score, deduplicated[existing].chunk.Score) {
				deduplicated[existing] = item
			}
			continue
		}
		indexBySource[key] = len(deduplicated)
		deduplicated = append(deduplicated, item)
	}
	sort.SliceStable(deduplicated, func(i, j int) bool {
		left, right := deduplicated[i], deduplicated[j]
		if higherScore(left.chunk.Score, right.chunk.Score) {
			return true
		}
		if higherScore(right.chunk.Score, left.chunk.Score) {
			return false
		}
		if left.binding.KnowledgeBaseID != right.binding.KnowledgeBaseID {
			return left.binding.KnowledgeBaseID < right.binding.KnowledgeBaseID
		}
		return left.chunk.SourceID < right.chunk.SourceID
	})
	if len(deduplicated) > topK {
		deduplicated = deduplicated[:topK]
	}

	chunks := make([]any, 0, len(deduplicated))
	for _, rankedChunk := range deduplicated {
		chunk := rankedChunk.chunk
		item := mcpgateway.JSONMap{
			"text":                chunk.Text,
			"knowledge_base_id":   rankedChunk.binding.KnowledgeBaseID,
			"knowledge_base_name": rankedChunk.binding.KnowledgeBaseName,
			"document_name":       chunk.DocumentName,
			"source_id":           chunk.SourceID,
		}
		if chunk.Section != "" {
			item["section"] = chunk.Section
		}
		if chunk.Score != nil {
			item["score"] = *chunk.Score
		}
		chunks = append(chunks, item)
	}
	return mcpgateway.UpstreamCallResult{
		StructuredContent: mcpgateway.JSONMap{
			"chunks":                          chunks,
			"searched_knowledge_base_count":   len(bindings),
			"successful_knowledge_base_count": successful,
			"partial":                         len(failures) > 0,
			"failures":                        failures,
		},
	}, nil
}

func higherScore(left, right *float64) bool {
	if left == nil {
		return false
	}
	return right == nil || *left > *right
}

func knowledgeSearchErrorCode(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return provider.ErrorTimeout
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	var providerErr *provider.ProviderError
	if errors.As(err, &providerErr) && providerErr.Code != "" {
		return providerErr.Code
	}
	return provider.ErrorInternal
}

func integerArgument(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case float64:
		integer := int(typed)
		return integer, typed == float64(integer)
	default:
		return 0, false
	}
}

func searchInputSchema() mcpgateway.JSONMap {
	return mcpgateway.JSONMap{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"query"},
		"properties": mcpgateway.JSONMap{
			"query": mcpgateway.JSONMap{"type": "string", "minLength": 1, "maxLength": 4000},
			"top_k": mcpgateway.JSONMap{"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
		},
	}
}

func searchOutputSchema() mcpgateway.JSONMap {
	return mcpgateway.JSONMap{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"chunks", "searched_knowledge_base_count", "successful_knowledge_base_count", "partial", "failures"},
		"properties": mcpgateway.JSONMap{
			"chunks": mcpgateway.JSONMap{
				"type": "array",
				"items": mcpgateway.JSONMap{
					"type":                 "object",
					"additionalProperties": false,
					"required":             []any{"text", "knowledge_base_id", "knowledge_base_name", "document_name", "source_id"},
					"properties": mcpgateway.JSONMap{
						"text": mcpgateway.JSONMap{"type": "string"}, "knowledge_base_id": mcpgateway.JSONMap{"type": "string"}, "knowledge_base_name": mcpgateway.JSONMap{"type": "string"},
						"document_name": mcpgateway.JSONMap{"type": "string"}, "source_id": mcpgateway.JSONMap{"type": "string"}, "section": mcpgateway.JSONMap{"type": "string"}, "score": mcpgateway.JSONMap{"type": "number"},
					},
				},
			},
			"searched_knowledge_base_count":   mcpgateway.JSONMap{"type": "integer", "minimum": 1},
			"successful_knowledge_base_count": mcpgateway.JSONMap{"type": "integer", "minimum": 1},
			"partial":                         mcpgateway.JSONMap{"type": "boolean"},
			"failures": mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{
				"type": "object", "additionalProperties": false, "required": []any{"knowledge_base_id", "code"},
				"properties": mcpgateway.JSONMap{"knowledge_base_id": mcpgateway.JSONMap{"type": "string"}, "code": mcpgateway.JSONMap{"type": "string"}},
			}},
		},
	}
}
