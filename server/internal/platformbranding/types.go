package platformbranding

import (
	"errors"
	"time"
)

const (
	DefaultID    = "default"
	MaxImageSize = 1024 * 1024
	MaxDimension = 4096
)

type Action string

const (
	ActionKeep    Action = "keep"
	ActionReplace Action = "replace"
	ActionReset   Action = "reset"
)

var (
	ErrInvalidAction = errors.New("invalid platform branding action")
	ErrInvalidImage  = errors.New("invalid platform branding image")
	ErrImageTooLarge = errors.New("platform branding image is too large")
	ErrImageNotFound = errors.New("platform branding image not found")
)

type Image struct {
	Content     []byte
	ContentType string
}

type Configuration struct {
	SidebarLogo        *Image
	SidebarCompactLogo *Image
	UpdatedBy          string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type UpdateInput struct {
	SidebarLogoAction        Action
	SidebarLogo              []byte
	SidebarCompactLogoAction Action
	SidebarCompactLogo       []byte
	UpdatedBy                string
	UpdatedAt                time.Time
}
