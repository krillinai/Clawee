package skillhub

import (
	"errors"
	"reflect"
	"testing"
)

func TestValidateGitHubSourceRepositoryPartsAndCanonicalURL(t *testing.T) {
	for _, value := range []string{"acme", "skill-repository", "repo.name", "repo_name", "repo-123"} {
		if err := ValidateGitHubRepositoryPart(value); err != nil {
			t.Fatalf("ValidateGitHubRepositoryPart(%q) error = %v", value, err)
		}
	}
	for _, value := range []string{"", ".", "..", "owner/repo", "https://github.com/acme/repo", "repo.git", " leading", "trailing ", "repo?ref=main"} {
		if err := ValidateGitHubRepositoryPart(value); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("ValidateGitHubRepositoryPart(%q) error = %v, want ErrInvalidRequest", value, err)
		}
	}
	if got := CanonicalGitHubURL("acme", "skills"); got != "https://github.com/acme/skills.git" {
		t.Fatalf("CanonicalGitHubURL() = %q", got)
	}
}

func TestValidateGitHubSourceBranchUsesGitRefRules(t *testing.T) {
	for _, value := range []string{"main", "release/2026.08", "feature/source-sync", "refs/heads/main"} {
		if err := ValidateGitBranch(value); err != nil {
			t.Fatalf("ValidateGitBranch(%q) error = %v", value, err)
		}
	}
	for _, value := range []string{"", "-main", "main..next", "main lock", "main\x00next", "main~1", "main/"} {
		if err := ValidateGitBranch(value); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("ValidateGitBranch(%q) error = %v, want ErrInvalidRequest", value, err)
		}
	}
}

func TestValidateGitHubSourceNormalizesRepositoryRelativePaths(t *testing.T) {
	tests := []struct {
		value     string
		allowRoot bool
		want      string
	}{
		{value: "", allowRoot: true, want: "."},
		{value: ".", allowRoot: true, want: "."},
		{value: "./skills/", allowRoot: true, want: "skills"},
		{value: "skills/review/", allowRoot: false, want: "skills/review"},
	}
	for _, tt := range tests {
		got, err := NormalizeRepositoryRelativePath(tt.value, tt.allowRoot)
		if err != nil || got != tt.want {
			t.Fatalf("NormalizeRepositoryRelativePath(%q, %v) = %q, %v; want %q", tt.value, tt.allowRoot, got, err, tt.want)
		}
	}

	for _, value := range []string{"/skills", "../skills", "skills/../other", `skills\review`, "skills//review", "C:/skills"} {
		if _, err := NormalizeRepositoryRelativePath(value, true); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("NormalizeRepositoryRelativePath(%q) error = %v, want ErrInvalidRequest", value, err)
		}
	}
	if _, err := NormalizeRepositoryRelativePath("", false); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("empty exclude path error = %v, want ErrInvalidRequest", err)
	}
}

func TestValidateGitHubSourceNormalizesExcludePathsDeterministically(t *testing.T) {
	got, err := NormalizeExcludePaths([]string{"./vendor/", "skills/generated", "vendor", "skills/generated/"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"skills/generated", "vendor"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("NormalizeExcludePaths() = %#v, want %#v", got, want)
	}
	for _, values := range [][]string{{""}, {"/vendor"}, {"../vendor"}, {`vendor\generated`}, {"vendor//generated"}} {
		if _, err := NormalizeExcludePaths(values); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("NormalizeExcludePaths(%#v) error = %v, want ErrInvalidRequest", values, err)
		}
	}
}
