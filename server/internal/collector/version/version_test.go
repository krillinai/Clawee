package version

import "testing"

func TestCollectorVersion(t *testing.T) {
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
			buildTime: "20260706T153015BJT",
			want:      "0.1.1+20260706T153015BJT",
		},
		{
			name:      "version with Beijing build time and commit",
			version:   "0.1.1",
			buildTime: "20260706T153015BJT",
			commit:    "abc1234",
			want:      "0.1.1+20260706T153015BJT.gabc1234",
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

			if got := CollectorVersion(); got != tt.want {
				t.Fatalf("CollectorVersion() = %q, want %q", got, tt.want)
			}
		})
	}
}
