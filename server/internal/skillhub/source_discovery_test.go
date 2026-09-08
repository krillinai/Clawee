package skillhub

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSkillDiscoveryDiscover(t *testing.T) {
	repository := t.TempDir()
	writeDiscoveryFile(t, repository, "SKILL.md", validSkillMD("root"))
	writeDiscoveryFile(t, repository, "nested/SKILL.md", validSkillMD("nested"))

	discovered, err := (&SkillDiscovery{}).Discover(repository, ".", nil)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if want := []string{"."}; discoveryPaths(discovered) == nil || !reflect.DeepEqual(discoveryPaths(discovered), want) {
		t.Fatalf("Discover() paths = %v, want %v", discoveryPaths(discovered), want)
	}
}

func TestSkillDiscoveryDiscoverRules(t *testing.T) {
	repository := t.TempDir()
	for _, name := range []string{
		"packages/zeta/SKILL.md", "packages/alpha/SKILL.md", "packages/alpha/nested/SKILL.md",
		".agents/skills/foo/SKILL.md", ".git/hidden/SKILL.md", "excluded/SKILL.md", "excluded-child/foo/SKILL.md",
	} {
		writeDiscoveryFile(t, repository, name, validSkillMD("valid"))
	}
	if err := os.Symlink(filepath.Join(repository, "packages", "zeta"), filepath.Join(repository, "linked")); err != nil {
		t.Fatal(err)
	}

	discovered, err := (&SkillDiscovery{}).Discover(repository, ".", []string{"excluded", "excluded-child"})
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	want := []string{".agents/skills/foo", "packages/alpha", "packages/zeta"}
	if got := discoveryPaths(discovered); !reflect.DeepEqual(got, want) {
		t.Fatalf("Discover() paths = %v, want %v", got, want)
	}
	for _, skill := range discovered {
		if !filepath.IsAbs(skill.AbsolutePath) || !strings.HasPrefix(skill.AbsolutePath, repository+string(filepath.Separator)) {
			t.Fatalf("AbsolutePath = %q, want path below %q", skill.AbsolutePath, repository)
		}
	}
}

func TestSkillDiscoveryRejectsUnsafeInitialScanRoot(t *testing.T) {
	t.Run("git metadata", func(t *testing.T) {
		repository := t.TempDir()
		writeDiscoveryFile(t, repository, ".git/SKILL.md", validSkillMD("hidden"))
		if _, err := (&SkillDiscovery{}).Discover(repository, ".git", nil); err == nil {
			t.Fatal("Discover() accepted .git as scan root")
		}
	})
	t.Run("excluded root", func(t *testing.T) {
		repository := t.TempDir()
		writeDiscoveryFile(t, repository, "excluded/SKILL.md", validSkillMD("hidden"))
		if _, err := (&SkillDiscovery{}).Discover(repository, "excluded", []string{"excluded"}); err == nil {
			t.Fatal("Discover() accepted an excluded scan root")
		}
	})
	t.Run("intermediate symlink", func(t *testing.T) {
		repository := t.TempDir()
		outside := t.TempDir()
		writeDiscoveryFile(t, outside, "skill/SKILL.md", validSkillMD("outside"))
		if err := os.Symlink(outside, filepath.Join(repository, "link")); err != nil {
			t.Fatal(err)
		}
		if _, err := (&SkillDiscovery{}).Discover(repository, "link/skill", nil); err == nil {
			t.Fatal("Discover() followed an intermediate symlink outside the repository")
		}
	})
}

func TestOpenRepositoryRootRejectsParentSymlinkSwap(t *testing.T) {
	repository := t.TempDir()
	outside := t.TempDir()
	pivot := filepath.Join(repository, "pivot")
	parked := filepath.Join(repository, "parked")
	if err := os.MkdirAll(filepath.Join(pivot, "skill"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeDiscoveryFile(t, outside, "skill/SKILL.md", validSkillMD("outside"))
	root, err := openRepositoryRoot(repository)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := os.Rename(pivot, parked); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, pivot); err != nil {
		t.Fatal(err)
	}

	file, err := root.Open(filepath.Join("pivot", "skill", "SKILL.md"))
	if err == nil {
		_ = file.Close()
		t.Fatal("repository root followed a parent symbolic link outside the repository")
	}
}

func TestSkillDiscoveryDiscoverRejectsLimitsAndErrors(t *testing.T) {
	t.Run("missing scan root", func(t *testing.T) {
		_, err := (&SkillDiscovery{}).Discover(t.TempDir(), "missing", nil)
		if err == nil {
			t.Fatal("Discover() accepted missing scan root")
		}
	})
	t.Run("depth thirteen", func(t *testing.T) {
		repository := t.TempDir()
		parts := make([]string, 13)
		for i := range parts {
			parts[i] = "level"
		}
		writeDiscoveryFile(t, repository, filepath.Join(filepath.Join(parts...), "SKILL.md"), validSkillMD("deep"))
		_, err := (&SkillDiscovery{}).Discover(repository, ".", nil)
		if err == nil {
			t.Fatal("Discover() accepted a skill at depth 13")
		}
	})
	t.Run("one thousand one skills", func(t *testing.T) {
		repository := t.TempDir()
		for i := 0; i < 1001; i++ {
			writeDiscoveryFile(t, repository, filepath.Join("skills", testNumber(i), "SKILL.md"), validSkillMD("many"))
		}
		_, err := (&SkillDiscovery{}).Discover(repository, ".", nil)
		if err == nil {
			t.Fatal("Discover() accepted 1001 skills")
		}
	})
	t.Run("unreadable directory", func(t *testing.T) {
		repository := t.TempDir()
		blocked := filepath.Join(repository, "blocked")
		if err := os.Mkdir(blocked, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(blocked, 0); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(blocked, 0o700) })
		if _, err := os.ReadDir(blocked); err == nil {
			t.Skip("current user can read a mode-000 directory")
		}
		if _, err := (&SkillDiscovery{}).Discover(repository, ".", nil); err == nil {
			t.Fatal("Discover() accepted a directory traversal failure")
		}
	})
}

func writeDiscoveryFile(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func discoveryPaths(skills []DiscoveredSkill) []string {
	paths := make([]string, len(skills))
	for i, skill := range skills {
		paths[i] = skill.Path
	}
	return paths
}
