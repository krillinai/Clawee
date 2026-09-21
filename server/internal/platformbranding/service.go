package platformbranding

import (
	"bytes"
	"context"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/krillinai/Clawee/server/internal/textutil"
)

type Service struct {
	store Store
	clock func() time.Time
}

func NewService(store Store) *Service {
	if store == nil {
		store = NewMemoryStore()
	}
	return &Service{store: store, clock: time.Now}
}

func (s *Service) Get(ctx context.Context) (Configuration, error) {
	return s.store.Get(ctx)
}

func (s *Service) Update(ctx context.Context, input UpdateInput) (Configuration, error) {
	if !validAction(input.SidebarLogoAction) || !validAction(input.SidebarCompactLogoAction) {
		return Configuration{}, ErrInvalidAction
	}
	if err := validateActionImage(input.SidebarLogoAction, input.SidebarLogo); err != nil {
		return Configuration{}, err
	}
	if err := validateActionImage(input.SidebarCompactLogoAction, input.SidebarCompactLogo); err != nil {
		return Configuration{}, err
	}
	input.UpdatedAt = s.clock().UTC()
	labels := make(map[string]*string, len(input.SidebarMenuLabels))
	for key, value := range input.SidebarMenuLabels {
		switch key {
		case "skills", "knowledge", "drive", "dashboard":
		default:
			return Configuration{}, fmt.Errorf("%w: 不支持的菜单字段 %s", ErrInvalidMenuLabel, key)
		}
		if value == nil {
			labels[key] = nil
			continue
		}
		normalized := textutil.TrimInput(*value)
		for _, character := range normalized {
			if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) || character == '\u2028' || character == '\u2029' {
				return Configuration{}, fmt.Errorf("%w: %s 名称不能包含换行或控制字符", ErrInvalidMenuLabel, key)
			}
		}
		if !utf8.ValidString(normalized) || utf8.RuneCountInString(normalized) < 1 || utf8.RuneCountInString(normalized) > 10 {
			return Configuration{}, fmt.Errorf("%w: %s 名称必须为 1～10 个字符", ErrInvalidMenuLabel, key)
		}
		labels[key] = &normalized
	}
	input.SidebarMenuLabels = labels
	return s.store.Update(ctx, input)
}

func validAction(action Action) bool {
	return action == ActionKeep || action == ActionReplace || action == ActionReset
}

func validateActionImage(action Action, content []byte) error {
	if action != ActionReplace {
		if len(content) != 0 {
			return ErrInvalidAction
		}
		return nil
	}
	if len(content) == 0 {
		return ErrInvalidImage
	}
	if len(content) > MaxImageSize {
		return ErrImageTooLarge
	}
	configuration, format, err := image.DecodeConfig(bytes.NewReader(content))
	if err != nil || (format != "png" && format != "jpeg") {
		return ErrInvalidImage
	}
	if configuration.Width > MaxDimension || configuration.Height > MaxDimension {
		return ErrInvalidImage
	}
	if _, decodedFormat, err := image.Decode(bytes.NewReader(content)); err != nil || decodedFormat != format {
		return ErrInvalidImage
	}
	return nil
}

func detectContentType(content []byte) string {
	_, format, err := image.DecodeConfig(bytes.NewReader(content))
	if err == nil && format == "png" {
		return "image/png"
	}
	return "image/jpeg"
}
