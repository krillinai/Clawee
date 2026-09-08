package server

import (
	"testing"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestMCPCatalogIconURL(t *testing.T) {
	tests := []struct {
		name       string
		upstreamID string
		want       string
	}{
		{
			name:       "knowledge adapter",
			upstreamID: mcpgateway.KnowledgeAdapterServerID,
			want:       "/assets/app-icons/knowledge-base-24aee5a4.png",
		},
		{
			name:       "generic MCP upstream",
			upstreamID: "crm-main",
			want:       "/assets/app-icons/mcp-f654f2a2.png",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := mcpCatalogIconURL(test.upstreamID); got != test.want {
				t.Fatalf("mcpCatalogIconURL() = %q, want %q", got, test.want)
			}
		})
	}
}
