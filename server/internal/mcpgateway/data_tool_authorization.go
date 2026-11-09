package mcpgateway

import (
	"context"
	"time"

	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

func IsSkillContributionsTool(server UpstreamServer, capability Capability) bool {
	return server.ID == "skill-contributions" && server.Transport == TransportBuiltin &&
		capability.UpstreamServerID == server.ID && capability.Type == CapabilityTool &&
		(capability.UpstreamName == "skill_contributions_query" || capability.UpstreamName == "skill_contributions_export")
}

func (s *Service) toolAuthorization(ctx context.Context, now time.Time, user string, server UpstreamServer, capability Capability, grants []AccountGrant) (GrantDecision, error) {
	if !IsSkillContributionsTool(server, capability) {
		return decideToolGrant(now, grants, user, capability), nil
	}
	decision := GrantDecision{Reason: DecisionNoMatchingGrant}
	if s.dataAccessService == nil {
		return decision, nil
	}
	allowed, err := s.dataAccessService.HasAction(ctx, user, dataaccess.ResourceDataView, dataaccess.ViewSkillContributions, dataaccess.ActionRead)
	if err != nil {
		return decision, err
	}
	if allowed {
		decision.Allowed, decision.Reason = true, DecisionAllowed
	}
	return decision, nil
}
