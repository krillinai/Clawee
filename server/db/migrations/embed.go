package migrations

import "embed"

// FS contains the goose SQL migrations compiled into the claw-mcp binary.
//
//go:embed *.sql
var FS embed.FS
