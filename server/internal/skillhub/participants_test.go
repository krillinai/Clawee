package skillhub

import (
	"bytes"
	"context"
	"testing"
	"time"

	pgxmock "github.com/pashagolub/pgxmock/v4"
)

func TestServiceTracksCreatorAndDistinctContributors(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir(), Clock: func() time.Time { return now }})
	data := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("participants")}})
	var skillID string
	for _, upload := range []struct{ version, userID, name string }{
		{"1", "creator", "创建者"},
		{"2", "contributor-1", "参与者一"},
		{"3", "contributor-2", "参与者二"},
		{"4", "contributor-1", "参与者一的新名字"},
		{"5", "creator", "创建者的新名字"},
		{"6", "", "自动同步"},
	} {
		result, err := uploadApprovedVersion(service, ctx, UploadVersionInput{Version: upload.version, Package: bytes.NewReader(data), CreatedBy: upload.name, UploadedByUserID: upload.userID})
		if err != nil {
			t.Fatal(err)
		}
		skillID = result.Skill.SkillID
		now = now.Add(time.Minute)
	}
	detail, err := service.GetPublished(ctx, skillID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Creator == nil || detail.Creator.UserID != "creator" || detail.Creator.Name != "创建者" {
		t.Fatalf("creator = %#v", detail.Creator)
	}
	if len(detail.Contributors) != 2 || detail.Contributors[0].UserID != "contributor-1" || detail.Contributors[0].Name != "参与者一的新名字" || detail.Contributors[1].UserID != "contributor-2" {
		t.Fatalf("contributors = %#v", detail.Contributors)
	}
}

func TestServiceLegacyCreatorIsNotReplacedByLaterUploader(t *testing.T) {
	ctx := context.Background()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir()})
	data := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("legacy-participants")}})
	first, err := uploadApprovedVersion(service, ctx, UploadVersionInput{Version: "1", Package: bytes.NewReader(data), CreatedBy: "历史创建者"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = uploadApprovedVersion(service, ctx, UploadVersionInput{Version: "2", Package: bytes.NewReader(data), CreatedBy: "更新者", UploadedByUserID: "updater"})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := service.GetPublished(ctx, first.Skill.SkillID)
	if err != nil || detail.Creator == nil || detail.Creator.UserID != "" || detail.Creator.Name != "历史创建者" || len(detail.Contributors) != 1 || detail.Contributors[0].Name != "更新者" {
		t.Fatalf("legacy detail = %#v, error = %v", detail, err)
	}
}

func TestPostgresEnrichPublishedUsesCurrentNamesAndLegacyCreator(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	mock.ExpectQuery(`SELECT s.skill_id, s.created_by_user_id`).WithArgs([]string{"skill-1", "legacy"}).WillReturnRows(
		pgxmock.NewRows([]string{"skill_id", "creator_id", "creator_name", "contributor_id", "contributor_name"}).
			AddRow("skill-1", "creator", "当前创建者姓名", "updater", "当前参与者姓名").
			AddRow("skill-1", "creator", "当前创建者姓名", "updater-2", "历史参与者姓名").
			AddRow("legacy", nil, "历史创建者", nil, "企业成员"),
	)
	items, err := store.EnrichPublished(context.Background(), []PublishedItem{{SkillID: "skill-1"}, {SkillID: "legacy"}})
	if err != nil {
		t.Fatal(err)
	}
	if items[0].Creator.Name != "当前创建者姓名" || len(items[0].Contributors) != 2 || items[0].Contributors[0].Name != "当前参与者姓名" || items[0].Creator.AvatarURL == "" {
		t.Fatalf("participants = %#v", items[0])
	}
	if items[1].Creator.Name != "历史创建者" || items[1].Creator.UserID != "" || items[1].Creator.AvatarURL != "" || len(items[1].Contributors) != 0 {
		t.Fatalf("legacy participants = %#v", items[1])
	}
}
