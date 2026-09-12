package businessdata

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"
)

type bilibiliCredentialFixture struct{}

func (bilibiliCredentialFixture) AccessToken(context.Context, string) (string, error) {
	return "access", nil
}

func TestBilibiliConnectorEmptySinglePageAndBatchLimit(t *testing.T) {
	tests := []struct {
		name      string
		archives  []BilibiliArchive
		stats     map[string]BilibiliArchiveStat
		wantCount int
		wantErr   error
	}{
		{name: "empty", archives: []BilibiliArchive{}, stats: map[string]BilibiliArchiveStat{}, wantCount: 1},
		{name: "single page", archives: []BilibiliArchive{{ResourceID: "BV1", Title: "稿件"}}, stats: map[string]BilibiliArchiveStat{"BV1": {View: 1}}, wantCount: 3},
	}
	overflow := make([]BilibiliArchive, maxBatchRecords)
	for index := range overflow {
		overflow[index].ResourceID = "BV" + strconv.Itoa(index)
	}
	tests = append(tests, struct {
		name      string
		archives  []BilibiliArchive
		stats     map[string]BilibiliArchiveStat
		wantCount int
		wantErr   error
	}{name: "batch limit", archives: overflow, stats: map[string]BilibiliArchiveStat{}, wantErr: ErrInvalidBatch})

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := &bilibiliClientFixture{
				account:  BilibiliAccountInfo{OpenID: "open", Name: "账号"},
				archives: map[int][]BilibiliArchive{1: test.archives}, stats: test.stats,
			}
			connector := NewBilibiliConnector(bilibiliCredentialFixture{}, client)
			connector.clock = func() time.Time { return time.Date(2026, 8, 28, 2, 0, 0, 0, time.UTC) }
			batch, err := connector.Pull(context.Background(), Source{SourceID: "bdsrc", ExternalAccountID: "open"}, PullRequest{})
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("error=%v, want=%v", err, test.wantErr)
			}
			if err == nil && batch.RecordCount() != int64(test.wantCount) {
				t.Fatalf("record count=%d, want=%d", batch.RecordCount(), test.wantCount)
			}
		})
	}
}

func TestBilibiliConnectorOrdinaryArchiveErrorRejectsWholeBatch(t *testing.T) {
	client := &bilibiliClientFixture{
		account:  BilibiliAccountInfo{OpenID: "open", Name: "账号"},
		archives: map[int][]BilibiliArchive{1: {{ResourceID: "BV1"}, {ResourceID: "BV2"}}},
		stats:    map[string]BilibiliArchiveStat{"BV1": {View: 1}},
		statErr:  map[string]error{"BV2": errors.New("upstream failed")},
	}
	connector := NewBilibiliConnector(bilibiliCredentialFixture{}, client)
	if batch, err := connector.Pull(context.Background(), Source{SourceID: "bdsrc", ExternalAccountID: "open"}, PullRequest{}); err == nil || batch.RecordCount() != 0 {
		t.Fatalf("batch=%#v err=%v", batch, err)
	}
}

func TestBilibiliConnectorPaginationAndMissingArchive(t *testing.T) {
	firstPage := make([]BilibiliArchive, bilibiliArchivePageSize)
	stats := make(map[string]BilibiliArchiveStat, bilibiliArchivePageSize)
	for index := range firstPage {
		id := "BV" + string(rune('A'+index))
		firstPage[index] = BilibiliArchive{ResourceID: id, Title: "稿件", State: 1, PTime: 1_700_000_000}
		stats[id] = BilibiliArchiveStat{View: int64(index + 1), Like: 1}
	}
	client := &bilibiliClientFixture{
		account: BilibiliAccountInfo{OpenID: "open", Name: "账号"}, archives: map[int][]BilibiliArchive{1: firstPage, 2: {{ResourceID: "BV-LAST", Title: "最后", State: 2}}},
		stats: stats, missing: "BV-LAST",
	}
	connector := NewBilibiliConnector(bilibiliCredentialFixture{}, client)
	now := time.Date(2026, 8, 28, 18, 0, 0, 0, time.UTC)
	connector.clock = func() time.Time { return now }
	batch, err := connector.Pull(context.Background(), Source{SourceID: "bdsrc_1", ExternalAccountID: "open"}, PullRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Contents) != bilibiliArchivePageSize+1 || len(batch.BilibiliContentSnapshots) != bilibiliArchivePageSize || len(batch.BilibiliAccountSnapshots) != 1 {
		t.Fatalf("batch counts: contents=%d snapshots=%d account=%d", len(batch.Contents), len(batch.BilibiliContentSnapshots), len(batch.BilibiliAccountSnapshots))
	}
	if batch.BilibiliAccountSnapshots[0].SnapshotDate.Format("2006-01-02") != "2026-08-29" || len(batch.ContentDailyMetrics) != 0 || len(batch.AccountDailyMetrics) != 0 {
		t.Fatalf("unexpected snapshot mapping: %#v", batch)
	}
	if publishedAt := batch.Contents[0].PublishedAt; publishedAt == nil || publishedAt.Unix() != 1_700_000_000 {
		t.Fatalf("publishedAt=%v", publishedAt)
	}
}
