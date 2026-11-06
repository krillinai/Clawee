package server

import (
	"context"
	"errors"
	"sort"
	"sync/atomic"
	"time"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

var (
	errModelGroupUnavailable = errors.New("model group is unavailable")
	errModelNotAvailable     = errors.New("model is not available in model group")
)

var modelRouteSequence uint64

type modelGroupConfigReader interface {
	GetModelGroup(context.Context, string) (mcpgateway.ModelGroupConfig, error)
}

type modelRouteTarget struct {
	GroupID           string
	UpstreamAccountID string
	Name              string
	BaseURL           string
	APIKey            string
}

func loadModelGroupConfig(ctx context.Context, opts Options, userID string) (mcpgateway.ModelGroupConfig, error) {
	if opts.ModelGroupStore == nil || opts.ModelUpstreamStore == nil {
		return mcpgateway.ModelGroupConfig{}, errModelGroupUnavailable
	}
	group, err := opts.ModelGroupStore.GetUserModelGroup(ctx, userID)
	if errors.Is(err, mcpgateway.ErrModelGroupNotFound) {
		group, err = opts.ModelGroupStore.EnsureUserModelGroup(ctx, userID, time.Now().UTC())
	}
	if err != nil {
		return mcpgateway.ModelGroupConfig{}, err
	}
	reader, ok := opts.ModelUpstreamStore.(modelGroupConfigReader)
	if !ok {
		return mcpgateway.ModelGroupConfig{}, errModelGroupUnavailable
	}
	config, err := reader.GetModelGroup(ctx, group.ID)
	if err != nil {
		return mcpgateway.ModelGroupConfig{}, err
	}
	if config.Status != mcpgateway.ModelGroupStatusActive {
		return mcpgateway.ModelGroupConfig{}, errModelGroupUnavailable
	}
	return config, nil
}

func modelGroupModels(config mcpgateway.ModelGroupConfig) []string {
	models := make([][]string, 0, len(config.Accounts))
	for _, account := range config.Accounts {
		if account.Status == mcpgateway.ModelGroupStatusActive {
			models = append(models, account.Models)
		}
	}
	return mcpgateway.MergeModelNames(models...)
}

func selectModelName(config mcpgateway.ModelGroupConfig, requested string) (string, error) {
	if requested != "" {
		for _, model := range modelGroupModels(config) {
			if model == requested {
				return requested, nil
			}
		}
		return "", errModelNotAvailable
	}
	if config.DefaultModel != "" {
		for _, model := range modelGroupModels(config) {
			if model == config.DefaultModel {
				return config.DefaultModel, nil
			}
		}
	}
	models := modelGroupModels(config)
	if len(models) == 0 {
		return "", errModelNotAvailable
	}
	return models[0], nil
}

func modelRouteAccounts(config mcpgateway.ModelGroupConfig, model string) []mcpgateway.ModelGroupAccount {
	accounts := make([]mcpgateway.ModelGroupAccount, 0, len(config.Accounts))
	for _, account := range config.Accounts {
		if account.Status != mcpgateway.ModelGroupStatusActive || !containsModel(account.Models, model) {
			continue
		}
		accounts = append(accounts, account)
	}
	sort.SliceStable(accounts, func(i, j int) bool {
		if accounts[i].Priority == accounts[j].Priority {
			return accounts[i].UpstreamAccountID < accounts[j].UpstreamAccountID
		}
		return accounts[i].Priority < accounts[j].Priority
	})
	if config.RouteStrategy == mcpgateway.ModelGroupRouteRoundRobin && len(accounts) > 1 {
		offset := int(atomic.AddUint64(&modelRouteSequence, 1) % uint64(len(accounts)))
		accounts = append(accounts[offset:], accounts[:offset]...)
	}
	return accounts
}

func containsModel(models []string, target string) bool {
	for _, model := range models {
		if model == target {
			return true
		}
	}
	return false
}

func resolveModelRouteTargets(ctx context.Context, opts Options, userID, requestedModel string) (mcpgateway.ModelGroupConfig, string, []modelRouteTarget, error) {
	config, err := loadModelGroupConfig(ctx, opts, userID)
	if err != nil {
		return mcpgateway.ModelGroupConfig{}, "", nil, err
	}
	model, err := selectModelName(config, requestedModel)
	if err != nil {
		return mcpgateway.ModelGroupConfig{}, "", nil, err
	}
	accounts := modelRouteAccounts(config, model)
	if len(accounts) == 0 {
		return mcpgateway.ModelGroupConfig{}, "", nil, errModelNotAvailable
	}
	if opts.ModelCredentialCipher == nil {
		return mcpgateway.ModelGroupConfig{}, "", nil, errModelGroupUnavailable
	}
	targets := make([]modelRouteTarget, 0, len(accounts))
	for _, member := range accounts {
		upstream, err := opts.ModelUpstreamStore.GetModelUpstreamAccount(ctx, member.UpstreamAccountID)
		if err != nil {
			continue
		}
		apiKey, err := opts.ModelCredentialCipher.Decrypt(upstream.APIKeyCiphertext)
		if err != nil || len(apiKey) == 0 {
			continue
		}
		targets = append(targets, modelRouteTarget{
			GroupID:           config.ID,
			UpstreamAccountID: member.UpstreamAccountID,
			Name:              member.Name,
			BaseURL:           member.BaseURL,
			APIKey:            string(apiKey),
		})
	}
	if len(targets) == 0 {
		return mcpgateway.ModelGroupConfig{}, "", nil, errModelGroupUnavailable
	}
	return config, model, targets, nil
}
