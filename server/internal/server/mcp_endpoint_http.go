package server

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/krillinai/Clawee/server/internal/mcpauth"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/mcpserver"
)

var upstreamEndpointServerIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type upstreamMCPHandlerRegistry struct {
	mu       sync.Mutex
	opts     Options
	handlers map[string]http.Handler
}

func newUpstreamMCPHandlerRegistry(opts Options) *upstreamMCPHandlerRegistry {
	return &upstreamMCPHandlerRegistry{opts: opts, handlers: map[string]http.Handler{}}
}

func (r *upstreamMCPHandlerRegistry) handler(endpointPath, serverID string) http.Handler {
	r.mu.Lock()
	defer r.mu.Unlock()
	if handler := r.handlers[endpointPath]; handler != nil {
		return handler
	}
	handler := newMCPHandler(r.opts, serverID, endpointPath)
	r.handlers[endpointPath] = handler
	return handler
}

func mountMCPEndpoints(router *gin.Engine, opts Options) {
	rootHandler := newMCPHandler(opts, "", "/mcp")
	router.Any("/mcp", gin.WrapH(rootHandler))

	registry := newUpstreamMCPHandlerRegistry(opts)
	serve := func(c *gin.Context, serverID, endpointPath string) {
		if !upstreamEndpointServerIDPattern.MatchString(serverID) || !activeUpstreamServer(c.Request, opts.ProxyGateway, serverID) {
			c.Status(http.StatusNotFound)
			return
		}
		registry.handler(endpointPath, serverID).ServeHTTP(c.Writer, c.Request)
	}
	router.Any("/mcp/servers/:server_id", func(c *gin.Context) {
		serverID := c.Param("server_id")
		serve(c, serverID, "/mcp/servers/"+serverID)
	})
	router.Any("/mcp/knowledge", func(c *gin.Context) {
		serve(c, mcpgateway.KnowledgeAdapterServerID, "/mcp/knowledge")
	})

	if !opts.MCPAuth.Enabled {
		return
	}
	router.Any("/.well-known/oauth-protected-resource/mcp", gin.WrapH(
		auth.ProtectedResourceMetadataHandler(mcpauth.ProtectedResourceMetadata(mcpAuthConfig(opts, "/mcp"))),
	))
	router.Any("/.well-known/oauth-protected-resource/mcp/servers/:server_id", func(c *gin.Context) {
		serverID := c.Param("server_id")
		if !upstreamEndpointServerIDPattern.MatchString(serverID) || !activeUpstreamServer(c.Request, opts.ProxyGateway, serverID) {
			c.Status(http.StatusNotFound)
			return
		}
		path := "/mcp/servers/" + serverID
		auth.ProtectedResourceMetadataHandler(mcpauth.ProtectedResourceMetadata(mcpAuthConfig(opts, path))).ServeHTTP(c.Writer, c.Request)
	})
	router.Any("/.well-known/oauth-protected-resource/mcp/knowledge", func(c *gin.Context) {
		if !activeUpstreamServer(c.Request, opts.ProxyGateway, mcpgateway.KnowledgeAdapterServerID) {
			c.Status(http.StatusNotFound)
			return
		}
		auth.ProtectedResourceMetadataHandler(mcpauth.ProtectedResourceMetadata(mcpAuthConfig(opts, "/mcp/knowledge"))).ServeHTTP(c.Writer, c.Request)
	})
}

func newMCPHandler(opts Options, upstreamServerID, endpointPath string) http.Handler {
	var handler http.Handler = mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		return mcpserver.New(mcpserver.Options{
			ProxyGateway:     opts.ProxyGateway,
			UpstreamServerID: upstreamServerID,
		}, r)
	}, &mcp.StreamableHTTPOptions{
		Stateless:                    true,
		PropagateRequestCancellation: true,
	})
	if opts.MCPAuth.Enabled {
		handler = mcpauth.RequireBearerToken(mcpAuthConfig(opts, endpointPath))(handler)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
		handler.ServeHTTP(w, r)
	})
}

func mcpAuthConfig(opts Options, endpointPath string) mcpauth.Config {
	resource := endpointResourceURL(opts.MCPAuth, endpointPath)
	metadataPath := "/.well-known/oauth-protected-resource" + endpointPath
	metadataURL := endpointResourceURL(opts.MCPAuth, metadataPath)
	if endpointPath == "/mcp" {
		resource = opts.MCPAuth.Resource
		metadataURL = opts.MCPAuth.ResourceMetadataURL
	}
	return mcpauth.Config{
		Enabled:              opts.MCPAuth.Enabled,
		Resource:             resource,
		ResourceMetadataURL:  metadataURL,
		AuthorizationServers: opts.MCPAuth.AuthorizationServers,
		RequiredScopes:       opts.MCPAuth.RequiredScopes,
		DemoTokens:           opts.MCPAuth.DemoTokens,
		AccountTokenStore:    opts.MCPAuth.AccountTokenStore,
		AccountService:       opts.MCPAuth.AccountService,
	}
}

func endpointResourceURL(authOpts MCPAuthOptions, path string) string {
	base := strings.TrimRight(strings.TrimSpace(authOpts.PublicBaseURL), "/")
	if base == "" {
		parsed, err := url.Parse(authOpts.Resource)
		if err == nil && parsed.Scheme != "" && parsed.Host != "" {
			parsed.Path = strings.TrimSuffix(parsed.Path, "/mcp")
			parsed.RawPath = ""
			parsed.RawQuery = ""
			parsed.Fragment = ""
			base = strings.TrimRight(parsed.String(), "/")
		}
	}
	return base + path
}

func activeUpstreamServer(r *http.Request, proxy *mcpgateway.Service, serverID string) bool {
	if proxy == nil || r == nil {
		return false
	}
	server, err := proxy.Store().GetUpstreamServer(r.Context(), serverID)
	return err == nil && server.DeletedAt == nil && server.Status == mcpgateway.StatusActive
}
