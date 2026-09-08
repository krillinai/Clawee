package skillhub

import (
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

var githubRepositoryPartPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$`)

func ValidateGitHubRepositoryPart(value string) error {
	if value == "." || value == ".." || strings.HasSuffix(strings.ToLower(value), ".git") || !githubRepositoryPartPattern.MatchString(value) {
		return ErrInvalidRequest
	}
	return nil
}

func ValidateGitBranch(value string) error {
	if value == "" || strings.HasPrefix(value, "-") || strings.ContainsFunc(value, unicode.IsControl) {
		return ErrInvalidRequest
	}
	if err := exec.Command("git", "check-ref-format", "--branch", value).Run(); err != nil {
		return ErrInvalidRequest
	}
	return nil
}

func NormalizeRepositoryRelativePath(value string, allowRoot bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "." || value == "./" {
		if allowRoot {
			return ".", nil
		}
		return "", ErrInvalidRequest
	}
	if strings.Contains(value, `\`) || path.IsAbs(value) || hasWindowsDrivePrefix(value) {
		return "", ErrInvalidRequest
	}
	trimmed := strings.TrimSuffix(strings.TrimPrefix(value, "./"), "/")
	if trimmed == "" {
		if allowRoot {
			return ".", nil
		}
		return "", ErrInvalidRequest
	}
	for _, part := range strings.Split(trimmed, "/") {
		if part == "" || part == ".." {
			return "", ErrInvalidRequest
		}
	}
	normalized := path.Clean(trimmed)
	if normalized == "." {
		if allowRoot {
			return ".", nil
		}
		return "", ErrInvalidRequest
	}
	return normalized, nil
}

func NormalizeExcludePaths(values []string) ([]string, error) {
	unique := make(map[string]struct{}, len(values))
	for _, value := range values {
		normalized, err := NormalizeRepositoryRelativePath(value, false)
		if err != nil {
			return nil, err
		}
		unique[normalized] = struct{}{}
	}
	result := make([]string, 0, len(unique))
	for value := range unique {
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func CanonicalGitHubURL(owner, repository string) string {
	return "https://github.com/" + owner + "/" + repository + ".git"
}

func hasWindowsDrivePrefix(value string) bool {
	return len(value) >= 2 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':'
}
