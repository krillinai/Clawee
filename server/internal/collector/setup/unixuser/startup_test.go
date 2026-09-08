package unixuser

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
)

func TestBuildLaunchAgentPlistUsesRunWithConfig(t *testing.T) {
	plist := BuildLaunchAgentPlist("/Users/a/.clawee-collector/bin/clawee-collector", "/Users/a/.clawee-collector/config.json")
	for _, want := range []string{
		"<key>Label</key>",
		"<string>com.clawee.collector</string>",
		"<string>/Users/a/.clawee-collector/bin/clawee-collector</string>",
		"<string>run</string>",
		"<string>--config</string>",
		"<string>/Users/a/.clawee-collector/config.json</string>",
		"<key>KeepAlive</key>",
	} {
		if !strings.Contains(plist, want) {
			t.Fatalf("plist missing %q:\n%s", want, plist)
		}
	}
}

func TestBuildSystemdUserUnitUsesRunWithConfig(t *testing.T) {
	unit := BuildSystemdUserUnit("/home/a/.clawee-collector/bin/clawee-collector", "/home/a/.clawee-collector/config.json")
	for _, want := range []string{
		"[Unit]",
		"Description=Clawee Collector",
		`ExecStart="/home/a/.clawee-collector/bin/clawee-collector" run --config "/home/a/.clawee-collector/config.json"`,
		"Restart=always",
		"[Install]",
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("unit missing %q:\n%s", want, unit)
		}
	}
}

type okWaiter struct{ calls int }

func (w *okWaiter) Wait(addr string) error {
	w.calls++
	return nil
}

type okConnection struct{ calls int }

func (c *okConnection) Check(cfg collectorconfig.Config) error {
	c.calls++
	return nil
}

type healthWaiterFunc func(string) error

func (fn healthWaiterFunc) Wait(addr string) error {
	return fn(addr)
}

type connectionWaiterFunc func(collectorconfig.Config) error

func (fn connectionWaiterFunc) Check(cfg collectorconfig.Config) error {
	return fn(cfg)
}

func TestInstallStartupLinuxWritesUnitStartsAndVerifies(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".clawee-collector", "config.json")
	binaryPath := filepath.Join(home, ".clawee-collector", "bin", "clawee-collector")
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := collectorconfig.Config{
		OfficeURL:         "https://office.example",
		CollectorID:       "collector",
		DeviceID:          "device",
		CollectorToken:    "token",
		ListenAddr:        "127.0.0.1:1905",
		PrivacyMode:       "summary_only",
		EnabledAgentTypes: []string{"codex"},
	}
	if err := collectorconfig.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	runner := &callRunner{}
	health := &okWaiter{}
	connection := &okConnection{}
	unitPath := filepath.Join(home, ".config", "systemd", "user", SystemdUnitName)
	installer := NewInstaller(InstallerDeps{
		Runner:     runner,
		Health:     health,
		Connection: connection,
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				BinaryPath:      binaryPath,
				ConfigPath:      configPath,
				SystemdUnitPath: unitPath,
				LogDir:          filepath.Join(home, ".clawee-collector", "logs"),
				DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
			}, nil
		},
	})

	result, err := installer.InstallStartup(context.Background(), StartupOptions{
		BinaryPath: binaryPath,
		ConfigPath: configPath,
		GOOS:       "linux",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Status.StartupInstalled || !result.Status.Running || !result.Status.HealthOK || !result.Status.HeartbeatOK {
		t.Fatalf("status = %#v", result.Status)
	}
	if health.calls != 1 || connection.calls != 1 {
		t.Fatalf("health=%d connection=%d", health.calls, connection.calls)
	}
	body, err := os.ReadFile(unitPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `ExecStart="`+binaryPath+`" run --config "`+configPath+`"`) {
		t.Fatalf("unit content mismatch:\n%s", string(body))
	}
	joined := strings.Join(runner.calls, "\n")
	for _, want := range []string{
		"systemctl --user daemon-reload",
		"systemctl --user enable clawee-collector.service",
		"systemctl --user restart clawee-collector.service",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in calls:\n%s", want, joined)
		}
	}
}

func TestInstallStartupDarwinUsesBootstrapKickstartAndVerifies(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".clawee-collector", "config.json")
	binaryPath := filepath.Join(home, ".clawee-collector", "bin", "clawee-collector")
	launchAgentPath := filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist")
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := collectorconfig.Config{
		OfficeURL:         "https://office.example",
		CollectorID:       "collector",
		DeviceID:          "device",
		CollectorToken:    "token",
		ListenAddr:        "127.0.0.1:1905",
		PrivacyMode:       "summary_only",
		EnabledAgentTypes: []string{"codex"},
	}
	if err := collectorconfig.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	runner := &callRunner{}
	health := &okWaiter{}
	connection := &okConnection{}
	installer := NewInstaller(InstallerDeps{
		Runner:     runner,
		Health:     health,
		Connection: connection,
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				BinaryPath:      binaryPath,
				ConfigPath:      configPath,
				LaunchAgentPath: launchAgentPath,
				LogDir:          filepath.Join(home, ".clawee-collector", "logs"),
				DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
			}, nil
		},
	})

	result, err := installer.InstallStartup(context.Background(), StartupOptions{
		BinaryPath: binaryPath,
		ConfigPath: configPath,
		GOOS:       "darwin",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Status.StartupInstalled || !result.Status.Running || !result.Status.HealthOK || !result.Status.HeartbeatOK {
		t.Fatalf("status = %#v", result.Status)
	}
	if health.calls != 1 || connection.calls != 1 {
		t.Fatalf("health=%d connection=%d", health.calls, connection.calls)
	}
	body, err := os.ReadFile(launchAgentPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `<string>`+binaryPath+`</string>`) {
		t.Fatalf("plist content mismatch:\n%s", string(body))
	}
	joined := strings.Join(runner.calls, "\n")
	wantBootstrap := "launchctl bootstrap gui/" + strconv.Itoa(os.Getuid()) + " " + launchAgentPath
	wantKickstart := "launchctl kickstart -k gui/" + strconv.Itoa(os.Getuid()) + "/" + LaunchAgentLabel
	for _, want := range []string{
		wantBootstrap,
		wantKickstart,
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in calls:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "launchctl enable") {
		t.Fatalf("unexpected enable call in:\n%s", joined)
	}
}

func TestInstallStartupHealthFailureKeepsStartupInstalledOnly(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".clawee-collector", "config.json")
	binaryPath := filepath.Join(home, ".clawee-collector", "bin", "clawee-collector")
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := collectorconfig.Config{
		OfficeURL:         "https://office.example",
		CollectorID:       "collector",
		DeviceID:          "device",
		CollectorToken:    "token",
		ListenAddr:        "127.0.0.1:1905",
		PrivacyMode:       "summary_only",
		EnabledAgentTypes: []string{"codex"},
	}
	if err := collectorconfig.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	installer := NewInstaller(InstallerDeps{
		Runner: &callRunner{},
		Health: healthWaiterFunc(func(string) error {
			return os.ErrDeadlineExceeded
		}),
		Connection: &okConnection{},
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				BinaryPath:      binaryPath,
				ConfigPath:      configPath,
				LaunchAgentPath: filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist"),
				LogDir:          filepath.Join(home, ".clawee-collector", "logs"),
				DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
			}, nil
		},
	})

	result, err := installer.InstallStartup(context.Background(), StartupOptions{
		BinaryPath: binaryPath,
		ConfigPath: configPath,
		GOOS:       "darwin",
	})
	if err == nil {
		t.Fatal("expected health failure")
	}
	if !result.Status.StartupInstalled {
		t.Fatalf("status = %#v", result.Status)
	}
	if result.Status.Running || result.Status.HealthOK || result.Status.HeartbeatOK {
		t.Fatalf("status = %#v", result.Status)
	}
}

func TestInstallStartupHeartbeatFailureKeepsHealthState(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".clawee-collector", "config.json")
	binaryPath := filepath.Join(home, ".clawee-collector", "bin", "clawee-collector")
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := collectorconfig.Config{
		OfficeURL:         "https://office.example",
		CollectorID:       "collector",
		DeviceID:          "device",
		CollectorToken:    "token",
		ListenAddr:        "127.0.0.1:1905",
		PrivacyMode:       "summary_only",
		EnabledAgentTypes: []string{"codex"},
	}
	if err := collectorconfig.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	installer := NewInstaller(InstallerDeps{
		Runner: &callRunner{},
		Health: &okWaiter{},
		Connection: connectionWaiterFunc(func(collectorconfig.Config) error {
			return os.ErrDeadlineExceeded
		}),
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				BinaryPath:      binaryPath,
				ConfigPath:      configPath,
				LaunchAgentPath: filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist"),
				LogDir:          filepath.Join(home, ".clawee-collector", "logs"),
				DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
			}, nil
		},
	})

	result, err := installer.InstallStartup(context.Background(), StartupOptions{
		BinaryPath: binaryPath,
		ConfigPath: configPath,
		GOOS:       "darwin",
	})
	if err == nil {
		t.Fatal("expected heartbeat failure")
	}
	if !result.Status.StartupInstalled || !result.Status.Running || !result.Status.HealthOK {
		t.Fatalf("status = %#v", result.Status)
	}
	if result.Status.HeartbeatOK {
		t.Fatalf("status = %#v", result.Status)
	}
}
