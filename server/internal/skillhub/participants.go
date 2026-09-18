package skillhub

import (
	"net/url"
	"strings"
)

func newSkillParticipant(skillID, userID, name string) SkillParticipant {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "企业成员"
	}
	participant := SkillParticipant{UserID: userID, Name: name}
	if userID != "" {
		query := url.Values{"skill_id": {skillID}, "user_id": {userID}}
		participant.AvatarURL = "/api/v1/app/skills/participant-avatar?" + query.Encode()
	}
	return participant
}
