package migrations

import "embed"

// FS contains the goose SQL migrations compiled into the server binary.
//
//go:embed *.sql
var FS embed.FS
