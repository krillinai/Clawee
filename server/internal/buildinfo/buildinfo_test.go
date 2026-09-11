package buildinfo

import "testing"

func TestFullVersion(t *testing.T) {
	tests := []struct {
		name      string
		version   string
		buildTime string
		commit    string
		want      string
	}{
		{
			name:    "base version",
			version: "0.1.1",
			want:    "0.1.1",
		},
		{
			name:      "version with Beijing build time",
			version:   "0.1.1",
			buildTime: "20260707T153015BJT",
			want:      "0.1.1+20260707T153015BJT",
		},
		{
			name:      "version with Beijing build time and commit",
			version:   "0.1.1",
			buildTime: "20260707T153015BJT",
			commit:    "abc1234",
			want:      "0.1.1+20260707T153015BJT.gabc1234",
		},
	}

	oldVersion := Version
	oldBuildTime := BuildTime
	oldCommit := Commit
	t.Cleanup(func() {
		Version = oldVersion
		BuildTime = oldBuildTime
		Commit = oldCommit
	})

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			Version = tt.version
			BuildTime = tt.buildTime
			Commit = tt.commit

			if got := FullVersion(); got != tt.want {
				t.Fatalf("FullVersion() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestInfo(t *testing.T) {
	oldVersion := Version
	oldBuildTime := BuildTime
	oldCommit := Commit
	t.Cleanup(func() {
		Version = oldVersion
		BuildTime = oldBuildTime
		Commit = oldCommit
	})

	Version = "0.1.1"
	BuildTime = "20260707T153015BJT"
	Commit = "abc1234"

	got := Info()
	if got.Name != "clawee-gateway" {
		t.Fatalf("Name = %q, want clawee-gateway", got.Name)
	}
	if got.Version != "0.1.1" {
		t.Fatalf("Version = %q, want 0.1.1", got.Version)
	}
	if got.BuildTime != "20260707T153015BJT" {
		t.Fatalf("BuildTime = %q", got.BuildTime)
	}
	if got.Commit != "abc1234" {
		t.Fatalf("Commit = %q", got.Commit)
	}
	if got.FullVersion != "0.1.1+20260707T153015BJT.gabc1234" {
		t.Fatalf("FullVersion = %q", got.FullVersion)
	}
}
