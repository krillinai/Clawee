package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/krillinai/Clawee/server/internal/buildinfo"
	"github.com/krillinai/Clawee/server/internal/mcpauth"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type GateToolInput struct {
	GateID string `json:"gate_id" jsonschema:"gate id"`
}

const (
	multiRoundTripProtocolVersion = "2026-07-28"
	confirmationInputRequestID    = "confirmation"
	confirmationRequestState      = "mcp-confirmation:v1:"
)

type mcpSessionConfirmationElicitor struct {
	session *mcp.ServerSession
}

func (e mcpSessionConfirmationElicitor) SupportsUserConfirmation() bool {
	if e.session == nil {
		return false
	}
	params := e.session.InitializeParams()
	if params == nil || params.Capabilities == nil || params.Capabilities.Elicitation == nil {
		return false
	}
	return params.Capabilities.Elicitation.Form != nil
}

func (e mcpSessionConfirmationElicitor) ElicitUserConfirmation(ctx context.Context, input mcpgateway.SyncConfirmationInput) (mcpgateway.SyncConfirmationDecision, error) {
	if e.session == nil {
		return mcpgateway.SyncConfirmationDecision{}, errors.New("missing mcp session")
	}
	timeout := input.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	elicitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	result, err := e.session.Elicit(elicitCtx, &mcp.ElicitParams{
		Mode:    "form",
		Message: syncConfirmationMessage(input.Gate),
		RequestedSchema: &jsonschema.Schema{
			Type: "object",
			Properties: map[string]*jsonschema.Schema{
				"confirm": {
					Type:  "boolean",
					Title: "确认执行",
				},
			},
			Required: []string{"confirm"},
		},
	})
	if err != nil {
		return mcpgateway.SyncConfirmationDecision{}, err
	}
	switch result.Action {
	case "accept":
		confirmed, _ := result.Content["confirm"].(bool)
		if confirmed {
			return mcpgateway.SyncConfirmationDecision{Action: mcpgateway.SyncConfirmationAccepted, Reason: "accepted_in_mcp_client"}, nil
		}
		return mcpgateway.SyncConfirmationDecision{Action: mcpgateway.SyncConfirmationDeclined, Reason: "declined_in_mcp_client"}, nil
	case "decline":
		return mcpgateway.SyncConfirmationDecision{Action: mcpgateway.SyncConfirmationDeclined, Reason: "declined_in_mcp_client"}, nil
	case "cancel":
		return mcpgateway.SyncConfirmationDecision{Action: mcpgateway.SyncConfirmationCancelled, Reason: "cancelled_by_user"}, nil
	default:
		return mcpgateway.SyncConfirmationDecision{}, fmt.Errorf("unsupported elicitation action: %s", result.Action)
	}
}

func syncConfirmationMessage(gate mcpgateway.GateRequest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "请确认是否执行 MCP 调用：%s\n", gate.ExposedName)
	if gate.GateSummary.System != "" {
		fmt.Fprintf(&b, "系统：%s\n", gate.GateSummary.System)
	}
	if gate.GateSummary.Action != "" {
		fmt.Fprintf(&b, "动作：%s\n", gate.GateSummary.Action)
	}
	if len(gate.GateSummary.Risks) > 0 {
		b.WriteString("风险：\n")
		for _, risk := range gate.GateSummary.Risks {
			fmt.Fprintf(&b, "- %s\n", risk)
		}
	}
	if len(gate.GateSummary.Parameters) > 0 {
		b.WriteString("参数：\n")
		for _, param := range gate.GateSummary.Parameters {
			fmt.Fprintf(&b, "- %s: %s\n", firstNonEmptyString(param.Label, param.Path), param.Value)
		}
	}
	fmt.Fprintf(&b, "Gate ID：%s", gate.ID)
	return b.String()
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

type Options struct {
	ProxyGateway     *mcpgateway.Service
	UpstreamServerID string
}

func New(opts Options, r *http.Request) *mcp.Server {
	server := mcp.NewServer(
		&mcp.Implementation{Name: "claw-mcp", Version: buildinfo.FullVersion()},
		nil,
	)

	addProxyTools(server, opts, r)

	return server
}

func addProxyTools(server *mcp.Server, opts Options, r *http.Request) {
	proxy := opts.ProxyGateway
	if proxy == nil || r == nil {
		return
	}
	identity, err := mcpauth.IdentityFromTokenInfo(mcpTokenInfo(r))
	if err != nil {
		return
	}
	if opts.UpstreamServerID == "" {
		addGateTools(server, proxy)
	}
	var tools []mcpgateway.VisibleTool
	if opts.UpstreamServerID == "" {
		tools, err = proxy.VisibleTools(r.Context(), identity)
	} else {
		tools, err = proxy.VisibleToolsForUpstream(r.Context(), identity, opts.UpstreamServerID)
	}
	if err != nil {
		return
	}
	for _, tool := range tools {
		tool := tool
		server.AddTool(&mcp.Tool{
			Name:         tool.Name,
			Title:        tool.Title,
			Description:  tool.Description,
			InputSchema:  inputSchema(tool.InputSchema),
			OutputSchema: outputSchema(tool.OutputSchema),
		}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if req == nil {
				return nil, errors.New("missing mcp tool call request")
			}
			if req.Extra == nil {
				return nil, errors.New("missing mcp request metadata")
			}
			if req.Session == nil {
				return nil, errors.New("missing mcp session")
			}
			identity, err := mcpauth.IdentityFromTokenInfo(req.Extra.TokenInfo)
			if err != nil {
				return nil, err
			}
			args := mcpgateway.JSONMap{}
			if len(req.Params.Arguments) > 0 {
				if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
					return nil, err
				}
			}
			exposedName := firstNonEmptyString(tool.ExposedName, tool.Name)
			if req.ProtocolVersion() >= multiRoundTripProtocolVersion && req.Params.RequestState != "" {
				return resolveMultiRoundTripConfirmation(ctx, proxy, req, identity, exposedName, opts.UpstreamServerID, args)
			}

			confirmationMode := mcpgateway.ConfirmationModeAuto
			var confirmationElicitor mcpgateway.UserConfirmationElicitor = mcpSessionConfirmationElicitor{session: req.Session}
			if req.ProtocolVersion() >= multiRoundTripProtocolVersion {
				confirmationMode = mcpgateway.ConfirmationModeAsync
				confirmationElicitor = nil
			}
			result, err := proxy.CallTool(ctx, mcpgateway.ToolCallRequest{
				RequestID:                req.Extra.Header.Get("X-Request-ID"),
				Identity:                 identity,
				ExposedName:              exposedName,
				EndpointUpstreamServerID: opts.UpstreamServerID,
				Arguments:                args,
				BearerToken:              bearerToken(req.Extra.Header),
				InboundSession:           req.Session.ID(),
				RequestHeaders:           headersToJSONMap(req.Extra.Header),
				ConfirmationMode:         confirmationMode,
				ConfirmationElicitor:     confirmationElicitor,
				ProgressToken:            req.Params.GetProgressToken(),
				ProgressHandler:          progressHandler(req),
			})
			if err != nil {
				return &mcp.CallToolResult{
					IsError: true,
					Content: []mcp.Content{
						&mcp.TextContent{Text: err.Error()},
					},
				}, nil
			}
			if req.ProtocolVersion() >= multiRoundTripProtocolVersion {
				if gateID, ok := confirmationGateIDFromResult(result); ok {
					gate, getErr := proxy.Store().GetGateRequest(ctx, gateID)
					if getErr != nil {
						return nil, getErr
					}
					return &mcp.CallToolResult{
						InputRequests: mcp.InputRequestMap{
							confirmationInputRequestID: confirmationElicitParams(gate),
						},
						RequestState: confirmationRequestState + gate.ID,
					}, nil
				}
			}
			return mcpToolResult(result), nil
		})
	}
}

func resolveMultiRoundTripConfirmation(ctx context.Context, proxy *mcpgateway.Service, req *mcp.CallToolRequest, identity mcpgateway.AgentIdentity, exposedName, upstreamServerID string, args mcpgateway.JSONMap) (*mcp.CallToolResult, error) {
	gateID, ok := strings.CutPrefix(req.Params.RequestState, confirmationRequestState)
	if !ok || strings.TrimSpace(gateID) == "" {
		return nil, errors.New("invalid MCP confirmation request state")
	}
	response, ok := req.Params.InputResponses[confirmationInputRequestID].(*mcp.ElicitResult)
	if !ok || response == nil {
		return nil, errors.New("missing MCP confirmation response")
	}
	action := response.Action
	reason := ""
	if action == "accept" {
		confirmed, _ := response.Content["confirm"].(bool)
		if confirmed {
			action = mcpgateway.SyncConfirmationAccepted
			reason = "accepted_in_mcp_client"
		} else {
			action = mcpgateway.SyncConfirmationDeclined
			reason = "declined_in_mcp_client"
		}
	} else if action == "decline" {
		action = mcpgateway.SyncConfirmationDeclined
		reason = "declined_in_mcp_client"
	} else if action == "cancel" {
		action = mcpgateway.SyncConfirmationCancelled
		reason = "cancelled_by_user"
	}
	result, err := proxy.ResolveConfirmation(ctx, mcpgateway.ConfirmationRetryRequest{
		GateID:                   gateID,
		Identity:                 identity,
		ExposedName:              exposedName,
		Arguments:                args,
		BearerToken:              bearerToken(req.Extra.Header),
		InboundSession:           req.Session.ID(),
		EndpointUpstreamServerID: upstreamServerID,
		Action:                   action,
		Reason:                   reason,
		ProgressToken:            req.Params.GetProgressToken(),
		ProgressHandler:          progressHandler(req),
	})
	if err != nil {
		return nil, err
	}
	return mcpToolResult(result), nil
}

func progressHandler(req *mcp.CallToolRequest) mcpgateway.ProgressHandler {
	if req == nil || req.Session == nil || req.Params.GetProgressToken() == nil {
		return nil
	}
	token := req.Params.GetProgressToken()
	return func(ctx context.Context, progress *mcp.ProgressNotificationParams) {
		if progress == nil {
			return
		}
		forwarded := *progress
		forwarded.ProgressToken = token
		_ = req.Session.NotifyProgress(ctx, &forwarded)
	}
}

func confirmationGateIDFromResult(result mcpgateway.ToolCallResult) (string, bool) {
	body, ok := result.StructuredContent.(mcpgateway.JSONMap)
	if !ok {
		if raw, mapOK := result.StructuredContent.(map[string]any); mapOK {
			body = mcpgateway.JSONMap(raw)
		} else {
			return "", false
		}
	}
	gateID, _ := body["gate_id"].(string)
	gateType, _ := body["gate_type"].(string)
	if body["gate_required"] != true || gateType != mcpgateway.GateTypeUserConfirmation || gateID == "" {
		return "", false
	}
	return gateID, true
}

func confirmationElicitParams(gate mcpgateway.GateRequest) *mcp.ElicitParams {
	return &mcp.ElicitParams{
		Mode:    "form",
		Message: syncConfirmationMessage(gate),
		RequestedSchema: &jsonschema.Schema{
			Type: "object",
			Properties: map[string]*jsonschema.Schema{
				"confirm": {Type: "boolean", Title: "确认执行"},
			},
			Required: []string{"confirm"},
		},
	}
}

func mcpToolResult(result mcpgateway.ToolCallResult) *mcp.CallToolResult {
	content, _ := result.Content.([]mcp.Content)
	return &mcp.CallToolResult{
		Content:           content,
		StructuredContent: result.StructuredContent,
		IsError:           result.IsError,
	}
}

func addGateTools(server *mcp.Server, proxy *mcpgateway.Service) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "mcp.gate.status",
		Description: "Return status for an MCP gate",
	}, func(ctx context.Context, req *mcp.CallToolRequest, input GateToolInput) (*mcp.CallToolResult, mcpgateway.JSONMap, error) {
		identity, err := identityFromToolRequest(req)
		if err != nil {
			return nil, nil, err
		}
		gate, err := gateForIdentity(ctx, proxy, identity, input.GateID)
		if err != nil {
			return nil, nil, err
		}
		return nil, gateStatusContent(gate), nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "mcp.gate.result",
		Description: "Return result for an MCP gate",
	}, func(ctx context.Context, req *mcp.CallToolRequest, input GateToolInput) (*mcp.CallToolResult, mcpgateway.JSONMap, error) {
		identity, err := identityFromToolRequest(req)
		if err != nil {
			return nil, nil, err
		}
		gate, err := gateForIdentity(ctx, proxy, identity, input.GateID)
		if err != nil {
			return nil, nil, err
		}
		content := gateStatusContent(gate)
		content["response_body"] = gate.ResponseBody
		return nil, content, nil
	})
}

func identityFromToolRequest(req *mcp.CallToolRequest) (mcpgateway.AgentIdentity, error) {
	if req == nil {
		return mcpgateway.AgentIdentity{}, errors.New("missing mcp tool call request")
	}
	if req.Extra == nil {
		return mcpgateway.AgentIdentity{}, errors.New("missing mcp request metadata")
	}
	identity, err := mcpauth.IdentityFromTokenInfo(req.Extra.TokenInfo)
	if err != nil {
		return mcpgateway.AgentIdentity{}, err
	}
	return identity, nil
}

func gateForIdentity(ctx context.Context, proxy *mcpgateway.Service, identity mcpgateway.AgentIdentity, gateID string) (mcpgateway.GateRequest, error) {
	if strings.TrimSpace(gateID) == "" {
		return mcpgateway.GateRequest{}, errors.New("missing gate_id")
	}
	agent, err := proxy.Store().GetAgent(ctx, identity.AgentID)
	if err != nil {
		return mcpgateway.GateRequest{}, err
	}
	if agent.Status != mcpgateway.StatusActive {
		return mcpgateway.GateRequest{}, errors.New("agent is not active")
	}
	gate, err := proxy.Store().GetGateRequest(ctx, gateID)
	if err != nil {
		return mcpgateway.GateRequest{}, err
	}
	if gate.AgentID != identity.AgentID || gate.TenantID != agent.TenantID {
		return mcpgateway.GateRequest{}, errors.New("mcp gate is not accessible by current agent")
	}
	return gate, nil
}

func gateStatusContent(gate mcpgateway.GateRequest) mcpgateway.JSONMap {
	return mcpgateway.JSONMap{
		"gate_id":     gate.ID,
		"gate_type":   gate.Type,
		"status":      string(gate.Status),
		"confirm_url": gate.ConfirmURL,
		"expires_at":  gate.ExpiresAt.Format(time.RFC3339),
		"error":       gate.Error,
	}
}

func inputSchema(schema mcpgateway.JSONMap) any {
	if !isObjectSchema(schema) {
		return mcpgateway.JSONMap{"type": "object"}
	}
	return schema
}

func outputSchema(schema mcpgateway.JSONMap) any {
	if !isObjectSchema(schema) {
		return nil
	}
	return schema
}

func isObjectSchema(schema mcpgateway.JSONMap) bool {
	if schema == nil {
		return false
	}
	typ, ok := schema["type"].(string)
	return ok && typ == "object"
}

func mcpTokenInfo(r *http.Request) *auth.TokenInfo {
	if r == nil {
		return nil
	}
	return auth.TokenInfoFromContext(r.Context())
}

func bearerToken(header http.Header) string {
	value := header.Get("Authorization")
	const prefix = "Bearer "
	if len(value) > len(prefix) && strings.EqualFold(value[:len(prefix)], prefix) {
		return value[len(prefix):]
	}
	return ""
}

func headersToJSONMap(header http.Header) mcpgateway.JSONMap {
	out := mcpgateway.JSONMap{}
	for key, values := range header {
		if len(values) == 1 {
			out[key] = values[0]
			continue
		}
		out[key] = append([]string(nil), values...)
	}
	return out
}
