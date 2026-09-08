//go:build !windows

package cli

import (
	"fmt"
	"io"
	"runtime"
)

func installWindowsService(binaryPath string, configPath string, stdout io.Writer) error {
	return fmt.Errorf("windows service install is not implemented for %s", runtime.GOOS)
}

func startWindowsService(stdout io.Writer) error {
	return fmt.Errorf("windows service start is not implemented for %s", runtime.GOOS)
}

func stopWindowsService(stdout io.Writer) error {
	return fmt.Errorf("windows service stop is not implemented for %s", runtime.GOOS)
}

func runWindowsService(configPath string) error {
	return fmt.Errorf("windows service run is not implemented for %s", runtime.GOOS)
}
