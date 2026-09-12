package sharedfiles

import (
	"context"
	"strings"
)

type StorageTarget struct {
	ProfileID string
	Storage   Storage
}

type StorageRegistry interface {
	Active(context.Context) (StorageTarget, error)
	Resolve(context.Context, string) (StorageTarget, error)
}

type StorageProfileReader interface {
	GetStorageSettings(context.Context) (StorageSettings, error)
	GetStorageProfileConfig(context.Context, string) (StorageProfile, error)
}

type StorageFactory interface {
	NewStorage(context.Context, StorageProfile) (Storage, error)
}

type DatabaseStorageRegistry struct {
	profiles StorageProfileReader
	local    Storage
	factory  StorageFactory
}

func NewStorageRegistry(profiles StorageProfileReader, local Storage, factory StorageFactory) *DatabaseStorageRegistry {
	return &DatabaseStorageRegistry{profiles: profiles, local: local, factory: factory}
}

func (r *DatabaseStorageRegistry) Active(ctx context.Context) (StorageTarget, error) {
	settings, err := r.profiles.GetStorageSettings(ctx)
	if err != nil {
		return StorageTarget{}, ErrStorageUnavailable
	}
	return r.Resolve(ctx, settings.ActiveProfileID)
}

func (r *DatabaseStorageRegistry) Resolve(ctx context.Context, profileID string) (StorageTarget, error) {
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		profileID = LocalDefaultProfileID
	}
	if profileID == LocalDefaultProfileID {
		if r.local == nil {
			return StorageTarget{}, ErrStorageUnavailable
		}
		return StorageTarget{ProfileID: profileID, Storage: r.local}, nil
	}
	profile, err := r.profiles.GetStorageProfileConfig(ctx, profileID)
	if err != nil || profile.Provider != "aliyun_oss" || r.factory == nil {
		return StorageTarget{}, ErrStorageUnavailable
	}
	storage, err := r.factory.NewStorage(ctx, profile)
	if err != nil {
		return StorageTarget{}, ErrStorageUnavailable
	}
	return StorageTarget{ProfileID: profileID, Storage: storage}, nil
}

type staticStorageRegistry struct{ target StorageTarget }

func newStaticStorageRegistry(storage Storage) StorageRegistry {
	return staticStorageRegistry{target: StorageTarget{ProfileID: LocalDefaultProfileID, Storage: storage}}
}

func (r staticStorageRegistry) Active(context.Context) (StorageTarget, error) { return r.target, nil }

func (r staticStorageRegistry) Resolve(_ context.Context, profileID string) (StorageTarget, error) {
	if profileID != "" && profileID != r.target.ProfileID {
		return StorageTarget{}, ErrStorageUnavailable
	}
	return r.target, nil
}
