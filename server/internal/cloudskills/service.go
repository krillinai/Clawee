package cloudskills

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/settings"
	"github.com/krillinai/Clawee/server/internal/skillhub"
	"github.com/krillinai/Clawee/server/internal/textutil"
)

const (
	Namespace             = "cloud_skills"
	Key                   = "default"
	DefaultAgentEmail     = "skill-agent@example.com"
	DefaultPromptTemplate = "请让 {agent_name} 使用「{skill_name}」技能完成以下任务："
	maxPromptLength       = 1000
)

var (
	ErrInvalidRequest = errors.New("invalid cloud skill request")
	ErrUnavailable    = errors.New("cloud skill service unavailable")
)

type Config struct {
	AgentEmail     string `json:"agent_email"`
	PromptTemplate string `json:"prompt_template"`
}

type StoredConfig struct {
	Config
	Version   int64     `json:"version"`
	UpdatedBy string    `json:"updated_by"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Skill struct {
	SkillID     string    `json:"skill_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Version     string    `json:"version"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type ListResponse struct {
	AgentEmail     string  `json:"agent_email"`
	AgentName      string  `json:"agent_name"`
	PromptTemplate string  `json:"prompt_template"`
	Skills         []Skill `json:"skills"`
}

type AccountReader interface {
	AccountByEmail(context.Context, string) (accounts.Account, error)
}

type SkillReader interface {
	ListPublishedForUser(context.Context, string, string) ([]skillhub.PublishedItem, error)
}

type Service struct {
	store    settings.SettingsStore
	accounts AccountReader
	skills   SkillReader
}

func NewService(store settings.SettingsStore, accountReader AccountReader, skillReader SkillReader) *Service {
	if store == nil {
		store = settings.NewMemoryStore()
	}
	return &Service{store: store, accounts: accountReader, skills: skillReader}
}

func (s *Service) Get(ctx context.Context) (StoredConfig, error) {
	record, err := s.store.Get(ctx, Namespace, Key)
	if err != nil {
		return StoredConfig{}, err
	}
	if len(record.Value) == 0 {
		return StoredConfig{Config: defaultConfig()}, nil
	}
	var cfg Config
	if err := json.Unmarshal(record.Value, &cfg); err != nil {
		return StoredConfig{}, err
	}
	cfg, err = normalizeConfig(cfg)
	if err != nil {
		return StoredConfig{}, err
	}
	return StoredConfig{Config: cfg, Version: record.Version, UpdatedBy: record.UpdatedBy, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}, nil
}

func (s *Service) Update(ctx context.Context, cfg Config, updatedBy string, expectedVersion int64) (StoredConfig, error) {
	cfg, err := normalizeConfig(cfg)
	if err != nil {
		return StoredConfig{}, err
	}
	value, err := json.Marshal(cfg)
	if err != nil {
		return StoredConfig{}, err
	}
	record, err := s.store.Put(ctx, Namespace, Key, value, strings.TrimSpace(updatedBy), expectedVersion, time.Now().UTC())
	if err != nil {
		return StoredConfig{}, err
	}
	return StoredConfig{Config: cfg, Version: record.Version, UpdatedBy: record.UpdatedBy, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}, nil
}

func (s *Service) List(ctx context.Context) (ListResponse, error) {
	if s == nil || s.accounts == nil || s.skills == nil {
		return ListResponse{}, ErrUnavailable
	}
	cfg, err := s.Get(ctx)
	if err != nil {
		return ListResponse{}, err
	}
	account, err := s.accounts.AccountByEmail(ctx, cfg.AgentEmail)
	if err != nil {
		return ListResponse{}, ErrUnavailable
	}
	if account.Status != accounts.StatusActive {
		return ListResponse{}, ErrUnavailable
	}
	items, err := s.skills.ListPublishedForUser(ctx, account.UserID, "")
	if err != nil {
		return ListResponse{}, err
	}
	result := make([]Skill, 0, len(items))
	for _, item := range items {
		result = append(result, Skill{SkillID: item.SkillID, Name: item.Name, Description: item.Description, Version: item.Version, UpdatedAt: item.UpdatedAt})
	}
	return ListResponse{AgentEmail: cfg.AgentEmail, AgentName: account.DisplayName(), PromptTemplate: cfg.PromptTemplate, Skills: result}, nil
}

func defaultConfig() Config {
	return Config{AgentEmail: DefaultAgentEmail, PromptTemplate: DefaultPromptTemplate}
}

func normalizeConfig(cfg Config) (Config, error) {
	cfg.AgentEmail = strings.ToLower(textutil.TrimInput(cfg.AgentEmail))
	cfg.PromptTemplate = textutil.TrimInput(cfg.PromptTemplate)
	if cfg.AgentEmail == "" {
		cfg.AgentEmail = DefaultAgentEmail
	}
	if cfg.PromptTemplate == "" {
		cfg.PromptTemplate = DefaultPromptTemplate
	}
	parsed, err := mail.ParseAddress(cfg.AgentEmail)
	if err != nil || parsed.Address != cfg.AgentEmail || len(cfg.AgentEmail) > 320 {
		return Config{}, fmt.Errorf("%w: agent_email", ErrInvalidRequest)
	}
	if len([]rune(cfg.PromptTemplate)) > maxPromptLength {
		return Config{}, fmt.Errorf("%w: prompt_template", ErrInvalidRequest)
	}
	return cfg, nil
}
