package sharedfiles

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestStorageConfigurationEncryptsCredentialsAndOmitsThemFromJSON(t *testing.T) {
	store := newStorageConfigurationTestStore()
	service := newStorageConfigurationTestService(store)
	profile, err := service.CreateOSSProfile(context.Background(), validOSSProfileInput(), "admin", "request-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(profile.AccessKeyIDCiphertext) == "access-key-id" || string(profile.AccessKeySecretCiphertext) == "access-key-secret" {
		t.Fatal("凭据未加密")
	}
	body, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"access-key-id", "access-key-secret", string(profile.AccessKeyIDCiphertext), string(profile.AccessKeySecretCiphertext)} {
		if forbidden != "" && strings.Contains(string(body), forbidden) {
			t.Fatalf("响应包含凭据材料: %q", forbidden)
		}
	}
}

func TestStorageConfigurationKeepsAndReplacesCredentials(t *testing.T) {
	store := newStorageConfigurationTestStore()
	service := newStorageConfigurationTestService(store)
	created, err := service.CreateOSSProfile(context.Background(), validOSSProfileInput(), "admin", "request-1")
	if err != nil {
		t.Fatal(err)
	}
	keep := validOSSProfileInput()
	keep.CredentialAction = "keep"
	keep.AccessKeyID, keep.AccessKeySecret = "", ""
	kept, err := service.UpdateOSSProfile(context.Background(), created.ProfileID, keep, "admin", "request-2")
	if err != nil {
		t.Fatal(err)
	}
	if string(kept.AccessKeyIDCiphertext) != string(created.AccessKeyIDCiphertext) || string(kept.AccessKeySecretCiphertext) != string(created.AccessKeySecretCiphertext) {
		t.Fatal("keep 修改了已保存凭据")
	}
	replace := validOSSProfileInput()
	replace.CredentialAction = "replace"
	replace.AccessKeyID, replace.AccessKeySecret = "replacement-id", "replacement-secret"
	replaced, err := service.UpdateOSSProfile(context.Background(), created.ProfileID, replace, "admin", "request-3")
	if err != nil {
		t.Fatal(err)
	}
	if string(replaced.AccessKeyIDCiphertext) == string(kept.AccessKeyIDCiphertext) || replaced.AccessKeyIDHint != "t-id" {
		t.Fatal("replace 未轮换凭据")
	}
}

func TestStorageConfigurationAuditsCredentialRotationWithoutCredentials(t *testing.T) {
	store := newStorageConfigurationTestStore()
	service := newStorageConfigurationTestService(store)
	created, err := service.CreateOSSProfile(context.Background(), validOSSProfileInput(), "admin", "request-1")
	if err != nil {
		t.Fatal(err)
	}
	start := len(store.audits)
	replace := validOSSProfileInput()
	replace.AccessKeyID, replace.AccessKeySecret = "replacement-id", "replacement-secret"
	if _, err := service.UpdateOSSProfile(context.Background(), created.ProfileID, replace, "admin", "request-2"); err != nil {
		t.Fatal(err)
	}
	invalid := replace
	invalid.AccessKeySecret = ""
	if _, err := service.UpdateOSSProfile(context.Background(), created.ProfileID, invalid, "admin", "request-3"); !errors.Is(err, ErrInvalidStorageConfiguration) {
		t.Fatalf("invalid rotation error = %v", err)
	}
	audits := store.audits[start:]
	rotationResults := []string{}
	for _, audit := range audits {
		if audit.Action == "credential_rotate" {
			rotationResults = append(rotationResults, audit.Result)
		}
	}
	if strings.Join(rotationResults, ",") != "success,failure" {
		t.Fatalf("credential rotation audit results = %#v", rotationResults)
	}
	body, err := json.Marshal(audits)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"replacement-id", "replacement-secret"} {
		if strings.Contains(string(body), secret) {
			t.Fatalf("credential audit contains secret %q", secret)
		}
	}
}

func TestStorageConfigurationDoesNotExposeShortAccessKeyIDAsHint(t *testing.T) {
	store := newStorageConfigurationTestStore()
	service := newStorageConfigurationTestService(store)
	input := validOSSProfileInput()
	input.AccessKeyID = "key"
	profile, err := service.CreateOSSProfile(context.Background(), input, "admin", "request-1")
	if err != nil {
		t.Fatal(err)
	}
	if profile.AccessKeyIDHint != "" {
		t.Fatalf("short access key hint = %q", profile.AccessKeyIDHint)
	}
}

func TestStorageConfigurationLocksReferencedLocationAndPropagatesRevisionConflict(t *testing.T) {
	store := newStorageConfigurationTestStore()
	service := newStorageConfigurationTestService(store)
	created, err := service.CreateOSSProfile(context.Background(), validOSSProfileInput(), "admin", "request-1")
	if err != nil {
		t.Fatal(err)
	}
	created.FileCount = 1
	store.profiles[created.ProfileID] = created
	service.registry.(*switchingStorageRegistry).targets[created.ProfileID] = newMemoryStorage()
	changed := validOSSProfileInput()
	changed.Endpoint = "https://oss-cn-shanghai.aliyuncs.com"
	changed.Region = "cn-shanghai"
	changed.CredentialAction = "keep"
	changed.AccessKeyID, changed.AccessKeySecret = "", ""
	if _, err := service.UpdateOSSProfile(context.Background(), created.ProfileID, changed, "admin", "request-2"); !errors.Is(err, ErrStorageProfileInUse) {
		t.Fatalf("修改已引用定位字段错误 = %v", err)
	}
	store.activateErr = ErrStorageConfigurationConflict
	if _, err := service.Activate(context.Background(), created.ProfileID, 7, "admin", "request-3"); !errors.Is(err, ErrStorageConfigurationConflict) {
		t.Fatalf("激活 revision 冲突错误 = %v", err)
	}
}

func TestStorageConfigurationPreservesProbeDeleteFailureAndAuditsStage(t *testing.T) {
	for _, operation := range []string{"test", "create", "update", "probe"} {
		t.Run(operation, func(t *testing.T) {
			store := newStorageConfigurationTestStore()
			probeStorage := &probeErrorStorage{Storage: newMemoryStorage(), err: ErrStorageProbeDeleteFailed}
			registry := &switchingStorageRegistry{targets: map[string]Storage{"profile-1": probeStorage}}
			factory := storageConfigurationTestFactory{storage: probeStorage}
			service := NewStorageConfigurationService(store, registry, factory, storageConfigurationTestCipher{}, nil, nil)
			input := validOSSProfileInput()
			var err error
			switch operation {
			case "test":
				_, err = service.TestOSS(context.Background(), input, "admin", "request-1")
			case "create":
				_, err = service.CreateOSSProfile(context.Background(), input, "admin", "request-1")
			case "update":
				store.profiles["profile-1"] = StorageProfile{ProfileID: "profile-1", Name: "OSS", Provider: "aliyun_oss",
					Endpoint: input.Endpoint, Region: input.Region, Bucket: input.Bucket, ObjectPrefix: input.ObjectPrefix,
					CredentialMode: "access_key", AccessKeyIDCiphertext: []byte("id"), AccessKeySecretCiphertext: []byte("secret"), Status: "enabled"}
				_, err = service.UpdateOSSProfile(context.Background(), "profile-1", input, "admin", "request-1")
			case "probe":
				_, err = service.ProbeProfile(context.Background(), "profile-1", "admin", "request-1")
			}
			if !errors.Is(err, ErrStorageProbeDeleteFailed) {
				t.Fatalf("error = %v", err)
			}
			if len(store.audits) == 0 || store.audits[0].Details["stage"] != "delete" {
				t.Fatalf("audits = %#v", store.audits)
			}
		})
	}
}

type probeErrorStorage struct {
	Storage
	err error
}

func (s *probeErrorStorage) Probe(context.Context) error { return s.err }

type storageConfigurationTestCipher struct{}

func (storageConfigurationTestCipher) Encrypt(value []byte) ([]byte, error) {
	return append([]byte("encrypted:"), value...), nil
}

func (storageConfigurationTestCipher) Decrypt(value []byte) ([]byte, error) {
	return append([]byte(nil), value...), nil
}

type storageConfigurationTestFactory struct{ storage Storage }

func (f storageConfigurationTestFactory) NewStorage(context.Context, StorageProfile) (Storage, error) {
	return f.storage, nil
}

type storageConfigurationTestStore struct {
	profiles    map[string]StorageProfile
	settings    StorageSettings
	activateErr error
	audits      []StorageAudit
}

func newStorageConfigurationTestStore() *storageConfigurationTestStore {
	return &storageConfigurationTestStore{profiles: map[string]StorageProfile{}, settings: StorageSettings{ActiveProfileID: LocalDefaultProfileID, Revision: 1}}
}

func (s *storageConfigurationTestStore) GetStorageSettings(context.Context) (StorageSettings, error) {
	return s.settings, nil
}
func (s *storageConfigurationTestStore) GetStorageProfile(_ context.Context, profileID string) (StorageProfile, error) {
	profile, ok := s.profiles[profileID]
	if !ok {
		return StorageProfile{}, ErrStorageProfileNotFound
	}
	return profile, nil
}
func (s *storageConfigurationTestStore) ListStorageProfiles(context.Context) ([]StorageProfile, error) {
	profiles := make([]StorageProfile, 0, len(s.profiles))
	for _, profile := range s.profiles {
		profiles = append(profiles, profile)
	}
	return profiles, nil
}
func (s *storageConfigurationTestStore) CreateStorageProfile(_ context.Context, profile StorageProfile) error {
	s.profiles[profile.ProfileID] = profile
	return nil
}
func (s *storageConfigurationTestStore) UpdateStorageProfile(_ context.Context, profile StorageProfile) error {
	s.profiles[profile.ProfileID] = profile
	return nil
}
func (s *storageConfigurationTestStore) RecordStorageProbe(context.Context, string, string, time.Time) error {
	return nil
}
func (s *storageConfigurationTestStore) ActivateStorageProfile(_ context.Context, profileID, _ string, revision int64, _ time.Time) (StorageSettings, error) {
	if s.activateErr != nil {
		return StorageSettings{}, s.activateErr
	}
	s.settings.ActiveProfileID = profileID
	s.settings.Revision = revision + 1
	return s.settings, nil
}
func (s *storageConfigurationTestStore) RetireStorageProfile(context.Context, string, string, time.Time) error {
	return nil
}
func (s *storageConfigurationTestStore) RecordStorageAudit(_ context.Context, audit StorageAudit) error {
	s.audits = append(s.audits, audit)
	return nil
}

func newStorageConfigurationTestService(store *storageConfigurationTestStore) *StorageConfigurationService {
	storage := newMemoryStorage()
	registry := &switchingStorageRegistry{active: LocalDefaultProfileID, targets: map[string]Storage{LocalDefaultProfileID: storage}}
	return NewStorageConfigurationService(store, registry, storageConfigurationTestFactory{storage: storage}, storageConfigurationTestCipher{}, nil, nil)
}

func validOSSProfileInput() OSSProfileInput {
	return OSSProfileInput{Name: "OSS", Endpoint: "https://oss-cn-hangzhou.aliyuncs.com", Region: "cn-hangzhou",
		Bucket: "clawee-test", ObjectPrefix: "shared-files", CredentialMode: "access_key", CredentialAction: "replace",
		AccessKeyID: "access-key-id", AccessKeySecret: "access-key-secret"}
}
