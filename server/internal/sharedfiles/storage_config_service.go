package sharedfiles

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.uber.org/zap"
)

type StorageConfigurationStore interface {
	GetStorageSettings(context.Context) (StorageSettings, error)
	GetStorageProfile(context.Context, string) (StorageProfile, error)
	ListStorageProfiles(context.Context) ([]StorageProfile, error)
	CreateStorageProfile(context.Context, StorageProfile) error
	UpdateStorageProfile(context.Context, StorageProfile) error
	RecordStorageProbe(context.Context, string, string, time.Time) error
	ActivateStorageProfile(context.Context, string, string, int64, time.Time) (StorageSettings, error)
	RetireStorageProfile(context.Context, string, string, time.Time) error
	RecordStorageAudit(context.Context, StorageAudit) error
}

type StorageConfigurationService struct {
	store        StorageConfigurationStore
	registry     StorageRegistry
	factory      StorageFactory
	cipher       credentialCipher
	allowedHosts []string
	logger       *zap.Logger
	clock        func() time.Time
}

func NewStorageConfigurationService(store StorageConfigurationStore, registry StorageRegistry, factory StorageFactory, cipher credentialCipher, allowedHosts []string, logger *zap.Logger) *StorageConfigurationService {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &StorageConfigurationService{store: store, registry: registry, factory: factory, cipher: cipher,
		allowedHosts: append([]string(nil), allowedHosts...), logger: logger, clock: func() time.Time { return time.Now().UTC() }}
}

func (s *StorageConfigurationService) State(ctx context.Context) (StorageState, error) {
	settings, err := s.store.GetStorageSettings(ctx)
	if err != nil {
		return StorageState{}, err
	}
	profiles, err := s.store.ListStorageProfiles(ctx)
	if err != nil {
		return StorageState{}, err
	}
	return StorageState{ActiveProfileID: settings.ActiveProfileID, Revision: settings.Revision, Profiles: profiles}, nil
}

func (s *StorageConfigurationService) TestOSS(ctx context.Context, input OSSProfileInput, operator, requestID string) (time.Time, error) {
	now := s.clock()
	profile, err := s.profileFromInput(input, StorageProfile{}, true)
	if err == nil {
		var storage Storage
		storage, err = s.factory.NewStorage(ctx, profile)
		if err == nil {
			err = storage.Probe(ctx)
		}
	}
	s.audit(context.WithoutCancel(ctx), operator, requestID, "oss_test", "transient", resultForError(err), storageProbeAuditDetails(err), now)
	if err != nil {
		if errors.Is(err, ErrInvalidStorageConfiguration) {
			return time.Time{}, err
		}
		return time.Time{}, storageProbeError(err)
	}
	return now, nil
}

func (s *StorageConfigurationService) CreateOSSProfile(ctx context.Context, input OSSProfileInput, operator, requestID string) (StorageProfile, error) {
	now := s.clock()
	profile, err := s.profileFromInput(input, StorageProfile{}, true)
	if err == nil {
		profile.ProfileID = newID("storage_profile_")
		profile.Status = "enabled"
		profile.LastProbeStatus = "success"
		profile.LastProbeAt = &now
		profile.CreatedBy, profile.UpdatedBy = operator, operator
		profile.CreatedAt, profile.UpdatedAt = now, now
		var storage Storage
		storage, err = s.factory.NewStorage(ctx, profile)
		if err == nil {
			err = storage.Probe(ctx)
		}
	}
	objectID := profile.ProfileID
	if objectID == "" {
		objectID = "new_profile"
	}
	if err != nil {
		s.audit(context.WithoutCancel(ctx), operator, requestID, "profile_create", objectID, "failure", storageProbeAuditDetails(err), now)
		if errors.Is(err, ErrInvalidStorageConfiguration) {
			return StorageProfile{}, err
		}
		return StorageProfile{}, storageProbeError(err)
	}
	if err = s.store.CreateStorageProfile(ctx, profile); err != nil {
		s.audit(context.WithoutCancel(ctx), operator, requestID, "profile_create", profile.ProfileID, "failure", nil, now)
		return StorageProfile{}, err
	}
	s.audit(context.WithoutCancel(ctx), operator, requestID, "profile_create", profile.ProfileID, "success", nil, now)
	setStorageProfileDerivedFields(&profile)
	return profile, nil
}

func (s *StorageConfigurationService) UpdateOSSProfile(ctx context.Context, profileID string, input OSSProfileInput, operator, requestID string) (StorageProfile, error) {
	now := s.clock()
	credentialRotation := strings.TrimSpace(input.CredentialMode) == "access_key" && strings.TrimSpace(input.CredentialAction) == "replace"
	current, err := s.store.GetStorageProfile(ctx, profileID)
	auditResult := func(result string) {
		details := storageProbeAuditDetails(err)
		s.audit(context.WithoutCancel(ctx), operator, requestID, "profile_update", profileID, result, details, now)
		if credentialRotation {
			credentialDetails := map[string]any{"credential_mode": "access_key"}
			if details["stage"] != nil {
				credentialDetails["stage"] = details["stage"]
			}
			s.audit(context.WithoutCancel(ctx), operator, requestID, "credential_rotate", profileID, result, credentialDetails, now)
		}
	}
	var profile StorageProfile
	if err == nil {
		profile, err = s.profileFromInput(input, current, false)
	}
	if err == nil && current.FileCount > 0 &&
		(current.Endpoint != profile.Endpoint || current.Region != profile.Region || current.Bucket != profile.Bucket || current.ObjectPrefix != profile.ObjectPrefix) {
		err = ErrStorageProfileInUse
	}
	if err == nil {
		profile.ProfileID = profileID
		profile.Provider = "aliyun_oss"
		profile.Status = current.Status
		profile.LastProbeStatus = "success"
		profile.LastProbeAt = &now
		profile.CreatedBy, profile.CreatedAt = current.CreatedBy, current.CreatedAt
		profile.UpdatedBy, profile.UpdatedAt = operator, now
		var storage Storage
		storage, err = s.factory.NewStorage(ctx, profile)
		if err == nil {
			err = storage.Probe(ctx)
		}
	}
	if err != nil {
		auditResult("failure")
		if errors.Is(err, ErrStorageProfileInUse) || errors.Is(err, ErrStorageProfileNotFound) || errors.Is(err, ErrInvalidStorageConfiguration) {
			return StorageProfile{}, err
		}
		return StorageProfile{}, storageProbeError(err)
	}
	if err = s.store.UpdateStorageProfile(ctx, profile); err != nil {
		auditResult("failure")
		return StorageProfile{}, err
	}
	auditResult("success")
	setStorageProfileDerivedFields(&profile)
	return profile, nil
}

func setStorageProfileDerivedFields(profile *StorageProfile) {
	profile.CredentialsConfigured = profile.CredentialMode == "ecs_ram_role" ||
		(len(profile.AccessKeyIDCiphertext) > 0 && len(profile.AccessKeySecretCiphertext) > 0)
	profile.Health = storageHealth(profile.LastProbeStatus)
}

func (s *StorageConfigurationService) ProbeProfile(ctx context.Context, profileID, operator, requestID string) (time.Time, error) {
	now := s.clock()
	target, err := s.registry.Resolve(ctx, profileID)
	if err == nil {
		err = target.Storage.Probe(ctx)
	}
	status := "success"
	if err != nil {
		status = "failed"
	}
	_ = s.store.RecordStorageProbe(context.WithoutCancel(ctx), profileID, status, now)
	s.audit(context.WithoutCancel(ctx), operator, requestID, "profile_probe", profileID, resultForError(err), storageProbeAuditDetails(err), now)
	if err != nil {
		return time.Time{}, storageProbeError(err)
	}
	return now, nil
}

func (s *StorageConfigurationService) Activate(ctx context.Context, profileID string, expectedRevision int64, operator, requestID string) (StorageSettings, error) {
	now := s.clock()
	current, err := s.store.GetStorageSettings(ctx)
	if err == nil {
		_, err = s.ProbeProfile(ctx, profileID, operator, requestID)
	}
	var settings StorageSettings
	if err == nil {
		settings, err = s.store.ActivateStorageProfile(ctx, profileID, operator, expectedRevision, now)
	}
	s.audit(context.WithoutCancel(ctx), operator, requestID, "profile_activate", profileID, resultForError(err),
		map[string]any{"before_profile_id": current.ActiveProfileID, "after_profile_id": profileID}, now)
	return settings, err
}

func (s *StorageConfigurationService) Retire(ctx context.Context, profileID, operator, requestID string) error {
	now := s.clock()
	err := s.store.RetireStorageProfile(ctx, profileID, operator, now)
	s.audit(context.WithoutCancel(ctx), operator, requestID, "profile_retire", profileID, resultForError(err), nil, now)
	return err
}

func (s *StorageConfigurationService) profileFromInput(input OSSProfileInput, current StorageProfile, create bool) (StorageProfile, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Endpoint = strings.TrimSpace(input.Endpoint)
	input.Region = strings.TrimSpace(input.Region)
	input.Bucket = strings.TrimSpace(input.Bucket)
	input.ObjectPrefix = normalizeObjectPrefix(input.ObjectPrefix)
	if input.ObjectPrefix == "" {
		input.ObjectPrefix = "clawee/shared-files"
	}
	input.CredentialMode = strings.TrimSpace(input.CredentialMode)
	if input.Name == "" || len([]byte(input.Name)) > 100 || len(input.Endpoint) > 512 || len(input.Region) > 64 ||
		len(input.Bucket) > 63 || len(input.AccessKeyID) > 256 || len(input.AccessKeySecret) > 512 || s.cipher == nil {
		return StorageProfile{}, ErrInvalidStorageConfiguration
	}
	profile := StorageProfile{Name: input.Name, Provider: "aliyun_oss", Endpoint: input.Endpoint, Region: input.Region,
		Bucket: input.Bucket, ObjectPrefix: input.ObjectPrefix, CredentialMode: input.CredentialMode}
	action := strings.TrimSpace(input.CredentialAction)
	if create && action == "" {
		action = "replace"
	}
	switch input.CredentialMode {
	case "ecs_ram_role":
		if action != "" && action != "keep" && action != "replace" {
			return StorageProfile{}, ErrInvalidStorageConfiguration
		}
	case "access_key":
		switch action {
		case "keep":
			if create || current.CredentialMode != "access_key" || len(current.AccessKeyIDCiphertext) == 0 || len(current.AccessKeySecretCiphertext) == 0 {
				return StorageProfile{}, ErrInvalidStorageConfiguration
			}
			profile.AccessKeyIDCiphertext = current.AccessKeyIDCiphertext
			profile.AccessKeySecretCiphertext = current.AccessKeySecretCiphertext
			profile.AccessKeyIDHint = current.AccessKeyIDHint
		case "replace":
			accessKeyID, accessKeySecret := strings.TrimSpace(input.AccessKeyID), strings.TrimSpace(input.AccessKeySecret)
			if accessKeyID == "" || accessKeySecret == "" {
				return StorageProfile{}, ErrInvalidStorageConfiguration
			}
			var err error
			profile.AccessKeyIDCiphertext, err = s.cipher.Encrypt([]byte(accessKeyID))
			if err != nil {
				return StorageProfile{}, ErrStorageUnavailable
			}
			profile.AccessKeySecretCiphertext, err = s.cipher.Encrypt([]byte(accessKeySecret))
			if err != nil {
				return StorageProfile{}, ErrStorageUnavailable
			}
			if len(accessKeyID) > 4 {
				profile.AccessKeyIDHint = accessKeyID[len(accessKeyID)-4:]
			}
		default:
			return StorageProfile{}, ErrInvalidStorageConfiguration
		}
	default:
		return StorageProfile{}, ErrInvalidStorageConfiguration
	}
	if err := ValidateOSSProfile(profile, s.allowedHosts); err != nil {
		return StorageProfile{}, err
	}
	return profile, nil
}

func (s *StorageConfigurationService) audit(ctx context.Context, operator, requestID, action, objectID, result string, details map[string]any, now time.Time) {
	if details == nil {
		details = map[string]any{}
	}
	err := s.store.RecordStorageAudit(ctx, StorageAudit{AuditID: newID("storage_audit_"), RequestID: requestID,
		OperatorUserID: operator, Action: action, ObjectID: objectID, Result: result, Details: details, CreatedAt: now})
	if err != nil {
		s.logger.Error("记录共享文件存储审计失败", zap.String("action", action), zap.String("request_id", requestID))
	}
}

func resultForError(err error) string {
	if err != nil {
		return "failure"
	}
	return "success"
}

func storageProbeError(err error) error {
	if errors.Is(err, ErrStorageProbeDeleteFailed) {
		return ErrStorageProbeDeleteFailed
	}
	return ErrStorageProbeFailed
}

func storageProbeAuditDetails(err error) map[string]any {
	if errors.Is(err, ErrStorageProbeDeleteFailed) {
		return map[string]any{"stage": "delete"}
	}
	return nil
}
