package mcpgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var (
	ErrUnsupportedTransport  = errors.New("unsupported upstream mcp transport")
	ErrInvalidUpstreamConfig = errors.New("invalid upstream mcp server config")
	ErrUpstreamUnauthorized  = errors.New("upstream mcp server unauthorized")
)

const mcpToolCallTimeout = 7500 * time.Second

type ProgressHandler func(context.Context, *mcp.ProgressNotificationParams)

type UpstreamTool struct {
	Name         string
	Title        string
	Description  string
	InputSchema  JSONMap
	OutputSchema JSONMap
	Annotations  JSONMap
}

type SessionKey struct {
	InboundSessionID string
	AgentID          string
	ActorID          string
	TenantID         string
	UpstreamServerID string
	TokenHash        string
}

type UpstreamCallRequest struct {
	Server            UpstreamServer
	Capability        Capability
	Arguments         JSONMap
	BearerToken       string
	SessionKey        SessionKey
	InboundSessionID  string
	KnowledgeBindings []KnowledgeBinding
	TraceID           string
	Caller            AgentIdentity
	ProgressToken     any
	ProgressHandler   ProgressHandler
}

type UpstreamCallResult struct {
	SessionID         string
	Content           []mcp.Content
	StructuredContent any
	IsError           bool
	ResponseHeaders   JSONMap
}

type UpstreamClient interface {
	ListTools(ctx context.Context, server UpstreamServer, bearerToken string) ([]UpstreamTool, error)
	CallTool(ctx context.Context, req UpstreamCallRequest) (UpstreamCallResult, error)
}

type RoutingUpstreamClient struct {
	fallback UpstreamClient
	mu       sync.RWMutex
	routes   map[string]UpstreamClient
}

type TransportRoutingUpstreamClient struct {
	fallback UpstreamClient
	routes   map[string]UpstreamClient
}

func NewTransportRoutingUpstreamClient(fallback UpstreamClient, routes map[string]UpstreamClient) *TransportRoutingUpstreamClient {
	copied := make(map[string]UpstreamClient, len(routes))
	for transport, client := range routes {
		if normalized := normalizeTransport(transport); normalized != "" && client != nil {
			copied[normalized] = client
		}
	}
	return &TransportRoutingUpstreamClient{fallback: fallback, routes: copied}
}

func (c *TransportRoutingUpstreamClient) ListTools(ctx context.Context, server UpstreamServer, bearerToken string) ([]UpstreamTool, error) {
	client, err := c.clientFor(server.Transport)
	if err != nil {
		return nil, err
	}
	return client.ListTools(ctx, server, bearerToken)
}

func (c *TransportRoutingUpstreamClient) CallTool(ctx context.Context, req UpstreamCallRequest) (UpstreamCallResult, error) {
	client, err := c.clientFor(req.Server.Transport)
	if err != nil {
		return UpstreamCallResult{}, err
	}
	return client.CallTool(ctx, req)
}

func (c *TransportRoutingUpstreamClient) clientFor(transport string) (UpstreamClient, error) {
	if c != nil {
		if client := c.routes[normalizeTransport(transport)]; client != nil {
			return client, nil
		}
		if c.fallback != nil {
			return c.fallback, nil
		}
	}
	return nil, errors.New("upstream mcp client is not configured")
}

func NewRoutingUpstreamClient(fallback UpstreamClient, routes map[string]UpstreamClient) *RoutingUpstreamClient {
	copied := make(map[string]UpstreamClient, len(routes))
	for serverID, client := range routes {
		if strings.TrimSpace(serverID) != "" && client != nil {
			copied[serverID] = client
		}
	}
	return &RoutingUpstreamClient{fallback: fallback, routes: copied}
}

func (c *RoutingUpstreamClient) ListTools(ctx context.Context, server UpstreamServer, bearerToken string) ([]UpstreamTool, error) {
	client, err := c.clientFor(server.ID)
	if err != nil {
		return nil, err
	}
	return client.ListTools(ctx, server, bearerToken)
}

func (c *RoutingUpstreamClient) CallTool(ctx context.Context, req UpstreamCallRequest) (UpstreamCallResult, error) {
	client, err := c.clientFor(req.Server.ID)
	if err != nil {
		return UpstreamCallResult{}, err
	}
	return client.CallTool(ctx, req)
}

func (c *RoutingUpstreamClient) Register(serverID string, client UpstreamClient) error {
	serverID = strings.TrimSpace(serverID)
	if c == nil || serverID == "" || client == nil {
		return errors.New("invalid upstream route")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.routes == nil {
		c.routes = map[string]UpstreamClient{}
	}
	if c.routes[serverID] != nil {
		return fmt.Errorf("upstream route already registered: %s", serverID)
	}
	c.routes[serverID] = client
	return nil
}

func (c *RoutingUpstreamClient) clientFor(serverID string) (UpstreamClient, error) {
	if c != nil {
		c.mu.RLock()
		defer c.mu.RUnlock()
		if client := c.routes[serverID]; client != nil {
			return client, nil
		}
		if c.fallback != nil {
			return c.fallback, nil
		}
	}
	return nil, errors.New("upstream mcp client is not configured")
}

type SDKUpstreamClient struct {
	clientName string
}

func NewSDKUpstreamClient(clientName string) *SDKUpstreamClient {
	if clientName == "" {
		clientName = "claw-mcp-gateway"
	}
	return &SDKUpstreamClient{clientName: clientName}
}

func (c *SDKUpstreamClient) ListTools(ctx context.Context, server UpstreamServer, bearerToken string) ([]UpstreamTool, error) {
	session, err := c.connect(ctx, server, bearerToken, nil)
	if err != nil {
		return nil, err
	}
	defer session.Close()

	result, err := session.ListTools(ctx, nil)
	if err != nil {
		return nil, err
	}
	out := make([]UpstreamTool, 0, len(result.Tools))
	for _, tool := range result.Tools {
		out = append(out, UpstreamTool{
			Name:         tool.Name,
			Title:        tool.Title,
			Description:  tool.Description,
			InputSchema:  schemaToJSONMap(tool.InputSchema),
			OutputSchema: valueToJSONMap(tool.OutputSchema),
			Annotations:  valueToJSONMap(tool.Annotations),
		})
	}
	return out, nil
}

func valueToJSONMap(value any) JSONMap {
	if value == nil {
		return JSONMap{}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return JSONMap{}
	}
	var out JSONMap
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return JSONMap{}
	}
	return out
}

func (c *SDKUpstreamClient) CallTool(ctx context.Context, req UpstreamCallRequest) (UpstreamCallResult, error) {
	progressToken, err := normalizeSDKProgressToken(req.ProgressToken)
	if err != nil {
		return UpstreamCallResult{}, err
	}

	var options *mcp.ClientOptions
	if req.ProgressHandler != nil {
		options = &mcp.ClientOptions{
			ProgressNotificationHandler: func(ctx context.Context, notification *mcp.ProgressNotificationClientRequest) {
				req.ProgressHandler(ctx, notification.Params)
			},
		}
	}
	session, err := c.connect(ctx, req.Server, req.BearerToken, options)
	if err != nil {
		return UpstreamCallResult{}, err
	}
	defer session.Close()

	params := &mcp.CallToolParams{
		Name:      req.Capability.UpstreamName,
		Arguments: req.Arguments,
	}
	if progressToken != nil {
		params.SetProgressToken(progressToken)
	}
	result, err := session.CallTool(ctx, params)
	if err != nil {
		return UpstreamCallResult{}, err
	}
	return UpstreamCallResult{
		SessionID:         session.ID(),
		Content:           result.Content,
		StructuredContent: result.StructuredContent,
		IsError:           result.IsError,
		ResponseHeaders:   JSONMap{},
	}, nil
}

func normalizeSDKProgressToken(token any) (any, error) {
	switch token := token.(type) {
	case nil, int, int32, int64, string:
		return token, nil
	case float64:
		const (
			minInt64          = -1 << 63
			maxInt64Exclusive = 1 << 63
		)
		if math.IsNaN(token) || math.IsInf(token, 0) || math.Trunc(token) != token || token < minInt64 || token >= maxInt64Exclusive {
			return nil, fmt.Errorf("invalid MCP progress token %v: expected an integer or string", token)
		}
		return int64(token), nil
	default:
		return nil, fmt.Errorf("invalid MCP progress token type %T: expected an integer or string", token)
	}
}

func (c *SDKUpstreamClient) connect(ctx context.Context, server UpstreamServer, bearerToken string, options *mcp.ClientOptions) (*mcp.ClientSession, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: c.clientName, Version: "v0.1.0"}, options)
	switch normalizeTransport(server.Transport) {
	case TransportStreamableHTTP:
		if strings.TrimSpace(server.Endpoint) == "" {
			return nil, fmt.Errorf("%w: streamable_http endpoint is required", ErrInvalidUpstreamConfig)
		}
		transport := &bearerRoundTripper{token: bearerToken, rejectUnauthorized: server.AuthType == "static_bearer"}
		session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
			Endpoint: server.Endpoint,
			HTTPClient: &http.Client{
				Transport: transport,
				Timeout:   mcpToolCallTimeout,
			},
			DisableStandaloneSSE: true,
		}, nil)
		if err != nil && transport.unauthorized.Load() {
			return nil, fmt.Errorf("%w: %v", ErrUpstreamUnauthorized, err)
		}
		return session, err
	case TransportStdio:
		if strings.TrimSpace(server.Stdio.Command) == "" {
			return nil, fmt.Errorf("%w: stdio command is required", ErrInvalidUpstreamConfig)
		}
		cmd := exec.CommandContext(ctx, server.Stdio.Command, server.Stdio.Args...)
		cmd.Dir = server.Stdio.CWD
		cmd.Env = stdioEnv(server.Stdio.Env)
		return client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	default:
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedTransport, server.Transport)
	}
}

func normalizeTransport(transport string) string {
	if strings.TrimSpace(transport) == "" {
		return TransportStreamableHTTP
	}
	return strings.TrimSpace(transport)
}

func stdioEnv(extra map[string]string) []string {
	if len(extra) == 0 {
		return nil
	}
	env := os.Environ()
	keys := make([]string, 0, len(extra))
	for key := range extra {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		env = append(env, key+"="+extra[key])
	}
	return env
}

func schemaToJSONMap(value any) JSONMap {
	if value == nil {
		return JSONMap{"type": "object"}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return JSONMap{"type": "object"}
	}
	var out JSONMap
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return JSONMap{"type": "object"}
	}
	if out["type"] == nil {
		out["type"] = "object"
	}
	return out
}

type bearerRoundTripper struct {
	token              string
	base               http.RoundTripper
	rejectUnauthorized bool
	unauthorized       atomic.Bool
}

func (rt *bearerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	if rt.token != "" {
		req.Header.Set("Authorization", "Bearer "+rt.token)
	}
	base := rt.base
	if base == nil {
		base = http.DefaultTransport
	}
	response, err := base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if rt.rejectUnauthorized && (response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden) {
		rt.unauthorized.Store(true)
		response.Body.Close()
		return nil, fmt.Errorf("%w: status %d", ErrUpstreamUnauthorized, response.StatusCode)
	}
	return response, nil
}
