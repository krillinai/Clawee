package mcpgateway

import "time"

func DecideGrant(now time.Time, grants []AccountGrant, userID, capabilityID, grantType string) GrantDecision {
	var sawExpired bool
	for _, grant := range grants {
		if grant.UserID != userID {
			continue
		}
		if grant.CapabilityID != capabilityID {
			continue
		}
		if grant.GrantType != grantType {
			continue
		}
		if grant.ExpiresAt != nil && !grant.ExpiresAt.After(now) {
			sawExpired = true
			continue
		}
		matched := grant
		return GrantDecision{Allowed: true, Reason: DecisionAllowed, Grant: &matched}
	}
	if sawExpired {
		return GrantDecision{Allowed: false, Reason: DecisionGrantExpired}
	}
	return GrantDecision{Allowed: false, Reason: DecisionNoMatchingGrant}
}
