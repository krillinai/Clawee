package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

func TestSharedFileStorageRoutesUseIndependentPermissions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore()})
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	users := map[string]accounts.Account{}
	grants := map[string]string{
		"reader":   rbac.PermissionSharedFilesStorageRead,
		"manager":  rbac.PermissionSharedFilesStorageManage,
		"migrator": rbac.PermissionSharedFilesStorageMigrate,
	}
	for name, permission := range grants {
		registered, err := accountService.Register(ctx, accounts.RegisterRequest{
			Email: name + "@example.com", Name: name, Password: "passw0rd!",
		})
		if err != nil {
			t.Fatal(err)
		}
		users[name] = registered.Account
		role, err := rbacService.CreateRole(ctx, "admin", rbac.CreateRoleInput{
			Code: "storage_" + name, Name: name, Permissions: []string{permission},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := rbacService.AssignAccountRole(ctx, "admin", registered.Account.UserID, role.RoleID); err != nil {
			t.Fatal(err)
		}
	}
	store := &storageHTTPTestStore{}
	local, err := sharedfiles.NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	registry := storageHTTPTestRegistry{storage: local}
	configService := sharedfiles.NewStorageConfigurationService(store, registry, storageHTTPTestFactory{storage: local}, nil, nil, nil)
	migrationService := sharedfiles.NewStorageMigrationService(store, registry, nil)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		if account, ok := users[c.GetHeader("X-Test-User")]; ok {
			c.Set(accountContextKey, account)
		}
		c.Next()
	})
	mountSharedFileStorageRoutes(router.Group("/api/v1/admin"), Options{
		RBACService: rbacService, SharedFileStorageService: configService, SharedFileMigrationService: migrationService,
	})

	request := func(method, path, user, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Test-User", user)
		router.ServeHTTP(recorder, req)
		return recorder
	}
	if got := request(http.MethodGet, "/api/v1/admin/shared-file-storage", "", "").Code; got != http.StatusUnauthorized {
		t.Fatalf("anonymous state status = %d", got)
	}
	if got := request(http.MethodGet, "/api/v1/admin/shared-file-storage", "reader", "").Code; got != http.StatusOK {
		t.Fatalf("reader state status = %d", got)
	}
	if recorder := request(http.MethodPost, "/api/v1/admin/shared-file-storage/oss/test", "reader", "{}"); recorder.Code != http.StatusForbidden ||
		!strings.Contains(recorder.Body.String(), `"code":"storage_operation_forbidden"`) {
		t.Fatalf("reader test status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := request(http.MethodPost, "/api/v1/admin/shared-file-storage/oss/test", "manager", "{}").Code; got == http.StatusForbidden {
		t.Fatalf("manager test unexpectedly forbidden")
	}
	if recorder := request(http.MethodPost, "/api/v1/admin/shared-file-storage/migrations", "manager", "{}"); recorder.Code != http.StatusForbidden ||
		!strings.Contains(recorder.Body.String(), `"code":"storage_operation_forbidden"`) {
		t.Fatalf("manager migration status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := request(http.MethodPost, "/api/v1/admin/shared-file-storage/migrations", "migrator", "{}").Code; got == http.StatusForbidden {
		t.Fatalf("migrator unexpectedly forbidden")
	}
}

func TestStorageProbeDeleteFailureUsesActionableMessage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	writeSharedFileError(context, sharedfiles.ErrStorageProbeDeleteFailed)
	if recorder.Code != http.StatusBadGateway || !strings.Contains(recorder.Body.String(), `"code":"storage_probe_failed"`) ||
		!strings.Contains(recorder.Body.String(), "测试对象删除失败，请检查删除权限") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

type storageHTTPTestStore struct{}

func (*storageHTTPTestStore) GetStorageSettings(context.Context) (sharedfiles.StorageSettings, error) {
	return sharedfiles.StorageSettings{ActiveProfileID: sharedfiles.LocalDefaultProfileID, Revision: 1}, nil
}
func (*storageHTTPTestStore) GetStorageProfile(context.Context, string) (sharedfiles.StorageProfile, error) {
	return sharedfiles.StorageProfile{ProfileID: sharedfiles.LocalDefaultProfileID, Provider: "local", Status: "enabled"}, nil
}
func (*storageHTTPTestStore) ListStorageProfiles(context.Context) ([]sharedfiles.StorageProfile, error) {
	return []sharedfiles.StorageProfile{{ProfileID: sharedfiles.LocalDefaultProfileID, Name: "服务器本地存储", Provider: "local", Status: "enabled", Health: "available"}}, nil
}
func (*storageHTTPTestStore) CreateStorageProfile(context.Context, sharedfiles.StorageProfile) error {
	return nil
}
func (*storageHTTPTestStore) UpdateStorageProfile(context.Context, sharedfiles.StorageProfile) error {
	return nil
}
func (*storageHTTPTestStore) RecordStorageProbe(context.Context, string, string, time.Time) error {
	return nil
}
func (*storageHTTPTestStore) ActivateStorageProfile(context.Context, string, string, int64, time.Time) (sharedfiles.StorageSettings, error) {
	return sharedfiles.StorageSettings{}, nil
}
func (*storageHTTPTestStore) RetireStorageProfile(context.Context, string, string, time.Time) error {
	return nil
}
func (*storageHTTPTestStore) RecordStorageAudit(context.Context, sharedfiles.StorageAudit) error {
	return nil
}
func (*storageHTTPTestStore) CreateStorageMigration(context.Context, string, string, string, time.Time) (sharedfiles.StorageMigration, error) {
	return sharedfiles.StorageMigration{}, sharedfiles.ErrInvalidStorageConfiguration
}
func (*storageHTTPTestStore) GetStorageMigration(context.Context, string) (sharedfiles.StorageMigration, error) {
	return sharedfiles.StorageMigration{}, sharedfiles.ErrStorageProfileNotFound
}
func (*storageHTTPTestStore) CancelStorageMigration(context.Context, string, time.Time) error {
	return sharedfiles.ErrInvalidRequest
}
func (*storageHTTPTestStore) RetryFailedStorageMigration(context.Context, string) error {
	return sharedfiles.ErrInvalidRequest
}
func (*storageHTTPTestStore) ClaimStorageMigrationItem(context.Context, time.Time) (sharedfiles.StorageMigrationItem, string, bool, error) {
	return sharedfiles.StorageMigrationItem{}, "", false, nil
}
func (*storageHTTPTestStore) HeartbeatStorageMigrationItem(context.Context, sharedfiles.StorageMigrationItem, time.Time) error {
	return nil
}
func (*storageHTTPTestStore) CompleteStorageMigrationItem(context.Context, sharedfiles.StorageMigrationItem, string, time.Time) (bool, error) {
	return false, nil
}
func (*storageHTTPTestStore) FailStorageMigrationItem(context.Context, sharedfiles.StorageMigrationItem, string, bool, time.Time) error {
	return nil
}
func (*storageHTTPTestStore) EnqueueCleanup(context.Context, sharedfiles.ObjectRef, string, string, string, time.Time) error {
	return nil
}
func (*storageHTTPTestStore) ClaimCleanupTask(context.Context, time.Time) (sharedfiles.CleanupTask, bool, error) {
	return sharedfiles.CleanupTask{}, false, nil
}
func (*storageHTTPTestStore) FinishCleanupTask(context.Context, sharedfiles.CleanupTask, bool, string, time.Time) error {
	return nil
}

type storageHTTPTestRegistry struct{ storage sharedfiles.Storage }

func (r storageHTTPTestRegistry) Active(context.Context) (sharedfiles.StorageTarget, error) {
	return sharedfiles.StorageTarget{ProfileID: sharedfiles.LocalDefaultProfileID, Storage: r.storage}, nil
}
func (r storageHTTPTestRegistry) Resolve(context.Context, string) (sharedfiles.StorageTarget, error) {
	return sharedfiles.StorageTarget{ProfileID: sharedfiles.LocalDefaultProfileID, Storage: r.storage}, nil
}

type storageHTTPTestFactory struct{ storage sharedfiles.Storage }

func (f storageHTTPTestFactory) NewStorage(context.Context, sharedfiles.StorageProfile) (sharedfiles.Storage, error) {
	return f.storage, nil
}
