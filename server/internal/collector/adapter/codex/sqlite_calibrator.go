package codex

import (
	"database/sql"
	"errors"
	"strings"

	_ "modernc.org/sqlite"
)

type ThreadEdge struct {
	ParentThreadID string
	ChildThreadID  string
	Status         string
}

func LoadThreadEdges(dbPath string) ([]ThreadEdge, error) {
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	exists, err := hasTable(db, "thread_spawn_edges")
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, nil
	}

	rows, err := db.Query("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges")
	if err != nil {
		if isNoSuchTable(err) {
			return nil, nil
		}
		return nil, err
	}
	defer rows.Close()

	var edges []ThreadEdge
	for rows.Next() {
		var edge ThreadEdge
		if err := rows.Scan(&edge.ParentThreadID, &edge.ChildThreadID, &edge.Status); err != nil {
			return nil, err
		}
		if edge.ParentThreadID == "" || edge.ChildThreadID == "" {
			continue
		}
		edges = append(edges, edge)
	}

	return edges, rows.Err()
}

func hasTable(db *sql.DB, tableName string) (bool, error) {
	var name string
	err := db.QueryRow(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		tableName,
	).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		if isNoSuchTable(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func isNoSuchTable(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "no such table")
}
