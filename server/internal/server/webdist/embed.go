package webdist

import "embed"

// Files contains the Vite production build output when assets are embedded.
//
//go:embed dist
var Files embed.FS
