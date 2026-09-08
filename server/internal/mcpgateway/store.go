package mcpgateway

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"
)

var (
	ErrUpstreamServerNotFound = errors.New("upstream mcp server not found")
	ErrCapabilityNotFound     = errors.New("mcp capability not found")
	ErrAgentNotFound          = errors.New("agent registration not found")
	ErrGrantNotFound          = errors.New("account grant not found")
	ErrGrantAlreadyExists     = errors.New("account grant already exists")
	ErrAccountTokenNotFound   = errors.New("account token not found")
	ErrAgentAlreadyExists     = errors.New("agent registration already exists")
	ErrAgentOwnerUnavailable  = errors.New("agent owner account is unavailable")
	ErrGateNotFound           = errors.New("mcp gate request not found")
	ErrGateConflict           = errors.New("mcp gate request state conflict")
)

const (
	AgentCreationSourceCollector   = "collector"
	AgentCreationSourceClaweeLogin = "clawee_login"
	AgentCreationSourceManual      = "manual"
	AgentCreationSourceLegacy      = "legacy"
)

type Store interface {
	SaveAgent(context.Context, AgentRegistration) error
	UpdateAgentName(context.Context, string, string) (AgentRegistration, error)
	CreateOwnedAgent(context.Context, string, AgentRegistration) error
	GetAgent(context.Context, string) (AgentRegistration, error)
	ListAgents(context.Context, AgentFilter) ([]AgentRegistration, error)
	DeleteAgent(context.Context, string) error
	RotateAccountToken(context.Context, string, AccountToken) error
	RevokeAccountTokens(context.Context, string, time.Time) (int64, error)
	TouchAccountToken(context.Context, string, time.Time) error
	GetAccountTokenByHash(context.Context, string) (AccountToken, error)
	GetActiveAccountToken(context.Context, string) (AccountToken, error)
	GetLatestAccountToken(context.Context, string) (AccountToken, error)
	SaveUpstreamServer(context.Context, UpstreamServer) error
	GetUpstreamServer(context.Context, string) (UpstreamServer, error)
	ListUpstreamServers(context.Context) ([]UpstreamServer, error)
	DeleteUpstreamServer(context.Context, string) error
	SaveUpstreamSyncLog(context.Context, UpstreamSyncLog) error
	GetLatestUpstreamSyncLog(context.Context, string) (UpstreamSyncLog, error)
	SaveCapability(context.Context, Capability) error
	GetCapabilityByExposedName(context.Context, string) (Capability, error)
	ListCapabilities(context.Context, CapabilityFilter) ([]Capability, error)
	DeleteCapability(context.Context, string) error
	SaveGrant(context.Context, AccountGrant) error
	DeleteGrant(context.Context, string) error
	ListGrants(context.Context, GrantFilter) ([]AccountGrant, error)
	SaveListAuditRecord(context.Context, ListAuditRecord) error
	SaveProxyAuditRecord(context.Context, ProxyAuditRecord) error
	ListProxyAuditRecords(context.Context, ProxyAuditFilter) ([]ProxyAuditRecord, error)
	SaveGateRequest(context.Context, GateRequest) error
	GetGateRequest(context.Context, string) (GateRequest, error)
	ListGateRequests(context.Context, GateFilter) ([]GateRequest, error)
	UpdateGateDecision(context.Context, GateDecisionUpdate) (GateRequest, error)
	UpdateGateExecution(context.Context, GateExecutionUpdate) (GateRequest, error)
}

type MemoryStore struct {
	mu            sync.RWMutex
	ownerBinder   func(context.Context, string, string, time.Time) error
	ownerRemover  func(context.Context, string) error
	agents        map[string]AgentRegistration
	accountTokens map[string]AccountToken
	servers       map[string]UpstreamServer
	syncLogs      []UpstreamSyncLog
	capabilities  map[string]Capability
	grants        map[string]AccountGrant
	listAudits    []ListAuditRecord
	audits        []ProxyAuditRecord
	gates         map[string]GateRequest
	agentOwners   map[string]string
}

func (s *MemoryStore) SetOwnedAgentBinder(binder func(context.Context, string, string, time.Time) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ownerBinder = binder
}

func (s *MemoryStore) SetOwnedAgentRemover(remover func(context.Context, string) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ownerRemover = remover
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		agents:        map[string]AgentRegistration{},
		accountTokens: map[string]AccountToken{},
		servers:       map[string]UpstreamServer{},
		syncLogs:      []UpstreamSyncLog{},
		capabilities:  map[string]Capability{},
		grants:        map[string]AccountGrant{},
		gates:         map[string]GateRequest{},
		agentOwners:   map[string]string{},
	}
}

func (s *MemoryStore) CreateOwnedAgent(ctx context.Context, userID string, agent AgentRegistration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.agents[agent.AgentID]; ok {
		return ErrAgentAlreadyExists
	}
	now := time.Now().UTC()
	if agent.CreatedAt.IsZero() {
		agent.CreatedAt = now
	}
	if agent.CreationSource == "" {
		agent.CreationSource = AgentCreationSourceLegacy
	}
	agent.UpdatedAt = now
	if s.ownerBinder != nil {
		if err := s.ownerBinder(ctx, userID, agent.AgentID, agent.CreatedAt); err != nil {
			return err
		}
	}
	s.agents[agent.AgentID] = cloneAgentRegistration(agent)
	s.agentOwners[agent.AgentID] = userID
	return nil
}

func (s *MemoryStore) SaveAgent(ctx context.Context, agent AgentRegistration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if agent.CreatedAt.IsZero() {
		agent.CreatedAt = now
	}
	if agent.CreationSource == "" {
		agent.CreationSource = AgentCreationSourceLegacy
	}
	agent.UpdatedAt = now
	s.agents[agent.AgentID] = agent
	return nil
}

func (s *MemoryStore) UpdateAgentName(ctx context.Context, agentID, name string) (AgentRegistration, error) {
	if err := ctx.Err(); err != nil {
		return AgentRegistration{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, ok := s.agents[agentID]
	if !ok {
		return AgentRegistration{}, ErrAgentNotFound
	}
	agent.Name = name
	agent.UpdatedAt = time.Now().UTC()
	s.agents[agentID] = cloneAgentRegistration(agent)
	return cloneAgentRegistration(agent), nil
}

func (s *MemoryStore) GetAgent(ctx context.Context, agentID string) (AgentRegistration, error) {
	if err := ctx.Err(); err != nil {
		return AgentRegistration{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	agent, ok := s.agents[agentID]
	if !ok {
		return AgentRegistration{}, ErrAgentNotFound
	}
	return cloneAgentRegistration(agent), nil
}

func (s *MemoryStore) ListAgents(ctx context.Context, filter AgentFilter) ([]AgentRegistration, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []AgentRegistration{}
	for _, agent := range s.agents {
		if filter.AgentID != "" && agent.AgentID != filter.AgentID {
			continue
		}
		if filter.Status != "" && agent.Status != filter.Status {
			continue
		}
		out = append(out, cloneAgentRegistration(agent))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].AgentID < out[j].AgentID
	})
	return out, nil
}

func (s *MemoryStore) DeleteAgent(ctx context.Context, agentID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.agents[agentID]; !ok {
		return ErrAgentNotFound
	}
	if s.ownerRemover != nil {
		if err := s.ownerRemover(ctx, agentID); err != nil {
			return err
		}
	}
	delete(s.agents, agentID)
	delete(s.agentOwners, agentID)
	return nil
}

func (s *MemoryStore) RotateAccountToken(ctx context.Context, userID string, token AccountToken) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if userID == "" || token.UserID != userID {
		return ErrAgentOwnerUnavailable
	}
	now := time.Now().UTC()
	for id, existing := range s.accountTokens {
		if existing.UserID == userID && existing.Status == StatusActive {
			existing.Status = StatusRevoked
			existing.UpdatedAt = now
			s.accountTokens[id] = existing
		}
	}
	if token.CreatedAt.IsZero() {
		token.CreatedAt = now
	}
	token.UpdatedAt = now
	s.accountTokens[token.ID] = cloneAccountToken(token)
	return nil
}

func (s *MemoryStore) RevokeAccountTokens(ctx context.Context, userID string, revokedAt time.Time) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int64
	for id, existing := range s.accountTokens {
		if existing.UserID == userID && existing.Status == StatusActive {
			existing.Status = StatusRevoked
			existing.UpdatedAt = revokedAt
			s.accountTokens[id] = existing
			count++
		}
	}
	if count == 0 {
		return 0, ErrAccountTokenNotFound
	}
	return count, nil
}

func (s *MemoryStore) TouchAccountToken(ctx context.Context, tokenID string, usedAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	token, ok := s.accountTokens[tokenID]
	if !ok {
		return ErrAccountTokenNotFound
	}
	token.LastUsedAt = &usedAt
	token.UpdatedAt = usedAt
	s.accountTokens[tokenID] = token
	return nil
}

func (s *MemoryStore) GetAccountTokenByHash(ctx context.Context, tokenHash string) (AccountToken, error) {
	if err := ctx.Err(); err != nil {
		return AccountToken{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, token := range s.accountTokens {
		if token.TokenHash == tokenHash {
			return cloneAccountToken(token), nil
		}
	}
	return AccountToken{}, ErrAccountTokenNotFound
}

func (s *MemoryStore) GetActiveAccountToken(ctx context.Context, userID string) (AccountToken, error) {
	if err := ctx.Err(); err != nil {
		return AccountToken{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out AccountToken
	for _, token := range s.accountTokens {
		if token.UserID != userID || token.Status != StatusActive {
			continue
		}
		if out.ID == "" || token.CreatedAt.After(out.CreatedAt) {
			out = token
		}
	}
	if out.ID == "" {
		return AccountToken{}, ErrAccountTokenNotFound
	}
	return cloneAccountToken(out), nil
}

func (s *MemoryStore) GetLatestAccountToken(ctx context.Context, userID string) (AccountToken, error) {
	if err := ctx.Err(); err != nil {
		return AccountToken{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out AccountToken
	for _, token := range s.accountTokens {
		if token.UserID != userID {
			continue
		}
		if out.ID == "" || token.CreatedAt.After(out.CreatedAt) {
			out = token
		}
	}
	if out.ID == "" {
		return AccountToken{}, ErrAccountTokenNotFound
	}
	return cloneAccountToken(out), nil
}

func (s *MemoryStore) SaveUpstreamServer(ctx context.Context, server UpstreamServer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if server.CreatedAt.IsZero() {
		server.CreatedAt = now
	}
	server.UpdatedAt = now
	s.servers[server.ID] = server
	return nil
}

func (s *MemoryStore) GetUpstreamServer(ctx context.Context, id string) (UpstreamServer, error) {
	if err := ctx.Err(); err != nil {
		return UpstreamServer{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	server, ok := s.servers[id]
	if !ok || server.DeletedAt != nil {
		return UpstreamServer{}, ErrUpstreamServerNotFound
	}
	return cloneUpstreamServer(server), nil
}

func (s *MemoryStore) ListUpstreamServers(ctx context.Context) ([]UpstreamServer, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]UpstreamServer, 0, len(s.servers))
	for _, server := range s.servers {
		if server.DeletedAt != nil {
			continue
		}
		out = append(out, cloneUpstreamServer(server))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (s *MemoryStore) DeleteUpstreamServer(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	server, ok := s.servers[id]
	if !ok || server.DeletedAt != nil {
		return ErrUpstreamServerNotFound
	}
	now := time.Now().UTC()
	server.Status = StatusDisabled
	server.UpdatedAt = now
	server.DeletedAt = &now
	s.servers[id] = server
	return nil
}

func (s *MemoryStore) SaveUpstreamSyncLog(ctx context.Context, log UpstreamSyncLog) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.syncLogs = append(s.syncLogs, log)
	return nil
}

func (s *MemoryStore) GetLatestUpstreamSyncLog(ctx context.Context, serverID string) (UpstreamSyncLog, error) {
	if err := ctx.Err(); err != nil {
		return UpstreamSyncLog{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out UpstreamSyncLog
	for _, log := range s.syncLogs {
		if log.UpstreamServerID != serverID {
			continue
		}
		if out.ID == "" || log.CompletedAt.After(out.CompletedAt) {
			out = log
		}
	}
	if out.ID == "" {
		return UpstreamSyncLog{}, ErrUpstreamServerNotFound
	}
	return out, nil
}

func (s *MemoryStore) SaveCapability(ctx context.Context, capability Capability) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if capability.CreatedAt.IsZero() {
		capability.CreatedAt = now
	}
	capability.UpdatedAt = now
	for id, existing := range s.capabilities {
		if id != capability.ID && existing.ExposedName == capability.ExposedName {
			delete(s.capabilities, id)
		}
	}
	capability = cloneCapability(capability)
	s.capabilities[capability.ID] = capability
	return nil
}

func (s *MemoryStore) GetCapabilityByExposedName(ctx context.Context, exposedName string) (Capability, error) {
	if err := ctx.Err(); err != nil {
		return Capability{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, capability := range s.capabilities {
		if capability.ExposedName == exposedName {
			return cloneCapability(capability), nil
		}
	}
	return Capability{}, ErrCapabilityNotFound
}

func (s *MemoryStore) ListCapabilities(ctx context.Context, filter CapabilityFilter) ([]Capability, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Capability{}
	for _, capability := range s.capabilities {
		if server, ok := s.servers[capability.UpstreamServerID]; ok && server.DeletedAt != nil {
			continue
		}
		if filter.ID != "" && capability.ID != filter.ID {
			continue
		}
		if filter.Type != "" && capability.Type != filter.Type {
			continue
		}
		if filter.Status != "" && capability.Status != filter.Status {
			continue
		}
		if filter.UpstreamServerID != "" && capability.UpstreamServerID != filter.UpstreamServerID {
			continue
		}
		if filter.RiskLevel != "" && capability.RiskLevel != filter.RiskLevel {
			continue
		}
		if filter.Domain != "" {
			server, ok := s.servers[capability.UpstreamServerID]
			if !ok || server.Domain != filter.Domain {
				continue
			}
		}
		out = append(out, cloneCapability(capability))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ExposedName < out[j].ExposedName
	})
	return out, nil
}

func (s *MemoryStore) DeleteCapability(ctx context.Context, capabilityID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.capabilities[capabilityID]; !ok {
		return ErrCapabilityNotFound
	}
	delete(s.capabilities, capabilityID)
	for grantID, grant := range s.grants {
		if grant.CapabilityID == capabilityID {
			delete(s.grants, grantID)
		}
	}
	return nil
}

func (s *MemoryStore) SaveGrant(ctx context.Context, grant AccountGrant) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.grants {
		if existing.ID != grant.ID &&
			existing.UserID == grant.UserID &&
			existing.CapabilityID == grant.CapabilityID &&
			existing.GrantType == grant.GrantType {
			return ErrGrantAlreadyExists
		}
	}
	now := time.Now().UTC()
	if grant.CreatedAt.IsZero() {
		grant.CreatedAt = now
	}
	grant.UpdatedAt = now
	grant = cloneAccountGrant(grant)
	s.grants[grant.ID] = grant
	return nil
}

func (s *MemoryStore) DeleteGrant(ctx context.Context, grantID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.grants[grantID]; !ok {
		return ErrGrantNotFound
	}
	delete(s.grants, grantID)
	return nil
}

func (s *MemoryStore) ListGrants(ctx context.Context, filter GrantFilter) ([]AccountGrant, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []AccountGrant{}
	for _, grant := range s.grants {
		if filter.UserID != "" && grant.UserID != filter.UserID {
			continue
		}
		if filter.CapabilityID != "" && grant.CapabilityID != filter.CapabilityID {
			continue
		}
		if filter.GrantType != "" && grant.GrantType != filter.GrantType {
			continue
		}
		out = append(out, cloneAccountGrant(grant))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (s *MemoryStore) SaveListAuditRecord(ctx context.Context, record ListAuditRecord) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listAudits = append(s.listAudits, cloneListAuditRecord(record))
	return nil
}

func (s *MemoryStore) ListAuditRecordsForTest() []ListAuditRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ListAuditRecord, 0, len(s.listAudits))
	for _, record := range s.listAudits {
		out = append(out, cloneListAuditRecord(record))
	}
	return out
}

func (s *MemoryStore) SaveProxyAuditRecord(ctx context.Context, record ProxyAuditRecord) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.audits = append(s.audits, cloneProxyAuditRecord(record))
	return nil
}

func (s *MemoryStore) ListProxyAuditRecords(ctx context.Context, filter ProxyAuditFilter) ([]ProxyAuditRecord, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	limit := filter.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if limit > len(s.audits) {
		limit = len(s.audits)
	}
	out := make([]ProxyAuditRecord, 0, limit)
	for i := len(s.audits) - 1; i >= 0 && len(out) < limit; i-- {
		if !matchesProxyAuditFilter(s.audits[i], filter) {
			continue
		}
		out = append(out, cloneProxyAuditRecord(s.audits[i]))
	}
	return out, nil
}

func (s *MemoryStore) SaveGateRequest(ctx context.Context, gate GateRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if gate.CreatedAt.IsZero() {
		gate.CreatedAt = now
	}
	if gate.UpdatedAt.IsZero() {
		gate.UpdatedAt = now
	}
	s.gates[gate.ID] = cloneGateRequest(gate)
	return nil
}

func (s *MemoryStore) GetGateRequest(ctx context.Context, id string) (GateRequest, error) {
	if err := ctx.Err(); err != nil {
		return GateRequest{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	gate, ok := s.gates[id]
	if !ok {
		return GateRequest{}, ErrGateNotFound
	}
	return cloneGateRequest(gate), nil
}

func (s *MemoryStore) ListGateRequests(ctx context.Context, filter GateFilter) ([]GateRequest, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	limit := filter.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	out := make([]GateRequest, 0, limit)
	for _, gate := range s.gates {
		if !matchesGateFilter(gate, filter) {
			continue
		}
		out = append(out, cloneGateRequest(gate))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *MemoryStore) UpdateGateDecision(ctx context.Context, update GateDecisionUpdate) (GateRequest, error) {
	if err := ctx.Err(); err != nil {
		return GateRequest{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	gate, ok := s.gates[update.ID]
	if !ok {
		return GateRequest{}, ErrGateNotFound
	}
	if gate.Status != update.From {
		return GateRequest{}, ErrGateConflict
	}
	now := time.Now().UTC()
	if update.UpdatedAt.IsZero() {
		update.UpdatedAt = now
	}
	if update.DecidedAt.IsZero() {
		update.DecidedAt = update.UpdatedAt
	}
	gate.Status = update.To
	gate.DecidedBy = update.DecidedBy
	gate.DecisionReason = update.Reason
	gate.DecidedAt = &update.DecidedAt
	gate.Error = update.Error
	gate.UpdatedAt = update.UpdatedAt
	s.gates[update.ID] = cloneGateRequest(gate)
	return cloneGateRequest(gate), nil
}

func (s *MemoryStore) UpdateGateExecution(ctx context.Context, update GateExecutionUpdate) (GateRequest, error) {
	if err := ctx.Err(); err != nil {
		return GateRequest{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	gate, ok := s.gates[update.ID]
	if !ok {
		return GateRequest{}, ErrGateNotFound
	}
	if gate.Status != update.From {
		return GateRequest{}, ErrGateConflict
	}
	now := time.Now().UTC()
	if update.UpdatedAt.IsZero() {
		update.UpdatedAt = now
	}
	gate.Status = update.To
	gate.ExecutionAuditID = update.ExecutionAuditID
	gate.ResponseHeaders = cloneJSONMap(update.ResponseHeaders)
	gate.ResponseBody = cloneJSONMap(update.ResponseBody)
	gate.Error = update.Error
	gate.UpdatedAt = update.UpdatedAt
	if update.To == GateCompleted || update.To == GateFailed {
		if update.CompletedAt.IsZero() {
			update.CompletedAt = update.UpdatedAt
		}
		gate.CompletedAt = &update.CompletedAt
	}
	s.gates[update.ID] = cloneGateRequest(gate)
	return cloneGateRequest(gate), nil
}

func matchesGateFilter(gate GateRequest, filter GateFilter) bool {
	if filter.Type != "" && gate.Type != filter.Type {
		return false
	}
	if filter.Status != "" && string(gate.Status) != filter.Status {
		return false
	}
	if filter.AgentID != "" && gate.AgentID != filter.AgentID {
		return false
	}
	if filter.ActorID != "" && gate.ActorID != filter.ActorID {
		return false
	}
	if filter.TenantID != "" && gate.TenantID != filter.TenantID {
		return false
	}
	if filter.CapabilityID != "" && gate.CapabilityID != filter.CapabilityID {
		return false
	}
	if !filter.CreatedFrom.IsZero() && gate.CreatedAt.Before(filter.CreatedFrom) {
		return false
	}
	if !filter.CreatedTo.IsZero() && gate.CreatedAt.After(filter.CreatedTo) {
		return false
	}
	return true
}

func matchesProxyAuditFilter(record ProxyAuditRecord, filter ProxyAuditFilter) bool {
	if filter.ID != "" && record.ID != filter.ID {
		return false
	}
	if filter.Decision != "" && record.Decision != filter.Decision {
		return false
	}
	if filter.AgentID != "" && record.AgentID != filter.AgentID {
		return false
	}
	if filter.UpstreamServerID != "" && record.UpstreamServerID != filter.UpstreamServerID {
		return false
	}
	if filter.Tool != "" && record.ExposedName != filter.Tool && record.UpstreamName != filter.Tool && record.CapabilityID != filter.Tool {
		return false
	}
	if !filter.CreatedFrom.IsZero() && record.CreatedAt.Before(filter.CreatedFrom) {
		return false
	}
	if !filter.CreatedTo.IsZero() && record.CreatedAt.After(filter.CreatedTo) {
		return false
	}
	if filter.ErrorOnly && record.Error == "" {
		return false
	}
	return true
}

func cloneAgentRegistration(agent AgentRegistration) AgentRegistration {
	return agent
}

func cloneAccountToken(token AccountToken) AccountToken {
	token.TokenCiphertext = append([]byte(nil), token.TokenCiphertext...)
	token.Scopes = append([]string(nil), token.Scopes...)
	return token
}

func cloneUpstreamServer(server UpstreamServer) UpstreamServer {
	server.TokenCiphertext = append([]byte(nil), server.TokenCiphertext...)
	if server.DeletedAt != nil {
		deletedAt := *server.DeletedAt
		server.DeletedAt = &deletedAt
	}
	server.Stdio.Args = append([]string(nil), server.Stdio.Args...)
	if server.Stdio.Env != nil {
		env := make(map[string]string, len(server.Stdio.Env))
		for key, value := range server.Stdio.Env {
			env[key] = value
		}
		server.Stdio.Env = env
	}
	return server
}

func cloneCapability(capability Capability) Capability {
	capability.InputSchema = cloneJSONMap(capability.InputSchema)
	capability.OutputSchema = cloneJSONMap(capability.OutputSchema)
	capability.Annotations = cloneJSONMap(capability.Annotations)
	return capability
}

func cloneAccountGrant(grant AccountGrant) AccountGrant {
	grant.DataScope = cloneJSONMap(grant.DataScope)
	return grant
}

func cloneProxyAuditRecord(record ProxyAuditRecord) ProxyAuditRecord {
	record.RequestHeaders = cloneJSONMap(record.RequestHeaders)
	record.RequestBody = cloneJSONMap(record.RequestBody)
	record.ResponseHeaders = cloneJSONMap(record.ResponseHeaders)
	record.ResponseBody = cloneJSONMap(record.ResponseBody)
	record.ResolvedDataScope = cloneJSONMap(record.ResolvedDataScope)
	return record
}

func cloneListAuditRecord(record ListAuditRecord) ListAuditRecord {
	return record
}

func cloneGateRequest(gate GateRequest) GateRequest {
	gate.RequestHeaders = cloneJSONMap(gate.RequestHeaders)
	gate.RequestBody = cloneJSONMap(gate.RequestBody)
	gate.ResponseHeaders = cloneJSONMap(gate.ResponseHeaders)
	gate.ResponseBody = cloneJSONMap(gate.ResponseBody)
	gate.GateSummary = cloneGateSummary(gate.GateSummary)
	return gate
}

func cloneGateSummary(summary GateSummary) GateSummary {
	summary.Parameters = append([]GateParameter(nil), summary.Parameters...)
	summary.Risks = append([]string(nil), summary.Risks...)
	return summary
}

func cloneJSONMap(in JSONMap) JSONMap {
	if in == nil {
		return nil
	}
	out := make(JSONMap, len(in))
	for key, value := range in {
		out[key] = cloneJSONValue(value)
	}
	return out
}

func cloneJSONValue(value any) any {
	switch typed := value.(type) {
	case JSONMap:
		return cloneJSONMap(typed)
	case map[string]any:
		return cloneJSONMap(JSONMap(typed))
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = cloneJSONValue(item)
		}
		return out
	case []JSONMap:
		out := make([]JSONMap, len(typed))
		for i, item := range typed {
			out[i] = cloneJSONMap(item)
		}
		return out
	case []map[string]any:
		out := make([]map[string]any, len(typed))
		for i, item := range typed {
			out[i] = map[string]any(cloneJSONMap(JSONMap(item)))
		}
		return out
	default:
		return typed
	}
}
