package store

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestStoreSQLUsesOfficePrefixedTables(t *testing.T) {
	t.Parallel()

	files := []string{
		"postgres.go",
		"management_queries.go",
		"dashboard_queries.go",
	}
	banned := []string{
		"collector_tokens",
		"collector_devices",
		"collector_registration_codes",
		"collector_registrations",
		"agents",
		"agent_sessions",
		"agent_turns",
		"agent_sub_agents",
		"agent_activities",
		"agent_source_events",
		"agent_tool_calls",
	}
	sqlLiteralPattern := regexp.MustCompile("`(?s:.*?)`")

	for _, name := range files {
		path := filepath.Join(".", name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		content := string(data)
		sqlLiterals := sqlLiteralPattern.FindAllString(content, -1)
		joined := strings.Join(sqlLiterals, "\n")
		for _, table := range banned {
			if strings.Contains(joined, " "+table) || strings.Contains(joined, "\n"+table) || strings.Contains(joined, "("+table) {
				t.Fatalf("%s still contains bare table name %q", name, table)
			}
		}
	}
}
