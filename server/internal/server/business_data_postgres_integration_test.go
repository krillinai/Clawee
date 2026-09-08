package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

type fullChainFixtureConnector struct{}

func (fullChainFixtureConnector) Provider() string { return businessdata.ProviderXiaohongshu }
func (fullChainFixtureConnector) Pull(_ context.Context, _ businessdata.Source, request businessdata.PullRequest) (businessdata.Batch, error) {
	return businessdata.Batch{
		Contents:            []businessdata.Content{{ExternalContentID: "fixture_note", Title: "Fixture 笔记"}},
		ContentDailyMetrics: []businessdata.ContentDailyMetric{{ExternalContentID: "fixture_note", StatDate: request.EndDate, ExposureCount: 42, LikeCount: 3}},
	}, nil
}

func TestBusinessDataFixtureFullChain(t *testing.T) {
	pool := openBusinessDataHTTPTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC()
	if _, err := pool.Exec(ctx, `INSERT INTO business_data_sources
(source_id,provider,external_account_id,name,status,next_sync_at,created_at,updated_at)
VALUES ('bdsrc_full_chain','xiaohongshu','fixture_account','Fixture','active',$1,$2,$2)`, now.Add(-time.Minute), now); err != nil {
		t.Fatal(err)
	}
	store := businessdata.NewPostgresStore(pool)
	registry := businessdata.NewConnectorRegistry()
	if err := registry.Register(fullChainFixtureConnector{}); err != nil {
		t.Fatal(err)
	}
	syncService := businessdata.NewSyncService(store, registry, nil)
	scheduler := businessdata.NewScheduler(store, syncService, nil)
	if err := scheduler.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(scheduler.Close)
	deadline := time.Now().Add(3 * time.Second)
	for {
		var status string
		err := pool.QueryRow(ctx, `SELECT status FROM business_sync_runs WHERE source_id='bdsrc_full_chain' ORDER BY created_at DESC LIMIT 1`).Scan(&status)
		if err == nil && status == businessdata.SyncRunStatusSuccess {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("fixture sync did not complete: status=%q err=%v", status, err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "full-chain@example.com", Name: "Full Chain", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	accessService := dataaccess.NewService(dataaccess.NewMemoryStore())
	if _, err := accessService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewXiaohongshuOperation, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: accessService, BusinessDashboardService: businessdata.NewDashboardService(store)})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/app/business-dashboards/xiaohongshu-operation?range=7d", nil)
	request.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"data_status":"available"`) || !strings.Contains(recorder.Body.String(), `"exposure_count":42`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func openBusinessDataHTTPTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("CLAW_MCP_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("CLAW_MCP_TEST_DATABASE_URL 未设置，跳过业务数据完整链路测试")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" || !strings.HasSuffix(strings.TrimPrefix(parsed.Path, "/"), "_test") {
		t.Fatal("CLAW_MCP_TEST_DATABASE_URL 必须指向名称以 _test 结尾的数据库")
	}
	base, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := base.Ping(context.Background()); err != nil {
		base.Close()
		t.Fatalf("测试数据库不可用: %v", err)
	}
	schema := fmt.Sprintf("businessdata_http_%d", time.Now().UnixNano())
	if _, err := base.Exec(context.Background(), "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		base.Close()
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		base.Close()
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		base.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = base.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		base.Close()
	})
	raw, err := os.ReadFile("../../db/migrations/00040_business_data_collection.sql")
	if err != nil {
		t.Fatal(err)
	}
	up := strings.SplitN(string(raw), "\n-- +goose Down", 2)[0]
	up = strings.TrimPrefix(up, "-- +goose Up\n")
	if _, err := pool.Exec(context.Background(), up); err != nil {
		t.Fatalf("应用业务数据迁移: %v", err)
	}
	return pool
}
