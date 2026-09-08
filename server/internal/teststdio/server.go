package main

import (
	"context"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	server := mcp.NewServer(&mcp.Implementation{Name: "test-stdio-upstream", Version: "v0.1.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "customer.search",
		Title:       "Search customers",
		Description: "Search customers through stdio",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"keyword": map[string]any{"type": "string"},
			},
		},
		OutputSchema: map[string]any{"type": "object"},
	}, func(ctx context.Context, req *mcp.CallToolRequest, input map[string]any) (*mcp.CallToolResult, map[string]any, error) {
		return nil, map[string]any{
			"items": []any{input["keyword"]},
			"token": os.Getenv("UPSTREAM_TOKEN"),
		}, nil
	})
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		panic(err)
	}
}
