package mcpgateway

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/tokenutil"
)

var gateIDSequence uint64

var (
	ErrTokenCipherNotConfigured         = errors.New("agent token cipher is not configured")
	ErrCapabilityNotAvailableOnEndpoint = errors.New("mcp capability is not available on endpoint")
	ErrCapabilityExposedNameConflict    = errors.New("mcp capability exposed name belongs to another upstream server")
	ErrEndpointToolNameConflict         = errors.New("mcp endpoint tool name conflict")
)

const encryptedKnowledgeQueryPrefix = "encrypted:v1:"

type Config struct {
	Store                      Store
	UpstreamClient             UpstreamClient
	TokenCipher                TokenCipher
	Clock                      func() time.Time
	SyncConfirmationTimeout    time.Duration
	Logger                     *zap.Logger
	ResolveCredential          func(string) (string, error)
	KnowledgeResolver          KnowledgeBindingResolver
	KnowledgeMCPAccessResolver KnowledgeMCPAccessResolver
}

type Service struct {
	store                      Store
	upstreamClient             UpstreamClient
	tokenCipher                TokenCipher
	clock                      func() time.Time
	syncConfirmationTimeout    time.Duration
	logger                     *zap.Logger
	resolveCredential          func(string) (string, error)
	knowledgeResolver          KnowledgeBindingResolver
	knowledgeMCPAccessResolver KnowledgeMCPAccessResolver
	agentOwnerResolver         func(context.Context, string) (string, error)
	accountActiveValidator     func(context.Context, string) error
}

type TokenCipher interface {
	Encrypt([]byte) ([]byte, error)
	Decrypt([]byte) ([]byte, error)
}

type VisibleTool struct {
	ID               string
	Name             string
	ExposedName      string
	Title            string
	Description      string
	UpstreamServerID string
	RiskLevel        string
	ConfirmRequired  bool
	ExpiresAt        *time.Time
	InputSchema      JSONMap
	OutputSchema     JSONMap
}

type ToolCallRequest struct {
	RequestID                string
	Identity                 AgentIdentity
	ExposedName              string
	Arguments                JSONMap
	BearerToken              string
	InboundSession           string
	TenantID                 string
	RequestHeaders           JSONMap
	ConfirmationMode         string
	ConfirmationElicitor     UserConfirmationElicitor
	EndpointUpstreamServerID string
	ProgressToken            any
	ProgressHandler          ProgressHandler
}

type ToolCallResult struct {
	Content           any
	StructuredContent any
	IsError           bool
}

type ConfirmationRetryRequest struct {
	GateID                   string
	Identity                 AgentIdentity
	ExposedName              string
	Arguments                JSONMap
	BearerToken              string
	InboundSession           string
	EndpointUpstreamServerID string
	Action                   string
	Reason                   string
	ProgressToken            any
	ProgressHandler          ProgressHandler
}

type ToolExecutionRequest struct {
	Started         time.Time
	Audit           ProxyAuditRecord
	Agent           AgentRegistration
	Server          UpstreamServer
	Capability      Capability
	Request         ToolCallRequest
	Arguments       JSONMap
	SuccessDecision string
	FailureDecision string
}

type confirmationGateInput struct {
	Started    time.Time
	Audit      ProxyAuditRecord
	Agent      AgentRegistration
	Server     UpstreamServer
	Capability Capability
	Request    ToolCallRequest
}

type confirmationGateResult struct {
	Required bool
	Result   ToolCallResult
}

type AccountTokenIssueRequest struct {
	UserID    string
	ExpiresAt *time.Time
	Scopes    []string
	Issuer    string
}

type AccountTokenIssueResult struct {
	Token     AccountToken
	Plaintext string
}

func (s *Service) CreateOwnedAgent(ctx context.Context, userID string, agent AgentRegistration) error {
	if strings.TrimSpace(userID) == "" {
		return ErrAgentOwnerUnavailable
	}
	agent.Status = StatusActive
	return s.store.CreateOwnedAgent(ctx, userID, agent)
}

func NewService(cfg Config) *Service {
	store := cfg.Store
	if store == nil {
		store = NewMemoryStore()
	}
	tokenCipher := cfg.TokenCipher
	clock := cfg.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	timeout := cfg.SyncConfirmationTimeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	logger := cfg.Logger
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Service{
		store:                      store,
		upstreamClient:             cfg.UpstreamClient,
		tokenCipher:                tokenCipher,
		clock:                      clock,
		syncConfirmationTimeout:    timeout,
		logger:                     logger,
		resolveCredential:          cfg.ResolveCredential,
		knowledgeResolver:          cfg.KnowledgeResolver,
		knowledgeMCPAccessResolver: cfg.KnowledgeMCPAccessResolver,
	}
}

func (s *Service) Store() Store {
	return s.store
}

func (s *Service) SetIdentityResolvers(owner func(context.Context, string) (string, error), accountActive func(context.Context, string) error) {
	s.agentOwnerResolver = owner
	s.accountActiveValidator = accountActive
}

func (s *Service) validateCaller(ctx context.Context, userID, agentID string) error {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(agentID) == "" {
		return ErrAgentOwnerUnavailable
	}
	if s.accountActiveValidator == nil || s.agentOwnerResolver == nil {
		return ErrAgentOwnerUnavailable
	}
	if err := s.accountActiveValidator(ctx, userID); err != nil {
		return err
	}
	ownerUserID, err := s.agentOwnerResolver(ctx, agentID)
	if err != nil || ownerUserID != userID {
		return ErrAgentOwnerUnavailable
	}
	return nil
}

func (s *Service) UpdateAgentName(ctx context.Context, agentID, name string) (AgentRegistration, error) {
	return s.store.UpdateAgentName(ctx, strings.TrimSpace(agentID), strings.TrimSpace(name))
}

func (s *Service) SetUpstreamBearerToken(server *UpstreamServer, plaintext string) error {
	if server == nil {
		return errors.New("upstream server is required")
	}
	plaintext = strings.TrimSpace(plaintext)
	if plaintext == "" {
		return errors.New("upstream bearer token is empty")
	}
	ciphertext, err := s.encryptTokenPlaintext(plaintext)
	if err != nil {
		return err
	}
	server.AuthType = "static_bearer"
	server.TokenCiphertext = ciphertext
	return nil
}

func (s *Service) CanIssueAccountToken() error {
	if s.tokenCipher == nil {
		return ErrTokenCipherNotConfigured
	}
	return nil
}

func (s *Service) prepareAccountToken(req AccountTokenIssueRequest) (AccountTokenIssueResult, error) {
	plaintext, err := tokenutil.Generate32("agt_")
	if err != nil {
		return AccountTokenIssueResult{}, err
	}
	ciphertext, err := s.encryptTokenPlaintext(plaintext)
	if err != nil {
		return AccountTokenIssueResult{}, err
	}
	now := s.clock()
	tokenHash := HashToken(plaintext)
	scopes := append([]string(nil), req.Scopes...)
	if len(scopes) == 0 {
		scopes = []string{"mcp:call"}
	}
	issuer := req.Issuer
	if strings.TrimSpace(issuer) == "" {
		issuer = "claw-mcp-admin"
	}
	token := AccountToken{
		ID:              newTokenID(now, req.UserID, tokenHash),
		UserID:          req.UserID,
		TokenHash:       tokenHash,
		TokenCiphertext: ciphertext,
		Fingerprint:     TokenFingerprint(tokenHash),
		Status:          StatusActive,
		ExpiresAt:       req.ExpiresAt,
		Issuer:          issuer,
		Scopes:          scopes,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	return AccountTokenIssueResult{Token: token, Plaintext: plaintext}, nil
}

type AccountTokenCopyResult struct {
	Token     AccountToken
	Plaintext string
}

func (s *Service) CopyActiveAccountToken(ctx context.Context, userID string) (AccountTokenCopyResult, error) {
	token, err := s.store.GetActiveAccountToken(ctx, userID)
	if err != nil {
		return AccountTokenCopyResult{}, err
	}
	if token.Status != StatusActive {
		return AccountTokenCopyResult{}, ErrAccountTokenNotFound
	}
	now := s.clock()
	if token.ExpiresAt != nil && !token.ExpiresAt.After(now) {
		return AccountTokenCopyResult{}, ErrAccountTokenNotFound
	}
	if len(token.TokenCiphertext) == 0 {
		return AccountTokenCopyResult{}, ErrAccountTokenNotFound
	}
	plaintextBytes, err := s.decryptTokenPlaintext(token.TokenCiphertext)
	if err != nil {
		return AccountTokenCopyResult{}, err
	}
	plaintext := string(plaintextBytes)
	if HashToken(plaintext) != token.TokenHash {
		return AccountTokenCopyResult{}, errors.New("account token ciphertext hash mismatch")
	}
	return AccountTokenCopyResult{Token: token, Plaintext: plaintext}, nil
}

func (s *Service) RotateAccountToken(ctx context.Context, req AccountTokenIssueRequest) (AccountTokenIssueResult, error) {
	issued, err := s.prepareAccountToken(req)
	if err != nil {
		return AccountTokenIssueResult{}, err
	}
	if err := s.store.RotateAccountToken(ctx, req.UserID, issued.Token); err != nil {
		return AccountTokenIssueResult{}, err
	}
	return issued, nil
}

func (s *Service) RevokeAccountToken(ctx context.Context, userID string) (int64, error) {
	return s.store.RevokeAccountTokens(ctx, userID, s.clock())
}

func (s *Service) SyncTools(ctx context.Context, serverID, bearerToken string) error {
	started := s.clock()
	server, err := s.store.GetUpstreamServer(ctx, serverID)
	if err != nil {
		return err
	}
	if server.Status != StatusActive {
		return fmt.Errorf("%w: %s", ErrUpstreamServerNotFound, serverID)
	}
	if s.upstreamClient == nil {
		return errors.New("upstream mcp client is not configured")
	}
	upstreamToken, err := s.resolveUpstreamBearer(server, bearerToken)
	if err != nil {
		s.saveSyncLog(serverID, StatusSyncFailed, err.Error(), started)
		return err
	}
	tools, err := s.upstreamClient.ListTools(ctx, server, upstreamToken)
	if err != nil {
		s.saveSyncLog(serverID, StatusSyncFailed, err.Error(), started)
		return err
	}
	now := s.clock()
	existing, err := s.store.ListCapabilities(ctx, CapabilityFilter{Type: CapabilityTool})
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, tool := range tools {
		exposedName := exposeName(server.Namespace, tool.Name)
		seen[exposedName] = true
		hash, err := SchemaHash(tool.InputSchema)
		if err != nil {
			return err
		}
		capability, err := s.store.GetCapabilityByExposedName(ctx, exposedName)
		isNew := false
		if err != nil {
			if !errors.Is(err, ErrCapabilityNotFound) {
				return err
			}
			capability = Capability{
				ID:               capabilityID(server.ID, exposedName),
				UpstreamServerID: server.ID,
				Type:             CapabilityTool,
				ExposedName:      exposedName,
				Status:           StatusPending,
			}
			isNew = true
		} else if capability.UpstreamServerID != server.ID {
			err := fmt.Errorf("%w: %s belongs to %s", ErrCapabilityExposedNameConflict, exposedName, capability.UpstreamServerID)
			s.saveSyncLog(serverID, StatusSyncFailed, err.Error(), started)
			return err
		}
		if capability.Status == StatusMissing {
			capability.Status = StatusPending
		}
		capability.UpstreamServerID = server.ID
		capability.Type = CapabilityTool
		capability.UpstreamName = tool.Name
		capability.ExposedName = exposedName
		capability.Title = tool.Title
		capability.Description = tool.Description
		capability.InputSchema = tool.InputSchema
		capability.OutputSchema = tool.OutputSchema
		capability.Annotations = tool.Annotations
		if isNew {
			capability.ReadOnly, _ = tool.Annotations["readOnlyHint"].(bool)
			if destructive, ok := tool.Annotations["destructiveHint"].(bool); ok {
				capability.Destructive = destructive
			}
			capability.Idempotent, _ = tool.Annotations["idempotentHint"].(bool)
			if capability.ReadOnly && !capability.Destructive {
				capability.RiskLevel = "low"
			}
		}
		capability.SchemaHash = hash
		capability.Version = "v1"
		capability.LastSyncedAt = now
		if err := s.store.SaveCapability(ctx, capability); err != nil {
			return err
		}
	}
	for _, capability := range existing {
		if capability.UpstreamServerID != server.ID {
			continue
		}
		if capability.Status == StatusMissing || seen[capability.ExposedName] {
			continue
		}
		capability.Status = StatusMissing
		capability.LastSyncedAt = now
		if err := s.store.SaveCapability(ctx, capability); err != nil {
			return err
		}
	}
	s.saveSyncLog(serverID, StatusActive, "ok", started)
	return nil
}

func (s *Service) saveSyncLog(serverID, status, message string, started time.Time) {
	completed := s.clock()
	_ = s.store.SaveUpstreamSyncLog(context.Background(), UpstreamSyncLog{
		ID:               NewAuditID(completed, "sync_tools"),
		UpstreamServerID: serverID,
		Status:           status,
		Message:          message,
		StartedAt:        started,
		CompletedAt:      completed,
	})
}

func (s *Service) ToolCatalog(ctx context.Context, identity AgentIdentity) ([]ToolCatalogUpstream, error) {
	agent, err := s.store.GetAgent(ctx, identity.AgentID)
	if err != nil {
		return nil, err
	}
	if agent.Status != StatusActive {
		return nil, fmt.Errorf("agent is not active: %s", identity.AgentID)
	}
	if err := s.validateCaller(ctx, identity.UserID, identity.AgentID); err != nil {
		return nil, err
	}
	servers, err := s.store.ListUpstreamServers(ctx)
	if err != nil {
		return nil, err
	}
	capabilities, err := s.store.ListCapabilities(ctx, CapabilityFilter{Type: CapabilityTool})
	if err != nil {
		return nil, err
	}
	grants, err := s.store.ListGrants(ctx, GrantFilter{UserID: identity.UserID, GrantType: GrantTool})
	if err != nil {
		return nil, err
	}

	capabilitiesByServer := make(map[string][]Capability)
	for _, capability := range capabilities {
		capabilitiesByServer[capability.UpstreamServerID] = append(capabilitiesByServer[capability.UpstreamServerID], capability)
	}
	now := s.clock()
	out := make([]ToolCatalogUpstream, 0, len(servers))
	for _, server := range servers {
		upstream := ToolCatalogUpstream{
			ID: server.ID, Name: server.Name, Domain: server.Domain, Transport: server.Transport,
			Namespace: server.Namespace, Status: server.Status, Tools: []ToolCatalogTool{},
		}
		for _, capability := range capabilitiesByServer[server.ID] {
			decision := GrantDecision{}
			if server.Status == StatusActive && capability.Status == StatusActive {
				decision = decideToolGrant(now, grants, identity.UserID, capability)
			}
			var expiresAt *time.Time
			if decision.Allowed && decision.Grant != nil {
				expiresAt = decision.Grant.ExpiresAt
			}
			name := capability.ExposedName
			if prefix := strings.TrimSpace(server.Namespace); prefix != "" {
				name = strings.TrimPrefix(name, prefix+".")
			}
			upstream.Tools = append(upstream.Tools, ToolCatalogTool{
				ID: capability.ID, UpstreamName: capability.UpstreamName, Name: name, ExposedName: capability.ExposedName, Title: capability.Title,
				Description: capability.Description, RiskLevel: capability.RiskLevel,
				ConfirmRequired: capability.ConfirmRequired, Status: capability.Status, Authorized: decision.Allowed,
				AuthorizationExpiresAt: expiresAt,
			})
		}
		out = append(out, upstream)
	}
	return out, nil
}

func (s *Service) AuthorizedToolCatalog(ctx context.Context, identity AgentIdentity) ([]ToolCatalogUpstream, error) {
	catalog, err := s.ToolCatalog(ctx, identity)
	if err != nil {
		return nil, err
	}
	out := make([]ToolCatalogUpstream, 0, len(catalog))
	for _, upstream := range catalog {
		if upstream.Status != StatusActive {
			continue
		}
		tools := make([]ToolCatalogTool, 0, len(upstream.Tools))
		for _, tool := range upstream.Tools {
			if tool.Status == StatusActive && tool.Authorized {
				tools = append(tools, tool)
			}
		}
		if len(tools) == 0 {
			continue
		}
		upstream.Tools = tools
		out = append(out, upstream)
	}
	return out, nil
}

func (s *Service) VisibleTools(ctx context.Context, identity AgentIdentity) ([]VisibleTool, error) {
	return s.visibleTools(ctx, identity, "")
}

func (s *Service) VisibleToolsForUpstream(ctx context.Context, identity AgentIdentity, upstreamServerID string) ([]VisibleTool, error) {
	upstreamServerID = strings.TrimSpace(upstreamServerID)
	if upstreamServerID == "" {
		return nil, ErrUpstreamServerNotFound
	}
	return s.visibleTools(ctx, identity, upstreamServerID)
}

func (s *Service) visibleTools(ctx context.Context, identity AgentIdentity, upstreamServerID string) ([]VisibleTool, error) {
	started := s.clock()
	endpointType := EndpointTypeAggregate
	if upstreamServerID != "" {
		endpointType = EndpointTypeUpstream
	}
	audit := ListAuditRecord{
		ID:                       NewAuditID(started, "tools_list"),
		TraceID:                  NewTraceID(started, "tools_list"),
		AgentID:                  identity.AgentID,
		UserID:                   identity.UserID,
		ActorID:                  identity.Subject,
		EndpointType:             endpointType,
		EndpointUpstreamServerID: upstreamServerID,
		CapabilityType:           CapabilityTool,
		CreatedAt:                started,
	}
	agent, err := s.store.GetAgent(ctx, identity.AgentID)
	if err != nil {
		if errors.Is(err, ErrAgentNotFound) {
			audit.Decision = DecisionAgentDisabled
			audit.DecisionReason = DecisionAgentDisabled
		} else {
			audit.Decision = DecisionInternalError
			audit.DecisionReason = err.Error()
		}
		saveListAudit(s, audit)
		return nil, err
	}
	if agent.Status != StatusActive {
		audit.Decision = DecisionAgentDisabled
		audit.DecisionReason = DecisionAgentDisabled
		saveListAudit(s, audit)
		return nil, fmt.Errorf("agent is not active: %s", identity.AgentID)
	}
	if err := s.validateCaller(ctx, identity.UserID, identity.AgentID); err != nil {
		audit.Decision = DecisionAgentDisabled
		audit.DecisionReason = DecisionAgentDisabled
		saveListAudit(s, audit)
		return nil, err
	}
	audit.TenantID = agent.TenantID

	capabilities, err := s.store.ListCapabilities(ctx, CapabilityFilter{Type: CapabilityTool, Status: StatusActive})
	if err != nil {
		audit.Decision = DecisionInternalError
		audit.DecisionReason = err.Error()
		saveListAudit(s, audit)
		return nil, err
	}
	servers, err := s.store.ListUpstreamServers(ctx)
	if err != nil {
		audit.Decision = DecisionInternalError
		audit.DecisionReason = err.Error()
		saveListAudit(s, audit)
		return nil, err
	}
	activeServers := make(map[string]bool, len(servers))
	serverByID := make(map[string]UpstreamServer, len(servers))
	for _, server := range servers {
		activeServers[server.ID] = server.Status == StatusActive
		serverByID[server.ID] = server
	}
	if upstreamServerID != "" && !activeServers[upstreamServerID] {
		audit.Decision = DecisionServerDisabled
		audit.DecisionReason = DecisionServerDisabled
		saveListAudit(s, audit)
		return nil, fmt.Errorf("%w: %s", ErrUpstreamServerNotFound, upstreamServerID)
	}
	grants, err := s.store.ListGrants(ctx, GrantFilter{UserID: identity.UserID, GrantType: GrantTool})
	if err != nil {
		audit.Decision = DecisionInternalError
		audit.DecisionReason = err.Error()
		saveListAudit(s, audit)
		return nil, err
	}
	now := s.clock()
	out := []VisibleTool{}
	visibleNames := map[string]string{}
	for _, capability := range capabilities {
		if upstreamServerID != "" && capability.UpstreamServerID != upstreamServerID {
			audit.FilteredCount++
			continue
		}
		if !activeServers[capability.UpstreamServerID] {
			audit.FilteredCount++
			continue
		}
		decision := decideToolGrant(now, grants, identity.UserID, capability)
		if !decision.Allowed {
			audit.FilteredCount++
			continue
		}
		name := capability.ExposedName
		if upstreamServerID != "" {
			prefix := strings.TrimSpace(serverByID[capability.UpstreamServerID].Namespace)
			if prefix != "" {
				name = strings.TrimPrefix(name, prefix+".")
			}
		}
		if existingExposedName, ok := visibleNames[name]; ok {
			err := fmt.Errorf("%w: %s maps both %s and %s", ErrEndpointToolNameConflict, name, existingExposedName, capability.ExposedName)
			audit.Decision = DecisionInternalError
			audit.DecisionReason = err.Error()
			saveListAudit(s, audit)
			return nil, err
		}
		visibleNames[name] = capability.ExposedName
		title := capability.Title
		description := capability.Description
		if capability.UpstreamName == "codex.ask" {
			server := serverByID[capability.UpstreamServerID]
			serverName := strings.TrimSpace(server.Name)
			if serverName != "" {
				title = "委派给" + serverName
				description = "将任务委派给" + serverName + "。"
				if routingDescription := strings.TrimSpace(server.RoutingDescription); routingDescription != "" {
					description += routingDescription
				}
			}
		}
		out = append(out, VisibleTool{
			ID:               capability.ID,
			Name:             name,
			ExposedName:      capability.ExposedName,
			Title:            title,
			Description:      description,
			UpstreamServerID: capability.UpstreamServerID,
			RiskLevel:        capability.RiskLevel,
			ConfirmRequired:  capability.ConfirmRequired,
			InputSchema:      capability.InputSchema,
			OutputSchema:     capability.OutputSchema,
		})
	}
	audit.Decision = DecisionAllowed
	audit.DecisionReason = DecisionAllowed
	audit.ReturnedCount = len(out)
	if err := s.store.SaveListAuditRecord(context.Background(), audit); err != nil {
		logListAuditSaveFailure(s, audit, err)
		return nil, err
	}
	return out, nil
}

func decideToolGrant(now time.Time, grants []AccountGrant, userID string, capability Capability) GrantDecision {
	return DecideGrant(now, grants, userID, capability.ID, GrantTool)
}

func (s *Service) CallTool(ctx context.Context, req ToolCallRequest) (ToolCallResult, error) {
	started := s.clock()
	endpointType := EndpointTypeAggregate
	if req.EndpointUpstreamServerID != "" {
		endpointType = EndpointTypeUpstream
	}
	audit := ProxyAuditRecord{
		ID:                       NewAuditID(started, req.ExposedName),
		RequestID:                req.RequestID,
		TraceID:                  NewTraceID(started, req.ExposedName),
		InboundSessionID:         req.InboundSession,
		AgentID:                  req.Identity.AgentID,
		UserID:                   req.Identity.UserID,
		ActorID:                  req.Identity.Subject,
		TenantID:                 req.TenantID,
		TokenID:                  req.Identity.TokenID,
		TokenHash:                HashToken(req.BearerToken),
		EndpointType:             endpointType,
		EndpointUpstreamServerID: req.EndpointUpstreamServerID,
		ExposedName:              req.ExposedName,
		RequestHeaders:           SanitizeHeaders(req.RequestHeaders),
		RequestBody:              cloneJSONMap(req.Arguments),
		CreatedAt:                started,
	}

	agent, err := s.store.GetAgent(ctx, req.Identity.AgentID)
	if err != nil {
		if errors.Is(err, ErrAgentNotFound) {
			audit.Decision = DecisionAgentDisabled
			audit.DecisionReason = DecisionAgentDisabled
		} else {
			audit.Decision = DecisionInternalError
			audit.DecisionReason = err.Error()
			audit.Error = err.Error()
		}
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, err
	}
	if agent.Status != StatusActive {
		audit.Decision = DecisionAgentDisabled
		audit.DecisionReason = DecisionAgentDisabled
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, fmt.Errorf("agent is not active: %s", req.Identity.AgentID)
	}
	if err := s.validateCaller(ctx, req.Identity.UserID, req.Identity.AgentID); err != nil {
		audit.Decision = DecisionAgentDisabled
		audit.DecisionReason = DecisionAgentDisabled
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, err
	}
	audit.TenantID = agent.TenantID

	capability, err := s.store.GetCapabilityByExposedName(ctx, req.ExposedName)
	if err != nil {
		if errors.Is(err, ErrCapabilityNotFound) {
			audit.Decision = DecisionNoMatchingGrant
			audit.DecisionReason = err.Error()
		} else {
			audit.Decision = DecisionInternalError
			audit.DecisionReason = err.Error()
			audit.Error = err.Error()
		}
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, err
	}
	audit.CapabilityID = capability.ID
	audit.CapabilityType = capability.Type
	audit.UpstreamServerID = capability.UpstreamServerID
	audit.UpstreamName = capability.UpstreamName
	if req.EndpointUpstreamServerID != "" && capability.UpstreamServerID != req.EndpointUpstreamServerID {
		audit.Decision = DecisionCapabilityNotAvailableOnEndpoint
		audit.DecisionReason = DecisionCapabilityNotAvailableOnEndpoint
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, fmt.Errorf("%w: %s", ErrCapabilityNotAvailableOnEndpoint, req.ExposedName)
	}

	if capability.Type != CapabilityTool || capability.Status != StatusActive {
		audit.Decision = DecisionCapabilityDisabled
		audit.DecisionReason = DecisionCapabilityDisabled
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, fmt.Errorf("capability is disabled: %s", capability.ExposedName)
	}

	server, err := s.store.GetUpstreamServer(ctx, capability.UpstreamServerID)
	if err != nil {
		if errors.Is(err, ErrUpstreamServerNotFound) {
			audit.Decision = DecisionServerDisabled
			audit.DecisionReason = err.Error()
		} else {
			audit.Decision = DecisionInternalError
			audit.DecisionReason = err.Error()
			audit.Error = err.Error()
		}
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, err
	}
	if server.Status != StatusActive {
		audit.Decision = DecisionServerDisabled
		audit.DecisionReason = DecisionServerDisabled
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, fmt.Errorf("upstream server is disabled: %s", server.ID)
	}

	grants, err := s.store.ListGrants(ctx, GrantFilter{UserID: req.Identity.UserID, CapabilityID: capability.ID, GrantType: GrantTool})
	if err != nil {
		audit.Decision = DecisionInternalError
		audit.DecisionReason = err.Error()
		audit.Error = err.Error()
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, err
	}
	decision := DecideGrant(started, grants, req.Identity.UserID, capability.ID, GrantTool)
	if !decision.Allowed {
		audit.Decision = decision.Reason
		audit.DecisionReason = decision.Reason
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, fmt.Errorf("mcp tool is not granted: %s", req.ExposedName)
	}
	if IsKnowledgeSearchCapability(capability) {
		knowledgeBaseIDs, scopeErr := s.resolveMCPKnowledgeBaseIDs(ctx, req.Identity.UserID)
		if scopeErr != nil {
			audit.Decision = DecisionInternalError
			audit.DecisionReason = scopeErr.Error()
			audit.Error = scopeErr.Error()
			saveProxyAudit(s, started, &audit)
			return ToolCallResult{}, scopeErr
		}
		if len(knowledgeBaseIDs) == 0 {
			audit.Decision = DecisionNoMatchingKnowledgeScope
			audit.DecisionReason = DecisionNoMatchingKnowledgeScope
			saveProxyAudit(s, started, &audit)
			return ToolCallResult{}, errors.New(DecisionNoMatchingKnowledgeScope)
		}
		audit.ResolvedDataScope = JSONMap{"knowledge_base_ids": knowledgeBaseIDs}
	}

	if err := ValidateInput(capability.InputSchema, req.Arguments); err != nil {
		audit.Decision = DecisionInvalidInput
		audit.DecisionReason = err.Error()
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, err
	}
	if IsKnowledgeSearchCapability(capability) {
		query, ok := req.Arguments["query"].(string)
		if !ok || strings.TrimSpace(query) == "" {
			err := errors.New(DecisionInvalidInput)
			audit.Decision = DecisionInvalidInput
			audit.DecisionReason = err.Error()
			saveProxyAudit(s, started, &audit)
			return ToolCallResult{}, err
		}
	}

	approval, err := s.requireAdminApproval(ctx, confirmationGateInput{
		Started:    started,
		Audit:      audit,
		Agent:      agent,
		Server:     server,
		Capability: capability,
		Request:    req,
	})
	if err != nil {
		audit.Decision = DecisionInternalError
		audit.DecisionReason = err.Error()
		audit.Error = err.Error()
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, err
	}
	if approval.Required {
		return approval.Result, nil
	}

	gate, err := s.requireConfirmation(ctx, confirmationGateInput{
		Started:    started,
		Audit:      audit,
		Agent:      agent,
		Server:     server,
		Capability: capability,
		Request:    req,
	})
	if err != nil {
		audit.Decision = DecisionInternalError
		audit.DecisionReason = err.Error()
		audit.Error = err.Error()
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, err
	}
	if gate.Required {
		return gate.Result, nil
	}

	if s.upstreamClient == nil {
		err := errors.New("upstream mcp client is not configured")
		audit.Decision = DecisionInternalError
		audit.DecisionReason = err.Error()
		audit.Error = err.Error()
		saveProxyAudit(s, started, &audit)
		return ToolCallResult{}, err
	}

	result, _, err := s.executeToolSnapshot(ctx, ToolExecutionRequest{
		Started:    started,
		Audit:      audit,
		Agent:      agent,
		Server:     server,
		Capability: capability,
		Request:    req,
		Arguments:  cloneJSONMap(req.Arguments),
	})
	return result, err
}

func (s *Service) executeToolSnapshot(ctx context.Context, req ToolExecutionRequest) (ToolCallResult, ProxyAuditRecord, error) {
	audit := req.Audit
	arguments := cloneJSONMap(req.Arguments)
	var knowledgeBindings []KnowledgeBinding
	isKnowledgeSearch := IsKnowledgeSearchCapability(req.Capability)
	if isKnowledgeSearch {
		if query, ok := arguments["query"].(string); ok {
			arguments["query"] = strings.TrimSpace(query)
		}
		if _, ok := arguments["top_k"]; !ok {
			arguments["top_k"] = 5
		}
		knowledgeBaseIDs, err := knowledgeIDsFromAuditOrAccount(ctx, s, req, audit)
		if err != nil {
			decision := DecisionInvalidKnowledgeScope
			message := "知识库授权范围无效"
			if errors.Is(err, errNoMatchingKnowledgeScope) {
				decision = DecisionNoMatchingKnowledgeScope
				message = "没有可检索的知识库"
			}
			audit.Decision = decision
			audit.DecisionReason = decision
			audit.ResponseBody = JSONMap{"code": decision, "error": message}
			saveProxyAudit(s, req.Started, &audit)
			return ToolCallResult{}, audit, err
		}
		audit.ResolvedDataScope = JSONMap{"knowledge_base_ids": knowledgeBaseIDs}
		if s.knowledgeResolver == nil {
			err := errors.New("knowledge_binding_not_found")
			audit.Decision = DecisionUpstreamError
			audit.DecisionReason = err.Error()
			audit.ResponseBody = JSONMap{"code": err.Error(), "error": "知识库绑定不存在"}
			saveProxyAudit(s, req.Started, &audit)
			return ToolCallResult{}, audit, err
		}
		for _, knowledgeBaseID := range knowledgeBaseIDs {
			binding, resolveErr := s.knowledgeResolver.ResolveKnowledgeBinding(ctx, knowledgeBaseID)
			if resolveErr != nil {
				knowledgeBindings = append(knowledgeBindings, KnowledgeBinding{KnowledgeBaseID: knowledgeBaseID, ErrorCode: "not_found"})
				continue
			}
			knowledgeBindings = append(knowledgeBindings, binding)
		}
	}
	upstreamToken, err := s.resolveUpstreamBearer(req.Server, req.Request.BearerToken)
	if err != nil {
		audit.Decision = DecisionUpstreamError
		if isKnowledgeSearch {
			err = errors.New("knowledge_provider_error")
			audit.DecisionReason = err.Error()
			audit.Error = err.Error()
			audit.ResponseBody = JSONMap{"code": err.Error(), "error": "知识库服务暂时不可用"}
		} else {
			audit.DecisionReason = err.Error()
			audit.Error = err.Error()
		}
		saveProxyAudit(s, req.Started, &audit)
		return ToolCallResult{}, audit, err
	}
	sessionKey := NewSessionKey(SessionKeyInput{
		InboundSessionID: req.Request.InboundSession,
		AgentID:          req.Request.Identity.AgentID,
		ActorID:          req.Request.Identity.Subject,
		TenantID:         req.Agent.TenantID,
		UpstreamServerID: req.Server.ID,
		BearerToken:      upstreamToken,
	})
	upstreamResult, err := s.upstreamClient.CallTool(ctx, UpstreamCallRequest{
		Server:            req.Server,
		Capability:        req.Capability,
		Arguments:         arguments,
		BearerToken:       upstreamToken,
		SessionKey:        sessionKey,
		InboundSessionID:  req.Request.InboundSession,
		KnowledgeBindings: knowledgeBindings,
		TraceID:           audit.TraceID,
		Caller:            req.Request.Identity,
		ProgressToken:     req.Request.ProgressToken,
		ProgressHandler:   req.Request.ProgressHandler,
	})
	completed := s.clock()
	audit.UpstreamSessionID = upstreamResult.SessionID
	audit.ResponseHeaders = SanitizeHeaders(upstreamResult.ResponseHeaders)
	audit.ResponseBody = toolResponseBody(upstreamResult.StructuredContent, upstreamResult.Content)
	audit.DurationMS = completed.Sub(req.Started).Milliseconds()
	audit.CompletedAt = completed
	if err != nil {
		audit.Decision = firstNonEmpty(req.FailureDecision, DecisionUpstreamError)
		if isKnowledgeSearch {
			code := "knowledge_provider_error"
			message := "知识库服务暂时不可用"
			err = errors.New(code)
			audit.DecisionReason = code
			audit.Error = code
			audit.ResponseBody = JSONMap{"code": code, "error": message}
		} else {
			audit.DecisionReason = audit.Decision
			audit.Error = err.Error()
		}
		audit = ProjectProxyAudit(audit)
		if saveErr := s.store.SaveProxyAuditRecord(context.Background(), audit); saveErr != nil {
			logProxyAuditSaveFailure(s, audit, saveErr)
		}
		return ToolCallResult{}, audit, err
	}
	audit.Decision = firstNonEmpty(req.SuccessDecision, DecisionAllowed)
	audit.DecisionReason = audit.Decision
	result := ToolCallResult{
		Content:           upstreamResult.Content,
		StructuredContent: upstreamResult.StructuredContent,
		IsError:           upstreamResult.IsError,
	}
	if isKnowledgeSearch && upstreamResult.IsError {
		audit.Decision = firstNonEmpty(req.FailureDecision, DecisionUpstreamError)
		audit.DecisionReason = "knowledge_provider_error"
		audit.ResponseBody = JSONMap{"code": "knowledge_provider_error", "error": "知识库服务暂时不可用"}
		audit = ProjectProxyAudit(audit)
		if err := s.store.SaveProxyAuditRecord(context.Background(), audit); err != nil {
			logProxyAuditSaveFailure(s, audit, err)
			return result, audit, err
		}
		return result, audit, nil
	}
	audit = ProjectProxyAudit(audit)
	if err := s.store.SaveProxyAuditRecord(context.Background(), audit); err != nil {
		logProxyAuditSaveFailure(s, audit, err)
		return result, audit, err
	}
	return result, audit, nil
}

func (s *Service) acceptAndExecuteGate(ctx context.Context, id string, decidedBy string, reason string, progressToken any, progressHandler ProgressHandler) (GateRequest, ToolCallResult, error) {
	now := s.clock()
	if strings.TrimSpace(decidedBy) == "" {
		gate, err := s.store.GetGateRequest(ctx, id)
		if err != nil {
			return GateRequest{}, ToolCallResult{}, err
		}
		decidedBy = gate.ActorID
	}
	if strings.TrimSpace(reason) == "" {
		reason = "accepted"
	}
	accepted, err := s.store.UpdateGateDecision(ctx, GateDecisionUpdate{
		ID:        id,
		From:      GatePending,
		To:        GateAccepted,
		DecidedBy: decidedBy,
		Reason:    reason,
		DecidedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		if errors.Is(err, ErrGateConflict) {
			current, getErr := s.store.GetGateRequest(ctx, id)
			if getErr == nil {
				return current, ToolCallResult{}, ErrGateConflict
			}
		}
		return GateRequest{}, ToolCallResult{}, err
	}
	return s.executeAcceptedConfirmation(ctx, accepted.ID, progressToken, progressHandler)
}

func (s *Service) AcceptConfirmation(ctx context.Context, id string) (GateRequest, error) {
	gate, err := s.store.GetGateRequest(ctx, id)
	if err != nil {
		return GateRequest{}, err
	}
	if gate.Status != GatePending {
		return gate, ErrGateConflict
	}
	now := s.clock()
	if !gate.ExpiresAt.IsZero() && now.After(gate.ExpiresAt) {
		updated, updateErr := s.store.UpdateGateDecision(ctx, GateDecisionUpdate{
			ID:        id,
			From:      GatePending,
			To:        GateExpired,
			DecidedBy: gate.ActorID,
			Reason:    "expired",
			DecidedAt: now,
			UpdatedAt: now,
		})
		if updateErr != nil {
			if errors.Is(updateErr, ErrGateConflict) {
				current, getErr := s.store.GetGateRequest(ctx, id)
				if getErr == nil {
					return current, ErrGateConflict
				}
			}
			return GateRequest{}, updateErr
		}
		return updated, ErrGateConflict
	}
	accepted, _, err := s.acceptAndExecuteGate(ctx, id, gate.ActorID, "accepted", nil, nil)
	return accepted, err
}

func (s *Service) DeclineConfirmation(ctx context.Context, id string, reason string) (GateRequest, error) {
	gate, err := s.store.GetGateRequest(ctx, id)
	if err != nil {
		return GateRequest{}, err
	}
	if gate.Status != GatePending {
		return gate, ErrGateConflict
	}
	now := s.clock()
	if !gate.ExpiresAt.IsZero() && now.After(gate.ExpiresAt) {
		updated, updateErr := s.store.UpdateGateDecision(ctx, GateDecisionUpdate{
			ID:        id,
			From:      GatePending,
			To:        GateExpired,
			DecidedBy: gate.ActorID,
			Reason:    "expired",
			DecidedAt: now,
			UpdatedAt: now,
		})
		if updateErr != nil {
			if errors.Is(updateErr, ErrGateConflict) {
				current, getErr := s.store.GetGateRequest(ctx, id)
				if getErr == nil {
					return current, ErrGateConflict
				}
			}
			return GateRequest{}, updateErr
		}
		return updated, ErrGateConflict
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "rejected"
	}
	return s.store.UpdateGateDecision(ctx, GateDecisionUpdate{
		ID:        id,
		From:      GatePending,
		To:        GateRejected,
		DecidedBy: gate.ActorID,
		Reason:    reason,
		DecidedAt: now,
		UpdatedAt: now,
	})
}

func (s *Service) ResolveConfirmation(ctx context.Context, req ConfirmationRetryRequest) (ToolCallResult, error) {
	gate, err := s.store.GetGateRequest(ctx, strings.TrimSpace(req.GateID))
	if err != nil {
		return ToolCallResult{}, err
	}
	if err := s.validateConfirmationRetry(ctx, gate, req); err != nil {
		return ToolCallResult{}, err
	}
	if gate.Status == GatePending && !gate.ExpiresAt.IsZero() && s.clock().After(gate.ExpiresAt) {
		now := s.clock()
		_, err := s.store.UpdateGateDecision(ctx, GateDecisionUpdate{
			ID:        gate.ID,
			From:      GatePending,
			To:        GateExpired,
			DecidedBy: gate.ActorID,
			Reason:    "expired",
			DecidedAt: now,
			UpdatedAt: now,
		})
		if err != nil && !errors.Is(err, ErrGateConflict) {
			return ToolCallResult{}, err
		}
		return ToolCallResult{}, ErrGateConflict
	}

	switch strings.TrimSpace(req.Action) {
	case SyncConfirmationAccepted:
		if gate.Status == GateCompleted {
			return ToolCallResult{StructuredContent: cloneJSONMap(gate.ResponseBody)}, nil
		}
		if gate.Status != GatePending {
			return ToolCallResult{}, ErrGateConflict
		}
		_, result, err := s.acceptAndExecuteGate(ctx, gate.ID, gate.ActorID, firstNonEmpty(req.Reason, "accepted_in_mcp_client"), req.ProgressToken, req.ProgressHandler)
		return result, err
	case SyncConfirmationDeclined, SyncConfirmationCancelled:
		if gate.Status == GateRejected {
			return declinedConfirmationResult(gate), nil
		}
		if gate.Status != GatePending {
			return ToolCallResult{}, ErrGateConflict
		}
		declined, err := s.DeclineConfirmation(ctx, gate.ID, firstNonEmpty(req.Reason, "declined_in_mcp_client"))
		if err != nil {
			return ToolCallResult{}, err
		}
		return declinedConfirmationResult(declined), nil
	default:
		return ToolCallResult{}, errors.New("unsupported confirmation action")
	}
}

func (s *Service) validateConfirmationRetry(ctx context.Context, gate GateRequest, req ConfirmationRetryRequest) error {
	if gate.Type != GateTypeUserConfirmation {
		return errors.New("mcp gate is not a user confirmation")
	}
	agent, err := s.store.GetAgent(ctx, req.Identity.AgentID)
	if err != nil {
		return err
	}
	if agent.Status != StatusActive {
		return errors.New("agent is not active")
	}
	argumentsHash, err := ArgumentsHash(req.Arguments)
	if err != nil {
		return err
	}
	if gate.AgentID != req.Identity.AgentID ||
		gate.TenantID != agent.TenantID ||
		gate.UserID != req.Identity.UserID ||
		gate.ActorID != req.Identity.Subject ||
		gate.TokenID != req.Identity.TokenID ||
		gate.TokenHash != HashToken(req.BearerToken) ||
		gate.ExposedName != req.ExposedName ||
		gate.EndpointUpstreamServerID != req.EndpointUpstreamServerID ||
		gate.ArgumentsHash != argumentsHash ||
		(gate.InboundSessionID != "" && req.InboundSession != "" && gate.InboundSessionID != req.InboundSession) {
		return errors.New("mcp confirmation retry does not match the original request")
	}
	return nil
}

func declinedConfirmationResult(gate GateRequest) ToolCallResult {
	return ToolCallResult{
		StructuredContent: JSONMap{
			"gate_required": false,
			"gate_id":       gate.ID,
			"status":        string(gate.Status),
			"reason":        gate.DecisionReason,
		},
		IsError: true,
	}
}

func (s *Service) ExecuteAcceptedConfirmation(ctx context.Context, id string) (GateRequest, error) {
	gate, _, err := s.executeAcceptedConfirmation(ctx, id, nil, nil)
	return gate, err
}

func (s *Service) executeAcceptedConfirmation(ctx context.Context, id string, progressToken any, progressHandler ProgressHandler) (GateRequest, ToolCallResult, error) {
	now := s.clock()
	gate, err := s.store.UpdateGateExecution(ctx, GateExecutionUpdate{
		ID:        id,
		From:      GateAccepted,
		To:        GateExecuting,
		UpdatedAt: now,
	})
	if err != nil {
		if errors.Is(err, ErrGateConflict) || errors.Is(err, ErrGateNotFound) {
			current, getErr := s.store.GetGateRequest(ctx, id)
			if getErr == nil {
				return current, ToolCallResult{}, err
			}
		}
		return GateRequest{}, ToolCallResult{}, err
	}

	agent, err := s.store.GetAgent(ctx, gate.AgentID)
	if err != nil {
		failed, failErr := s.failExecutingGate(ctx, gate, "", err)
		return failed, ToolCallResult{}, failErr
	}
	if err := s.validateCaller(ctx, gate.UserID, gate.AgentID); err != nil {
		failed, failErr := s.failExecutingGate(ctx, gate, "", err)
		return failed, ToolCallResult{}, failErr
	}
	if agent.Status != StatusActive {
		failed, failErr := s.failExecutingGate(ctx, gate, "", fmt.Errorf("agent is not active: %s", gate.AgentID))
		return failed, ToolCallResult{}, failErr
	}
	capability, err := s.store.GetCapabilityByExposedName(ctx, gate.ExposedName)
	if err != nil {
		failed, failErr := s.failExecutingGate(ctx, gate, "", err)
		return failed, ToolCallResult{}, failErr
	}
	if capability.UpstreamServerID != gate.UpstreamServerID ||
		(gate.EndpointUpstreamServerID != "" && capability.UpstreamServerID != gate.EndpointUpstreamServerID) {
		failed, failErr := s.failExecutingGate(ctx, gate, "", fmt.Errorf("%w: %s", ErrCapabilityNotAvailableOnEndpoint, gate.ExposedName))
		return failed, ToolCallResult{}, failErr
	}
	if capability.Type != CapabilityTool || capability.Status != StatusActive {
		failed, failErr := s.failExecutingGate(ctx, gate, "", fmt.Errorf("capability is disabled: %s", gate.ExposedName))
		return failed, ToolCallResult{}, failErr
	}
	grants, err := s.store.ListGrants(ctx, GrantFilter{UserID: gate.UserID, CapabilityID: capability.ID, GrantType: GrantTool})
	if err != nil {
		failed, failErr := s.failExecutingGate(ctx, gate, "", err)
		return failed, ToolCallResult{}, failErr
	}
	decision := DecideGrant(now, grants, gate.UserID, capability.ID, GrantTool)
	if !decision.Allowed {
		failed, failErr := s.failExecutingGate(ctx, gate, "", fmt.Errorf("mcp tool is not granted after confirmation: %s", decision.Reason))
		return failed, ToolCallResult{}, failErr
	}
	server, err := s.store.GetUpstreamServer(ctx, gate.UpstreamServerID)
	if err != nil {
		failed, failErr := s.failExecutingGate(ctx, gate, "", err)
		return failed, ToolCallResult{}, failErr
	}
	if server.Status != StatusActive {
		failed, failErr := s.failExecutingGate(ctx, gate, "", fmt.Errorf("upstream server is disabled: %s", server.ID))
		return failed, ToolCallResult{}, failErr
	}
	if gate.SchemaHash != capability.SchemaHash {
		failed, failErr := s.failExecutingGate(ctx, gate, "", errors.New("schema_changed_after_confirmation"))
		return failed, ToolCallResult{}, failErr
	}
	executionArguments, err := s.restoreGateArguments(gate)
	if err != nil {
		failed, failErr := s.failExecutingGate(ctx, gate, "", err)
		return failed, ToolCallResult{}, failErr
	}
	if err := ValidateInput(capability.InputSchema, executionArguments); err != nil {
		failed, failErr := s.failExecutingGate(ctx, gate, "", err)
		return failed, ToolCallResult{}, failErr
	}
	if s.upstreamClient == nil {
		failed, failErr := s.failExecutingGate(ctx, gate, "", errors.New("upstream mcp client is not configured"))
		return failed, ToolCallResult{}, failErr
	}

	started := s.clock()
	requestID := requestIDFromHeaders(gate.RequestHeaders)
	audit := ProxyAuditRecord{
		ID:                       NewAuditID(started, gate.ExposedName),
		RequestID:                requestID,
		TraceID:                  gate.TraceID,
		InboundSessionID:         gate.InboundSessionID,
		AgentID:                  gate.AgentID,
		UserID:                   gate.UserID,
		ActorID:                  gate.ActorID,
		TenantID:                 gate.TenantID,
		TokenID:                  gate.TokenID,
		TokenHash:                gate.TokenHash,
		EndpointType:             gate.EndpointType,
		EndpointUpstreamServerID: gate.EndpointUpstreamServerID,
		UpstreamServerID:         gate.UpstreamServerID,
		CapabilityID:             capability.ID,
		CapabilityType:           capability.Type,
		ExposedName:              gate.ExposedName,
		UpstreamName:             capability.UpstreamName,
		RequestHeaders:           cloneJSONMap(gate.RequestHeaders),
		RequestBody:              cloneJSONMap(executionArguments),
		CreatedAt:                started,
	}
	req := ToolCallRequest{
		RequestID: requestID,
		Identity: AgentIdentity{
			UserID:  gate.UserID,
			Subject: gate.ActorID,
			AgentID: gate.AgentID,
			TokenID: gate.TokenID,
		},
		ExposedName:              gate.ExposedName,
		Arguments:                cloneJSONMap(executionArguments),
		InboundSession:           gate.InboundSessionID,
		TenantID:                 gate.TenantID,
		RequestHeaders:           cloneJSONMap(gate.RequestHeaders),
		EndpointUpstreamServerID: gate.EndpointUpstreamServerID,
		ProgressToken:            progressToken,
		ProgressHandler:          progressHandler,
	}
	result, audit, execErr := s.executeToolSnapshot(ctx, ToolExecutionRequest{
		Started:         started,
		Audit:           audit,
		Agent:           agent,
		Server:          server,
		Capability:      capability,
		Request:         req,
		Arguments:       cloneJSONMap(executionArguments),
		SuccessDecision: DecisionConfirmationCompleted,
		FailureDecision: DecisionConfirmationExecutionFailed,
	})
	completed := s.clock()
	if execErr != nil {
		if audit.Decision == DecisionConfirmationCompleted && audit.Error == "" {
			completedGate, updateErr := s.store.UpdateGateExecution(ctx, GateExecutionUpdate{
				ID:               gate.ID,
				From:             GateExecuting,
				To:               GateCompleted,
				ExecutionAuditID: audit.ID,
				ResponseHeaders:  cloneJSONMap(audit.ResponseHeaders),
				ResponseBody:     gateToolResponseBody(gate, result),
				UpdatedAt:        completed,
				CompletedAt:      completed,
			})
			if updateErr != nil {
				return GateRequest{}, ToolCallResult{}, updateErr
			}
			return completedGate, result, execErr
		}
		failed, updateErr := s.store.UpdateGateExecution(ctx, GateExecutionUpdate{
			ID:               gate.ID,
			From:             GateExecuting,
			To:               GateFailed,
			ExecutionAuditID: audit.ID,
			Error:            execErr.Error(),
			UpdatedAt:        completed,
			CompletedAt:      completed,
		})
		if updateErr != nil {
			return GateRequest{}, ToolCallResult{}, updateErr
		}
		return failed, ToolCallResult{}, execErr
	}
	completedGate, updateErr := s.store.UpdateGateExecution(ctx, GateExecutionUpdate{
		ID:               gate.ID,
		From:             GateExecuting,
		To:               GateCompleted,
		ExecutionAuditID: audit.ID,
		ResponseHeaders:  cloneJSONMap(audit.ResponseHeaders),
		ResponseBody:     gateToolResponseBody(gate, result),
		UpdatedAt:        completed,
		CompletedAt:      completed,
	})
	return completedGate, result, updateErr
}

func (s *Service) failExecutingGate(ctx context.Context, gate GateRequest, executionAuditID string, cause error) (GateRequest, error) {
	if cause == nil {
		cause = errors.New("confirmation execution failed")
	}
	now := s.clock()
	auditID := executionAuditID
	if auditID == "" {
		auditID = NewAuditID(now, gate.ExposedName)
	}
	audit := ProxyAuditRecord{
		ID:                       auditID,
		RequestID:                requestIDFromHeaders(gate.RequestHeaders),
		TraceID:                  gate.TraceID,
		InboundSessionID:         gate.InboundSessionID,
		UpstreamSessionID:        gate.UpstreamSessionID,
		AgentID:                  gate.AgentID,
		UserID:                   gate.UserID,
		ActorID:                  gate.ActorID,
		TenantID:                 gate.TenantID,
		TokenID:                  gate.TokenID,
		TokenHash:                gate.TokenHash,
		EndpointType:             gate.EndpointType,
		EndpointUpstreamServerID: gate.EndpointUpstreamServerID,
		UpstreamServerID:         gate.UpstreamServerID,
		CapabilityID:             gate.CapabilityID,
		CapabilityType:           gate.CapabilityType,
		ExposedName:              gate.ExposedName,
		UpstreamName:             gate.UpstreamName,
		RequestHeaders:           cloneJSONMap(gate.RequestHeaders),
		RequestBody:              cloneJSONMap(gate.RequestBody),
		Decision:                 DecisionConfirmationExecutionFailed,
		DecisionReason:           cause.Error(),
		Error:                    cause.Error(),
		CreatedAt:                now,
		CompletedAt:              now,
	}
	audit = ProjectProxyAudit(audit)
	if err := s.store.SaveProxyAuditRecord(context.Background(), audit); err != nil {
		logProxyAuditSaveFailure(s, audit, err)
	}
	updated, err := s.store.UpdateGateExecution(ctx, GateExecutionUpdate{
		ID:               gate.ID,
		From:             GateExecuting,
		To:               GateFailed,
		ExecutionAuditID: auditID,
		Error:            cause.Error(),
		UpdatedAt:        now,
		CompletedAt:      now,
	})
	if err != nil {
		return GateRequest{}, err
	}
	return updated, cause
}

func (s *Service) createConfirmationGate(ctx context.Context, input confirmationGateInput) (GateRequest, JSONMap, ProxyAuditRecord, error) {
	return s.createTypedGate(ctx, input, GateTypeUserConfirmation)
}

func (s *Service) createTypedGate(ctx context.Context, input confirmationGateInput, gateType string) (GateRequest, JSONMap, ProxyAuditRecord, error) {
	argumentsHash, err := ArgumentsHash(input.Request.Arguments)
	if err != nil {
		return GateRequest{}, nil, ProxyAuditRecord{}, err
	}
	storedArguments, summaryArguments, err := s.protectGateArguments(input.Capability, input.Request.Arguments)
	if err != nil {
		return GateRequest{}, nil, ProxyAuditRecord{}, err
	}

	now := s.clock()
	gateID := newGateID(now, input.Capability.ExposedName)
	confirmURL := "/admin/mcp/gates/detail?gate_id=" + url.QueryEscape(gateID)
	expiresAt := now.Add(30 * time.Minute)
	responseBody := JSONMap{
		"gate_required": true,
		"gate_type":     gateType,
		"gate_id":       gateID,
		"confirm_url":   confirmURL,
		"status":        string(GatePending),
		"expires_at":    expiresAt.Format(time.RFC3339Nano),
	}
	audit := input.Audit
	audit.Decision = DecisionGateRequired
	audit.DecisionReason = gateID
	audit.ResponseBody = cloneJSONMap(responseBody)

	gate := GateRequest{
		ID:                       gateID,
		Type:                     gateType,
		Provider:                 GateProviderInternal,
		TraceID:                  audit.TraceID,
		RequestAuditID:           audit.ID,
		TenantID:                 input.Agent.TenantID,
		UserID:                   input.Request.Identity.UserID,
		AgentID:                  input.Request.Identity.AgentID,
		ActorID:                  input.Request.Identity.Subject,
		TokenID:                  input.Request.Identity.TokenID,
		TokenHash:                HashToken(input.Request.BearerToken),
		EndpointType:             audit.EndpointType,
		EndpointUpstreamServerID: audit.EndpointUpstreamServerID,
		CapabilityID:             input.Capability.ID,
		CapabilityType:           input.Capability.Type,
		UpstreamServerID:         input.Server.ID,
		InboundSessionID:         input.Request.InboundSession,
		ExposedName:              input.Capability.ExposedName,
		UpstreamName:             input.Capability.UpstreamName,
		RequestHeaders:           SanitizeHeaders(input.Request.RequestHeaders),
		RequestBody:              storedArguments,
		ArgumentsHash:            argumentsHash,
		SchemaHash:               input.Capability.SchemaHash,
		GateSummary:              BuildGateSummary(input.Capability, summaryArguments),
		Status:                   GatePending,
		ConfirmURL:               confirmURL,
		ExpiresAt:                expiresAt,
		ResponseBody:             cloneJSONMap(responseBody),
		CreatedAt:                now,
		UpdatedAt:                now,
	}
	if err := s.store.SaveGateRequest(ctx, gate); err != nil {
		return GateRequest{}, nil, ProxyAuditRecord{}, err
	}
	return gate, responseBody, audit, nil
}

func (s *Service) protectGateArguments(capability Capability, arguments JSONMap) (JSONMap, JSONMap, error) {
	stored := cloneJSONMap(arguments)
	summary := cloneJSONMap(arguments)
	if !IsKnowledgeSearchCapability(capability) {
		return stored, summary, nil
	}
	query, ok := arguments["query"].(string)
	if !ok {
		return nil, nil, errors.New(DecisionInvalidInput)
	}
	ciphertext, err := s.encryptTokenPlaintext(query)
	if err != nil {
		return nil, nil, err
	}
	stored["query"] = encryptedKnowledgeQueryPrefix + base64.RawURLEncoding.EncodeToString(ciphertext)
	summary["query"] = "[redacted]"
	return stored, summary, nil
}

func (s *Service) restoreGateArguments(gate GateRequest) (JSONMap, error) {
	arguments := cloneJSONMap(gate.RequestBody)
	if !isKnowledgeSearchGate(gate) {
		return arguments, nil
	}
	value, ok := arguments["query"].(string)
	if !ok || !strings.HasPrefix(value, encryptedKnowledgeQueryPrefix) {
		return nil, errors.New("invalid encrypted knowledge query")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, encryptedKnowledgeQueryPrefix))
	if err != nil {
		return nil, errors.New("invalid encrypted knowledge query")
	}
	plaintext, err := s.decryptTokenPlaintext(ciphertext)
	if err != nil {
		return nil, errors.New("invalid encrypted knowledge query")
	}
	arguments["query"] = string(plaintext)
	return arguments, nil
}

func gateToolResponseBody(gate GateRequest, result ToolCallResult) JSONMap {
	body := toolResponseBody(result.StructuredContent, result.Content)
	if !isKnowledgeSearchGate(gate) {
		return body
	}
	if result.IsError {
		return JSONMap{"code": "knowledge_provider_error", "error": "知识库服务暂时不可用"}
	}
	return ProjectProxyAudit(ProxyAuditRecord{UpstreamServerID: gate.UpstreamServerID, UpstreamName: gate.UpstreamName, ExposedName: gate.ExposedName, ResponseBody: body}).ResponseBody
}

func shouldAttemptSynchronousConfirmation(req ToolCallRequest) bool {
	if req.ConfirmationElicitor == nil || !req.ConfirmationElicitor.SupportsUserConfirmation() {
		return false
	}
	mode := strings.TrimSpace(req.ConfirmationMode)
	if mode == "" || mode == ConfirmationModeAuto {
		return true
	}
	if mode == ConfirmationModeSync {
		return true
	}
	return false
}

func syncDeclineReason(decision SyncConfirmationDecision) string {
	reason := strings.TrimSpace(decision.Reason)
	if reason != "" {
		return reason
	}
	if decision.Action == SyncConfirmationCancelled {
		return "cancelled_by_user"
	}
	return "rejected_by_user"
}

func (s *Service) requireAdminApproval(ctx context.Context, input confirmationGateInput) (confirmationGateResult, error) {
	if !input.Capability.ApprovalRequired {
		return confirmationGateResult{}, nil
	}

	_, responseBody, audit, err := s.createTypedGate(ctx, input, GateTypeAdminApproval)
	if err != nil {
		return confirmationGateResult{}, err
	}
	saveProxyAudit(s, input.Started, &audit)

	return confirmationGateResult{
		Required: true,
		Result: ToolCallResult{
			StructuredContent: responseBody,
		},
	}, nil
}

func (s *Service) requireConfirmation(ctx context.Context, input confirmationGateInput) (confirmationGateResult, error) {
	if !input.Capability.ConfirmRequired {
		return confirmationGateResult{}, nil
	}

	gate, responseBody, audit, err := s.createConfirmationGate(ctx, input)
	if err != nil {
		return confirmationGateResult{}, err
	}

	if shouldAttemptSynchronousConfirmation(input.Request) {
		saveProxyAudit(s, input.Started, &audit)

		syncAudit := audit
		syncAudit.ID = audit.ID + "_sync_confirmation"
		syncAudit.Decision = DecisionConfirmationSyncRequested
		syncAudit.DecisionReason = gate.ID
		syncAudit.ResponseBody = cloneJSONMap(responseBody)
		saveProxyAudit(s, input.Started, &syncAudit)

		decision, err := input.Request.ConfirmationElicitor.ElicitUserConfirmation(ctx, SyncConfirmationInput{
			Gate:       gate,
			Capability: input.Capability,
			Timeout:    s.syncConfirmationTimeout,
		})
		if err == nil {
			switch decision.Action {
			case SyncConfirmationAccepted:
				_, result, execErr := s.acceptAndExecuteGate(ctx, gate.ID, gate.ActorID, firstNonEmpty(decision.Reason, "accepted"), input.Request.ProgressToken, input.Request.ProgressHandler)
				if execErr != nil {
					return confirmationGateResult{}, execErr
				}
				return confirmationGateResult{
					Required: true,
					Result:   result,
				}, nil
			case SyncConfirmationDeclined, SyncConfirmationCancelled:
				rejected, rejectErr := s.DeclineConfirmation(ctx, gate.ID, syncDeclineReason(decision))
				if rejectErr != nil {
					return confirmationGateResult{}, rejectErr
				}
				body := JSONMap{
					"gate_required": false,
					"gate_id":       rejected.ID,
					"status":        string(rejected.Status),
					"reason":        rejected.DecisionReason,
				}
				return confirmationGateResult{
					Required: true,
					Result: ToolCallResult{
						StructuredContent: body,
						IsError:           true,
					},
				}, nil
			}
		}
		return confirmationGateResult{
			Required: true,
			Result: ToolCallResult{
				StructuredContent: responseBody,
			},
		}, nil
	}

	saveProxyAudit(s, input.Started, &audit)

	return confirmationGateResult{
		Required: true,
		Result: ToolCallResult{
			StructuredContent: responseBody,
		},
	}, nil
}

func saveListAudit(s *Service, audit ListAuditRecord) {
	if err := s.store.SaveListAuditRecord(context.Background(), audit); err != nil {
		logListAuditSaveFailure(s, audit, err)
	}
}

func saveProxyAudit(s *Service, started time.Time, audit *ProxyAuditRecord) {
	audit.CompletedAt = s.clock()
	audit.DurationMS = audit.CompletedAt.Sub(started).Milliseconds()
	projected := ProjectProxyAudit(*audit)
	*audit = projected
	if err := s.store.SaveProxyAuditRecord(context.Background(), projected); err != nil {
		logProxyAuditSaveFailure(s, projected, err)
	}
}

func (s *Service) resolveUpstreamBearer(server UpstreamServer, fallback string) (string, error) {
	if server.Transport == TransportBuiltin || server.Transport == TransportCollectorPull {
		return "", nil
	}
	if server.AuthType != "static_bearer" {
		return fallback, nil
	}
	if len(server.TokenCiphertext) > 0 {
		plaintext, err := s.decryptTokenPlaintext(server.TokenCiphertext)
		if err != nil {
			return "", err
		}
		token := strings.TrimSpace(string(plaintext))
		if token == "" {
			return "", errors.New("static bearer credential is empty")
		}
		return token, nil
	}
	if s.resolveCredential == nil || strings.TrimSpace(server.CredentialRef) == "" {
		return "", errors.New("static bearer credential is not configured")
	}
	token, err := s.resolveCredential(server.CredentialRef)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(token) == "" {
		return "", errors.New("static bearer credential is empty")
	}
	return token, nil
}

var errNoMatchingKnowledgeScope = errors.New(DecisionNoMatchingKnowledgeScope)

func knowledgeIDsFromAuditOrAccount(ctx context.Context, s *Service, req ToolExecutionRequest, audit ProxyAuditRecord) ([]string, error) {
	auditIDs := knowledgeBaseIDsFromResolvedScope(audit.ResolvedDataScope)
	grants, err := s.store.ListGrants(ctx, GrantFilter{UserID: req.Request.Identity.UserID, CapabilityID: req.Capability.ID, GrantType: GrantTool})
	if err != nil {
		return nil, err
	}
	decision := DecideGrant(s.clock(), grants, req.Request.Identity.UserID, req.Capability.ID, GrantTool)
	if !decision.Allowed {
		return nil, errors.New(DecisionInvalidKnowledgeScope)
	}
	ids, err := s.resolveMCPKnowledgeBaseIDs(ctx, req.Request.Identity.UserID)
	if err != nil {
		return nil, err
	}
	if len(auditIDs) > 0 {
		current := make(map[string]struct{}, len(ids))
		for _, id := range ids {
			current[id] = struct{}{}
		}
		narrowed := make([]string, 0, len(auditIDs))
		for _, id := range auditIDs {
			if _, ok := current[id]; ok {
				narrowed = append(narrowed, id)
			}
		}
		ids = narrowed
	}
	if len(ids) == 0 {
		return nil, errNoMatchingKnowledgeScope
	}
	return ids, nil
}

func (s *Service) resolveMCPKnowledgeBaseIDs(ctx context.Context, userID string) ([]string, error) {
	if s.knowledgeMCPAccessResolver == nil {
		return []string{}, nil
	}
	resolved, err := s.knowledgeMCPAccessResolver.ResolveMCPKnowledgeBaseIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(resolved))
	out := make([]string, 0, len(resolved))
	for _, id := range resolved {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, nil
}

func knowledgeBaseIDsFromResolvedScope(scope JSONMap) []string {
	value, ok := scope["knowledge_base_ids"]
	if !ok {
		return nil
	}
	var values []string
	switch typed := value.(type) {
	case []string:
		values = typed
	case []any:
		values = make([]string, 0, len(typed))
		for _, item := range typed {
			id, ok := item.(string)
			if ok {
				values = append(values, id)
			}
		}
	default:
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, id := range values {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func logListAuditSaveFailure(s *Service, audit ListAuditRecord, err error) {
	s.logger.Error("mcp list audit save failed",
		zap.String("audit_id", audit.ID),
		zap.String("trace_id", audit.TraceID),
		zap.String("agent_id", audit.AgentID),
		zap.String("actor_id", audit.ActorID),
		zap.String("decision", audit.Decision),
		zap.Error(err),
	)
}

func logProxyAuditSaveFailure(s *Service, audit ProxyAuditRecord, err error) {
	s.logger.Error("mcp proxy audit save failed",
		zap.String("audit_id", audit.ID),
		zap.String("trace_id", audit.TraceID),
		zap.String("request_id", audit.RequestID),
		zap.String("agent_id", audit.AgentID),
		zap.String("actor_id", audit.ActorID),
		zap.String("upstream_server_id", audit.UpstreamServerID),
		zap.String("capability_id", audit.CapabilityID),
		zap.String("exposed_name", audit.ExposedName),
		zap.String("decision", audit.Decision),
		zap.Error(err),
	)
}

func requestIDFromHeaders(headers JSONMap) string {
	for _, key := range []string{"x-request-id", "X-Request-ID"} {
		if value, ok := headers[key]; ok {
			if requestID := requestIDFromHeaderValue(value); requestID != "" {
				return requestID
			}
		}
	}
	for key, value := range headers {
		if strings.EqualFold(key, "x-request-id") {
			return requestIDFromHeaderValue(value)
		}
	}
	return ""
}

func requestIDFromHeaderValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []string:
		for _, item := range typed {
			if requestID := strings.TrimSpace(item); requestID != "" {
				return requestID
			}
		}
	case []any:
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				continue
			}
			if requestID := strings.TrimSpace(text); requestID != "" {
				return requestID
			}
		}
	}
	return ""
}

func exposeName(namespace, upstreamName string) string {
	namespace = strings.Trim(namespace, ". ")
	upstreamName = strings.Trim(upstreamName, ". ")
	if namespace == "" {
		return upstreamName
	}
	if strings.HasPrefix(upstreamName, namespace+".") {
		return upstreamName
	}
	return namespace + "." + upstreamName
}

func capabilityID(serverID, exposedName string) string {
	sum := sha256.Sum256([]byte(serverID + ":" + exposedName))
	return "cap_" + hex.EncodeToString(sum[:8])
}

func (s *Service) encryptTokenPlaintext(plaintext string) ([]byte, error) {
	if s.tokenCipher == nil {
		return nil, ErrTokenCipherNotConfigured
	}
	return s.tokenCipher.Encrypt([]byte(plaintext))
}

func (s *Service) decryptTokenPlaintext(ciphertext []byte) ([]byte, error) {
	if s.tokenCipher == nil {
		return nil, ErrTokenCipherNotConfigured
	}
	return s.tokenCipher.Decrypt(ciphertext)
}

type aesGCMTokenCipher struct {
	aead cipher.AEAD
}

func NewStaticTokenCipherForTest(key []byte) TokenCipher {
	cipher, err := NewTokenCipher(key)
	if err != nil {
		panic(err)
	}
	return cipher
}

func NewTokenCipher(key []byte) (TokenCipher, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return aesGCMTokenCipher{aead: aead}, nil
}

func (c aesGCMTokenCipher) Encrypt(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	ciphertext := c.aead.Seal(nil, nonce, plaintext, nil)
	return append(nonce, ciphertext...), nil
}

func (c aesGCMTokenCipher) Decrypt(ciphertext []byte) ([]byte, error) {
	nonceSize := c.aead.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, errors.New("agent token ciphertext is invalid")
	}
	nonce := ciphertext[:nonceSize]
	body := ciphertext[nonceSize:]
	return c.aead.Open(nil, nonce, body, nil)
}

func newTokenID(now time.Time, userID, tokenHash string) string {
	return fmt.Sprintf("token_%s_%d_%s", sanitizeID(userID), now.UnixNano(), TokenFingerprint(tokenHash))
}

func sanitizeID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('_')
	}
	return b.String()
}

func TokenFingerprint(tokenHash string) string {
	if len(tokenHash) <= 12 {
		return tokenHash
	}
	return tokenHash[len(tokenHash)-12:]
}

func NewAuditID(t time.Time, name string) string {
	return "mcp_audit_" + capabilityID(t.Format(time.RFC3339Nano), name)
}

func newGateID(t time.Time, name string) string {
	var raw [16]byte
	nonce := ""
	if _, err := rand.Read(raw[:]); err == nil {
		nonce = hex.EncodeToString(raw[:])
	} else {
		nonce = fmt.Sprintf("%d", atomic.AddUint64(&gateIDSequence, 1))
	}
	return "mcp_confirm_" + capabilityID(t.Format(time.RFC3339Nano), name+":"+nonce)
}

func NewTraceID(t time.Time, name string) string {
	return "trace_" + capabilityID(name, t.Format(time.RFC3339Nano))
}
