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
	ErrInvalidAction    = errors.New("invalid platform branding action")
	ErrInvalidImage     = errors.New("invalid platform branding image")
	ErrImageTooLarge    = errors.New("platform branding image is too large")
	ErrImageNotFound    = errors.New("platform branding image not found")
	ErrInvalidMenuLabel = errors.New("invalid sidebar menu label")
	ErrInvalidAdminURL  = errors.New("invalid admin URL")
)

type Image struct {
	Content     []byte
	ContentType string
}

type Configuration struct {
	SidebarLogo        *Image
	SidebarCompactLogo *Image
	SidebarMenuLabels  MenuLabels
	AdminURL           string
	UpdatedBy          string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type UpdateInput struct {
	SidebarLogoAction        Action
	SidebarLogo              []byte
	SidebarCompactLogoAction Action
	SidebarCompactLogo       []byte
	SidebarMenuLabels        map[string]*string
	AdminURL                 *string
	UpdatedBy                string
	UpdatedAt                time.Time
}

type MenuLabels struct {
	Skills    string `json:"skills,omitempty"`
	Knowledge string `json:"knowledge,omitempty"`
	Drive     string `json:"drive,omitempty"`
	Dashboard string `json:"dashboard,omitempty"`
}
