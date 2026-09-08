package unixuser

import (
	"fmt"
	"runtime"
)

func DetectPlatform(goos string) (Platform, error) {
	if goos == "" {
		goos = runtime.GOOS
	}
	switch goos {
	case "darwin", "linux":
		return Platform{OS: goos}, nil
	default:
		return Platform{}, fmt.Errorf("unsupported unix-user platform: %s", goos)
	}
}
