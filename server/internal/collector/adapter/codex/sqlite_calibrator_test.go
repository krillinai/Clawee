package codex

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestLoadThreadEdgesReturnsEdgesFromSQLite(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "codex.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open failed: %v", err)
	}
	defer db.Close()

	_, err = db.Exec(`
		CREATE TABLE thread_spawn_edges (
			parent_thread_id TEXT,
			child_thread_id TEXT,
			status TEXT
		)
	`)
	if err != nil {
		t.Fatalf("CREATE TABLE failed: %v", err)
	}

	_, err = db.Exec(
		"INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)",
		"parent_1",
		"child_1",
		"open",
	)
	if err != nil {
		t.Fatalf("INSERT failed: %v", err)
	}

	edges, err := LoadThreadEdges(dbPath)
	if err != nil {
		t.Fatalf("LoadThreadEdges returned error: %v", err)
	}

	if len(edges) != 1 {
		t.Fatalf("LoadThreadEdges returned %d edges, want 1", len(edges))
	}
	if edges[0].ParentThreadID != "parent_1" {
		t.Fatalf("ParentThreadID = %q, want %q", edges[0].ParentThreadID, "parent_1")
	}
	if edges[0].ChildThreadID != "child_1" {
		t.Fatalf("ChildThreadID = %q, want %q", edges[0].ChildThreadID, "child_1")
	}
	if edges[0].Status != "open" {
		t.Fatalf("Status = %q, want %q", edges[0].Status, "open")
	}
}

func TestLoadThreadEdgesReturnsEmptyWhenTableMissing(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "codex.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open failed: %v", err)
	}
	if _, err := db.Exec("PRAGMA user_version = 1"); err != nil {
		t.Fatalf("PRAGMA failed: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("db.Close failed: %v", err)
	}

	edges, err := LoadThreadEdges(dbPath)
	if err != nil {
		t.Fatalf("LoadThreadEdges returned error: %v", err)
	}
	if len(edges) != 0 {
		t.Fatalf("LoadThreadEdges returned %d edges, want 0", len(edges))
	}
}
