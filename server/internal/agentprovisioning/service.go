package agentprovisioning

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

var (
	ErrInvalidAgentID  = errors.New("invalid agent id")
	ErrAgentIDConflict = errors.New("agent id conflicts with an existing agent")
	ErrAgentForbidden  = errors.New("agent is forbidden")
)

type Source string

const (
	SourceClaweeLogin Source = "clawee_login"
	SourceCollector   Source = "collector"
)

type EnsureRequest struct {
	UserID      string
	AgentID     string
	ClientID    string
	DisplayName string
	Source      Source
}

type EnsureResult struct {
	Agent   mcpgateway.AgentRegistration
	Created bool
}

type Service struct {
	accountService *accounts.Service
	proxyGateway   *mcpgateway.Service
}

func NewService(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service) *Service {
	return &Service{accountService: accountSvc, proxyGateway: proxyGateway}
}

func (s *Service) EnsureOwnedAgent(ctx context.Context, req EnsureRequest) (EnsureResult, error) {
	req.UserID = strings.TrimSpace(req.UserID)
	req.AgentID = strings.TrimSpace(req.AgentID)
	if req.UserID == "" {
		return EnsureResult{}, errors.New("user_id is required")
	}
	if req.AgentID == "" || utf8.RuneCountInString(req.AgentID) > 64 {
		return EnsureResult{}, ErrInvalidAgentID
	}
	clientID, _, err := sourcePolicy(req.Source, req.ClientID)
	if err != nil {
		return EnsureResult{}, err
	}

	agent, err := s.proxyGateway.Store().GetAgent(ctx, req.AgentID)
	if errors.Is(err, mcpgateway.ErrAgentNotFound) {
		name := strings.TrimSpace(req.DisplayName)
		if req.Source == SourceCollector {
			account, accountErr := s.accountService.Account(ctx, req.UserID)
			if accountErr != nil {
				return EnsureResult{}, accountErr
			}
			name = account.DisplayName() + "的Codex"
		}
		agent = mcpgateway.AgentRegistration{
			AgentID:        req.AgentID,
			ClientID:       clientID,
			Name:           name,
			ActorID:        req.UserID,
			Status:         mcpgateway.StatusActive,
			CreationSource: string(req.Source),
		}
		if agent.Name == "" {
			agent.Name = req.AgentID
		}
		err = s.proxyGateway.CreateOwnedAgent(ctx, req.UserID, agent)
		if err == nil {
			return EnsureResult{Agent: agent, Created: true}, nil
		}
		if !errors.Is(err, mcpgateway.ErrAgentAlreadyExists) {
			return EnsureResult{}, err
		}
		agent, err = s.proxyGateway.Store().GetAgent(ctx, req.AgentID)
	}
	if err != nil {
		return EnsureResult{}, err
	}
	owner, err := s.accountService.AccountForAgent(ctx, req.AgentID)
	if err != nil {
		if errors.Is(err, accounts.ErrAccountAgentNotFound) {
			return EnsureResult{}, ErrAgentIDConflict
		}
		return EnsureResult{}, err
	}
	if owner.UserID != req.UserID {
		return EnsureResult{}, ErrAgentIDConflict
	}
	if req.Source == SourceClaweeLogin && agent.Status != mcpgateway.StatusActive {
		return EnsureResult{}, ErrAgentForbidden
	}
	return EnsureResult{Agent: agent}, nil
}

func sourcePolicy(source Source, requestedClientID string) (string, string, error) {
	switch source {
	case SourceClaweeLogin:
		return accounts.ClientClaweeAgent, "claw-mcp-user", nil
	case SourceCollector:
		return strings.TrimSpace(requestedClientID), "claw-collector", nil
	default:
		return "", "", fmt.Errorf("unsupported agent source %q", source)
	}
}
