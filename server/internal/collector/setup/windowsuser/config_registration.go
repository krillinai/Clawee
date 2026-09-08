package windowsuser

import (
	"context"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

type ConfigAction = common.ConfigAction

const (
	ConfigReused     = common.ConfigReused
	ConfigRegistered = common.ConfigRegistered
	ConfigReset      = common.ConfigReset
)

type Registrar = common.Registrar

func NewReportRegistrar(officeURL string) Registrar {
	return common.NewReportRegistrar(officeURL)
}

func EnsureCollectorConfig(ctx context.Context, options Options, paths Paths, registrar Registrar) (collectorconfig.Config, ConfigAction, error) {
	return common.EnsureCollectorConfig(ctx, common.ConfigOptions{
		OfficeURL:             options.OfficeURL,
		RegistrationCode:      options.RegistrationCode,
		Workspace:             options.Workspace,
		ClaweeAgentConfigPath: options.ClaweeAgentConfigPath,
		ResetIdentity:         options.ResetIdentity,
	}, common.ConfigPaths{
		ConfigPath: paths.ConfigPath,
		LogDir:     paths.LogDir,
	}, registrar)
}

func ValidateReusableConfig(cfg collectorconfig.Config) error {
	return common.ValidateReusableConfig(cfg)
}
