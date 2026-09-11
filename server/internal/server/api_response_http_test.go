package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestUnifiedAPIResponseNormalizesResourceLists(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(unifiedAPIResponse())
	router.GET("/items", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"items": []gin.H{{"AgentID": "agent_1", "CreatedAt": "now"}}})
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/items", nil))

	want := `{"data":[{"agent_id":"agent_1","created_at":"now"}],"meta":{"has_next":false,"next_cursor":""}}`
	if recorder.Code != http.StatusOK || recorder.Body.String() != want {
		t.Fatalf("response = %d %s, want %d %s", recorder.Code, recorder.Body.String(), http.StatusOK, want)
	}
}

func TestUnifiedAPIResponseNormalizesErrors(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(unifiedAPIResponse())
	router.GET("/missing", func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"error": "agent not found"})
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/missing", nil))

	want := `{"error":{"code":"not_found","details":[],"message":"agent not found"}}`
	if recorder.Code != http.StatusNotFound || recorder.Body.String() != want {
		t.Fatalf("response = %d %s, want %d %s", recorder.Code, recorder.Body.String(), http.StatusNotFound, want)
	}
}

func TestUnifiedAPIResponsePreservesOpaqueJSONAndPrefersExplicitSnakeCase(t *testing.T) {
	payload := map[string]any{
		"authorization_header": "Bearer target",
		"authorizationHeader":  "Authorization: Bearer legacy",
		"InputSchema": map[string]any{
			"properties": map[string]any{"customerId": map[string]any{"type": "string"}},
		},
		"mcp_config":          map[string]any{"mcpServers": map[string]any{"clawee-gateway": map[string]any{"url": "/mcp"}}},
		"input":               map[string]any{"customerId": "customer_1"},
		"response":            map[string]any{"orderId": "order_1"},
		"resolved_data_scope": map[string]any{"customerId": "customer_1"},
	}
	normalized := normalizeAPIResponse(http.StatusOK, payload).(map[string]any)["data"].(map[string]any)
	if normalized["authorization_header"] != "Bearer target" {
		t.Fatalf("authorization_header = %#v", normalized["authorization_header"])
	}
	schema := normalized["input_schema"].(map[string]any)
	properties := schema["properties"].(map[string]any)
	if _, ok := properties["customerId"]; !ok {
		t.Fatalf("input_schema keys were modified: %#v", schema)
	}
	config := normalized["mcp_config"].(map[string]any)
	if _, ok := config["mcpServers"]; !ok {
		t.Fatalf("mcp_config keys were modified: %#v", config)
	}
	if _, ok := normalized["input"].(map[string]any)["customerId"]; !ok {
		t.Fatalf("input keys were modified: %#v", normalized["input"])
	}
	if _, ok := normalized["response"].(map[string]any)["orderId"]; !ok {
		t.Fatalf("response keys were modified: %#v", normalized["response"])
	}
	if _, ok := normalized["resolved_data_scope"].(map[string]any)["customerId"]; !ok {
		t.Fatalf("resolved_data_scope keys were modified: %#v", normalized["resolved_data_scope"])
	}
}

func TestUnifiedAPIResponseNormalizesJSONErrorsForBinaryPaths(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(unifiedAPIResponse())
	router.GET("/skills/version-package", func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"code": "not_found", "error": "package not found"})
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/skills/version-package", nil))

	want := `{"error":{"code":"not_found","details":[],"message":"package not found"}}`
	if recorder.Code != http.StatusNotFound || recorder.Body.String() != want {
		t.Fatalf("response = %d %s, want %d %s", recorder.Code, recorder.Body.String(), http.StatusNotFound, want)
	}
}

func TestUnifiedAPIResponseNormalizesParameterizedRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(unifiedAPIResponse())
	router.GET("/items/:item_id", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ItemID": c.Param("item_id")})
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/items/item_1", nil))

	want := `{"data":{"item_id":"item_1"}}`
	if recorder.Code != http.StatusOK || recorder.Body.String() != want {
		t.Fatalf("response = %d %s, want %d %s", recorder.Code, recorder.Body.String(), http.StatusOK, want)
	}
}

func TestUnifiedAPIResponsePassesThroughDownloads(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(unifiedAPIResponse())
	router.GET("/download", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/octet-stream", []byte("package"))
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/download", nil))

	if recorder.Code != http.StatusOK || recorder.Body.String() != "package" {
		t.Fatalf("response = %d %q, want %d %q", recorder.Code, recorder.Body.String(), http.StatusOK, "package")
	}
}

func TestUnifiedAPIResponsePassesThroughSSE(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(unifiedAPIResponse())
	router.GET("/events", func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.WriteString("event: ready\ndata: {}\n\n")
		c.Writer.Flush()
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/events", nil))

	want := "event: ready\ndata: {}\n\n"
	if recorder.Code != http.StatusOK || recorder.Body.String() != want {
		t.Fatalf("response = %d %q, want %d %q", recorder.Code, recorder.Body.String(), http.StatusOK, want)
	}
}
