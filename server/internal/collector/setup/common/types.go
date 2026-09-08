package common

import (
	"context"
	"time"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type ConfigOptions struct {
	OfficeURL             string
	RegistrationCode      string
	Workspace             string
	ClaweeAgentConfigPath string
	ResetIdentity         bool
}

type ConfigPaths struct {
	ConfigPath string
	LogDir     string
}

type ConfigAction string

const (
	ConfigReused     ConfigAction = "reused"
	ConfigRegistered ConfigAction = "registered"
	ConfigReset      ConfigAction = "reset"
)

type Registrar interface {
	RegisterCollector(collectorapi.RegistrationRequest) (collectorapi.RegistrationResponse, error)
}

type ConfigEnsurer interface {
	Ensure(context.Context, ConfigOptions, ConfigPaths) (collectorconfig.Config, ConfigAction, error)
}

type Clock func() time.Time
