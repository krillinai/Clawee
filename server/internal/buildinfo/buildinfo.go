package buildinfo

var (
	Version   = "0.1.1"
	BuildTime = ""
	Commit    = ""
)

type InfoResponse struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	BuildTime   string `json:"build_time"`
	Commit      string `json:"commit"`
	FullVersion string `json:"full_version"`
}

func FullVersion() string {
	version := Version
	if BuildTime != "" {
		version += "+" + BuildTime
		if Commit != "" {
			version += ".g" + Commit
		}
	}
	return version
}

func Info() InfoResponse {
	return InfoResponse{
		Name:        "clawee-gateway",
		Version:     Version,
		BuildTime:   BuildTime,
		Commit:      Commit,
		FullVersion: FullVersion(),
	}
}
