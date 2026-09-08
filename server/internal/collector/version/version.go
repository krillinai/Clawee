package version

var (
	Version   = "0.1.1"
	BuildTime = ""
	Commit    = ""
)

func CollectorVersion() string {
	version := Version
	if BuildTime != "" {
		version += "+" + BuildTime
		if Commit != "" {
			version += ".g" + Commit
		}
	}
	return version
}
