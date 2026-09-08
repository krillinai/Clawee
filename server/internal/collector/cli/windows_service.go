//go:build windows

package cli

import (
	"context"
	"fmt"
	"io"

	"golang.org/x/sys/windows/svc"
)

func installWindowsService(binaryPath string, configPath string, stdout io.Writer) error {
	binPath := fmt.Sprintf(`"%s" service run --config "%s"`, binaryPath, configPath)
	_ = runCommand("sc.exe", "stop", windowsServiceName)
	_ = runCommand("schtasks", "/Delete", "/TN", windowsServiceName, "/F")
	if err := runCommand("sc.exe", "create", windowsServiceName, "binPath=", binPath, "start=", "auto", "DisplayName=", "Clawee Collector"); err != nil {
		if configErr := runCommand("sc.exe", "config", windowsServiceName, "binPath=", binPath, "start=", "auto", "DisplayName=", "Clawee Collector"); configErr != nil {
			return fmt.Errorf("windows service could not be installed; run PowerShell as administrator or use service install-task fallback: %w", err)
		}
	}
	if err := runCommand("sc.exe", "description", windowsServiceName, "Clawee Collector background service"); err != nil {
		return fmt.Errorf("windows service description could not be configured: %w", err)
	}
	if err := runCommand("sc.exe", "failure", windowsServiceName, "reset=", "86400", "actions=", "restart/60000/restart/60000/restart/60000"); err != nil {
		return fmt.Errorf("windows service failure policy could not be configured: %w", err)
	}
	if err := runCommand("sc.exe", "failureflag", windowsServiceName, "1"); err != nil {
		return fmt.Errorf("windows service failure flag could not be configured: %w", err)
	}
	_, _ = fmt.Fprintf(stdout, "installed windows service: %s\n", windowsServiceName)
	return nil
}

func startWindowsService(stdout io.Writer) error {
	if err := runCommand("sc.exe", "start", windowsServiceName); err != nil {
		return fmt.Errorf("windows service could not be started: %w", err)
	}
	_, _ = fmt.Fprintf(stdout, "started windows service: %s\n", windowsServiceName)
	return nil
}

func stopWindowsService(stdout io.Writer) error {
	if err := runCommand("sc.exe", "stop", windowsServiceName); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "stopped windows service: %s\n", windowsServiceName)
	return nil
}

func runWindowsService(configPath string) error {
	isWindowsService, err := svc.IsWindowsService()
	if err != nil {
		return err
	}
	if !isWindowsService {
		return runCollector([]string{"--config", configPath})
	}
	return svc.Run(windowsServiceName, &collectorWindowsService{configPath: configPath})
}

type collectorWindowsService struct {
	configPath string
}

func (s *collectorWindowsService) Execute(args []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- runCollectorWithContext(ctx, []string{"--config", s.configPath})
	}()

	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				changes <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		case <-done:
			changes <- svc.Status{State: svc.StopPending}
			return false, 1
		}
	}
}
