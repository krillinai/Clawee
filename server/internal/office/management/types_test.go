package management

import (
	"encoding/json"
	"testing"
	"time"
)

func TestCollectorsOverviewJSON(t *testing.T) {
	serverTime := time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC)
	createdAt := time.Date(2026, 6, 3, 10, 24, 0, 0, time.UTC)
	lastUsedAt := time.Date(2026, 6, 3, 10, 42, 0, 0, time.UTC)
	expiresAt := time.Date(2026, 6, 10, 10, 24, 0, 0, time.UTC)
	lastSeenAt := time.Date(2026, 6, 3, 11, 59, 30, 0, time.UTC)

	overview := CollectorsOverview{
		SchemaVersion:          SchemaVersion,
		ServerTime:             serverTime,
		OnlineThresholdSeconds: 60,
		RegistrationCode: RegistrationCodeSummary{
			Exists:     true,
			Code:       "reg_abc",
			CreatedBy:  "local-admin",
			CreatedAt:  &createdAt,
			ExpiresAt:  &expiresAt,
			UsedCount:  3,
			LastUsedAt: &lastUsedAt,
			Revoked:    false,
		},
		Summary: CollectorSummary{
			TotalCollectors:     1,
			OnlineCollectors:    1,
			OfflineCollectors:   0,
			NeverSeenCollectors: 0,
		},
		Collectors: []CollectorItem{{
			CollectorID:          "collector_1",
			DeviceID:             "device_1",
			DeviceName:           "工程负责人 MacBook",
			Hostname:             "mbp-xugang.local",
			OS:                   "darwin",
			Arch:                 "arm64",
			CollectorVersion:     "0.1.0",
			RegisteredAgentCount: 2,
			RegisteredAt:         &createdAt,
			TokenCreatedAt:       createdAt,
			TokenLastUsedAt:      &lastUsedAt,
			LastSeenAt:           &lastSeenAt,
			Status:               CollectorStatusOnline,
		}},
	}

	body, err := json.Marshal(overview)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got["schema_version"] != SchemaVersion {
		t.Fatalf("schema_version = %#v", got["schema_version"])
	}
	if got["online_threshold_seconds"].(float64) != 60 {
		t.Fatalf("online_threshold_seconds = %#v", got["online_threshold_seconds"])
	}
}

func TestCreateRegistrationCodeRequestJSON(t *testing.T) {
	var req CreateRegistrationCodeRequest
	if err := json.Unmarshal([]byte(`{"user_id":"usr_1"}`), &req); err != nil {
		t.Fatal(err)
	}
	if req.UserID != "usr_1" {
		t.Fatalf("UserID = %q", req.UserID)
	}
}
