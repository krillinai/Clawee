package platformbranding

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestServiceAccentColorValidationAndReset(t *testing.T) {
	service := NewService(nil)
	ctx := context.Background()
	current, err := service.Get(ctx)
	if err != nil || current.AccentColor != "" {
		t.Fatalf("未配置时不应改变默认颜色: %#v, %v", current, err)
	}
	value := " #F2E9EA "
	input := UpdateInput{SidebarLogoAction: ActionKeep, SidebarCompactLogoAction: ActionKeep, AccentColor: &value}
	current, err = service.Update(ctx, input)
	if err != nil || current.AccentColor != "#f2e9ea" {
		t.Fatalf("颜色写入失败: %#v, %v", current, err)
	}
	input.AccentColor = nil
	current, err = service.Update(ctx, input)
	if err != nil || current.AccentColor != "#f2e9ea" {
		t.Fatalf("省略字段不应覆盖配置: %#v, %v", current, err)
	}
	for _, invalid := range []string{"#abc", "red", "#12345g", "#12345678", "#123456\nred"} {
		input.AccentColor = &invalid
		if _, err := service.Update(ctx, input); !errors.Is(err, ErrInvalidAccentColor) {
			t.Fatalf("未拒绝无效颜色 %q: %v", invalid, err)
		}
	}
	value = ""
	input.AccentColor = &value
	current, err = service.Update(ctx, input)
	if err != nil || current.AccentColor != "" {
		t.Fatalf("清空颜色失败: %#v, %v", current, err)
	}
}

func TestServiceUpdatesLogosIndependently(t *testing.T) {
	service := NewService(NewMemoryStore())
	pngImage := encodePNG(t, 12, 8)
	jpegImage := encodeJPEG(t, 8, 12)

	configuration, err := service.Update(context.Background(), UpdateInput{
		SidebarLogoAction: ActionReplace, SidebarLogo: pngImage,
		SidebarCompactLogoAction: ActionReplace, SidebarCompactLogo: jpegImage,
		UpdatedBy: "user-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if configuration.SidebarLogo == nil || configuration.SidebarLogo.ContentType != "image/png" {
		t.Fatalf("sidebar logo = %#v", configuration.SidebarLogo)
	}
	if configuration.SidebarCompactLogo == nil || configuration.SidebarCompactLogo.ContentType != "image/jpeg" {
		t.Fatalf("compact logo = %#v", configuration.SidebarCompactLogo)
	}

	configuration, err = service.Update(context.Background(), UpdateInput{
		SidebarLogoAction:        ActionReset,
		SidebarCompactLogoAction: ActionKeep,
		UpdatedBy:                "user-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if configuration.SidebarLogo != nil || configuration.SidebarCompactLogo == nil {
		t.Fatalf("configuration = %#v", configuration)
	}
}

func TestServiceDarkLogosKeepLegacyUpdatesAndResetIndependently(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store)
	light := encodePNG(t, 12, 8)
	dark := encodeJPEG(t, 8, 12)
	configuration, err := service.Update(ctx, UpdateInput{
		SidebarLogoAction: ActionReplace, SidebarLogo: light,
		SidebarCompactLogoAction: ActionReplace, SidebarCompactLogo: light,
		SidebarLogoDarkAction: ActionReplace, SidebarLogoDark: dark,
		SidebarCompactLogoDarkAction: ActionReplace, SidebarCompactLogoDark: dark,
	})
	if err != nil || configuration.SidebarLogoDark == nil || configuration.SidebarCompactLogoDark == nil {
		t.Fatalf("dark logos not saved: %#v, %v", configuration, err)
	}
	configuration.SidebarLogoDark.Content[0] = 0
	configuration, err = NewService(store).Update(ctx, UpdateInput{
		SidebarLogoAction: ActionReset, SidebarCompactLogoAction: ActionKeep,
	})
	if err != nil || configuration.SidebarLogo != nil || configuration.SidebarCompactLogo == nil ||
		configuration.SidebarLogoDark == nil || !bytes.Equal(configuration.SidebarLogoDark.Content, dark) ||
		configuration.SidebarCompactLogoDark == nil || !bytes.Equal(configuration.SidebarCompactLogoDark.Content, dark) {
		t.Fatalf("legacy update changed dark logos: %#v, %v", configuration, err)
	}
	configuration, err = service.Update(ctx, UpdateInput{
		SidebarLogoAction: ActionKeep, SidebarCompactLogoAction: ActionKeep,
		SidebarLogoDarkAction: ActionReset,
	})
	if err != nil || configuration.SidebarLogoDark != nil || configuration.SidebarCompactLogoDark == nil || configuration.SidebarCompactLogo == nil {
		t.Fatalf("reset changed other logos: %#v, %v", configuration, err)
	}
}

func TestServiceRejectsInvalidDarkLogosAtomically(t *testing.T) {
	ctx := context.Background()
	service := NewService(nil)
	original := encodePNG(t, 12, 8)
	if _, err := service.Update(ctx, UpdateInput{
		SidebarLogoAction: ActionReplace, SidebarLogo: original, SidebarCompactLogoAction: ActionKeep,
		SidebarLogoDarkAction: ActionReplace, SidebarLogoDark: original,
	}); err != nil {
		t.Fatal(err)
	}
	for _, compact := range []bool{false, true} {
		for _, test := range []struct {
			action  Action
			content []byte
			want    error
		}{
			{ActionReplace, []byte("not an image"), ErrInvalidImage},
			{ActionReplace, make([]byte, MaxImageSize+1), ErrImageTooLarge},
			{ActionReplace, encodePNG(t, MaxDimension+1, 1), ErrInvalidImage},
			{ActionKeep, original, ErrInvalidAction},
			{ActionReset, original, ErrInvalidAction},
			{Action("invalid"), nil, ErrInvalidAction},
		} {
			input := UpdateInput{SidebarLogoAction: ActionReset, SidebarCompactLogoAction: ActionKeep}
			if compact {
				input.SidebarCompactLogoDarkAction, input.SidebarCompactLogoDark = test.action, test.content
			} else {
				input.SidebarLogoDarkAction, input.SidebarLogoDark = test.action, test.content
			}
			if _, err := service.Update(ctx, input); !errors.Is(err, test.want) {
				t.Fatalf("compact=%v action=%q error=%v, want %v", compact, test.action, err, test.want)
			}
			current, err := service.Get(ctx)
			if err != nil || current.SidebarLogo == nil || current.SidebarLogoDark == nil || !bytes.Equal(current.SidebarLogoDark.Content, original) {
				t.Fatalf("rejected update changed configuration: %#v, %v", current, err)
			}
		}
	}
}

func TestServiceMenuLabelsValidationAndReset(t *testing.T) {
	service := NewService(NewMemoryStore())
	label := "  企业技能  "
	configuration, err := service.Update(context.Background(), UpdateInput{
		SidebarLogoAction: ActionKeep, SidebarCompactLogoAction: ActionKeep,
		SidebarMenuLabels: map[string]*string{"skills": &label},
	})
	if err != nil || configuration.SidebarMenuLabels.Skills != "企业技能" {
		t.Fatalf("configuration=%#v error=%v", configuration, err)
	}
	for _, value := range []string{"", "   ", "一二三四五六七八九十一", "a\nb", "a\tb", "a\u200bb"} {
		t.Run(value, func(t *testing.T) {
			_, err := service.Update(context.Background(), UpdateInput{
				SidebarLogoAction: ActionKeep, SidebarCompactLogoAction: ActionKeep,
				SidebarMenuLabels: map[string]*string{"skills": &value},
			})
			if !errors.Is(err, ErrInvalidMenuLabel) {
				t.Fatalf("error=%v", err)
			}
			current, _ := service.Get(context.Background())
			if current.SidebarMenuLabels.Skills != "企业技能" {
				t.Fatal("rejected update changed configuration")
			}
		})
	}
	for _, value := range []string{"字", "Ab12", "一二三四五", "一二三四五六七八九十", "𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷"} {
		_, err := service.Update(context.Background(), UpdateInput{
			SidebarLogoAction: ActionKeep, SidebarCompactLogoAction: ActionKeep,
			SidebarMenuLabels: map[string]*string{"drive": &value},
		})
		if err != nil {
			t.Fatalf("valid value %q error=%v", value, err)
		}
	}
	configuration, err = service.Update(context.Background(), UpdateInput{
		SidebarLogoAction: ActionKeep, SidebarCompactLogoAction: ActionKeep,
		SidebarMenuLabels: map[string]*string{"drive": nil},
	})
	if err != nil || configuration.SidebarMenuLabels.Drive != "" || configuration.SidebarMenuLabels.Skills != "企业技能" {
		t.Fatalf("reset configuration=%#v error=%v", configuration, err)
	}
	_, err = service.Update(context.Background(), UpdateInput{
		SidebarLogoAction: ActionKeep, SidebarCompactLogoAction: ActionKeep,
		SidebarMenuLabels: map[string]*string{"unknown": nil},
	})
	if !errors.Is(err, ErrInvalidMenuLabel) {
		t.Fatalf("unknown field error=%v", err)
	}
}

func TestServiceAdminURLValidationAndReset(t *testing.T) {
	service := NewService(NewMemoryStore())
	url := " https://gateway.example/admin "
	input := UpdateInput{SidebarLogoAction: ActionKeep, SidebarCompactLogoAction: ActionKeep, AdminURL: &url}
	current, err := service.Update(context.Background(), input)
	if err != nil || current.AdminURL != "https://gateway.example/admin" {
		t.Fatalf("admin URL=%q error=%v", current.AdminURL, err)
	}
	for _, invalid := range []string{"javascript:alert(1)", "https://user:pass@example.com/admin", "https://", "https://example.com/a b"} {
		input.AdminURL = &invalid
		if _, err := service.Update(context.Background(), input); !errors.Is(err, ErrInvalidAdminURL) {
			t.Fatalf("invalid URL %q error=%v", invalid, err)
		}
	}
	input.AdminURL = nil
	current, err = service.Update(context.Background(), input)
	if err != nil || current.AdminURL != "https://gateway.example/admin" {
		t.Fatalf("omitted URL changed configuration: %#v error=%v", current, err)
	}
	empty := ""
	input.AdminURL = &empty
	current, err = service.Update(context.Background(), input)
	if err != nil || current.AdminURL != "" {
		t.Fatalf("reset URL=%q error=%v", current.AdminURL, err)
	}
}

func TestServiceRejectsInvalidImagesWithoutChangingConfiguration(t *testing.T) {
	service := NewService(NewMemoryStore())
	original := encodePNG(t, 10, 10)
	truncated := encodePNG(t, 10, 10)
	truncated = truncated[:len(truncated)-8]
	if _, err := service.Update(context.Background(), UpdateInput{
		SidebarLogoAction: ActionReplace, SidebarLogo: original,
		SidebarCompactLogoAction: ActionKeep, UpdatedBy: "user-1",
	}); err != nil {
		t.Fatal(err)
	}

	invalidInputs := []struct {
		name    string
		content []byte
		err     error
	}{
		{name: "empty", err: ErrInvalidImage},
		{name: "unsupported", content: []byte("GIF89a"), err: ErrInvalidImage},
		{name: "truncated", content: truncated, err: ErrInvalidImage},
		{name: "too large", content: make([]byte, MaxImageSize+1), err: ErrImageTooLarge},
		{name: "dimensions", content: encodePNG(t, MaxDimension+1, 1), err: ErrInvalidImage},
	}
	for _, test := range invalidInputs {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.Update(context.Background(), UpdateInput{
				SidebarLogoAction:        ActionReset,
				SidebarCompactLogoAction: ActionReplace,
				SidebarCompactLogo:       test.content,
				UpdatedBy:                "user-2",
			})
			if !errors.Is(err, test.err) {
				t.Fatalf("error = %v, want %v", err, test.err)
			}
			configuration, getErr := service.Get(context.Background())
			if getErr != nil {
				t.Fatal(getErr)
			}
			if configuration.SidebarLogo == nil || !bytes.Equal(configuration.SidebarLogo.Content, original) {
				t.Fatal("valid existing logo changed after rejected update")
			}
		})
	}
}

func TestServiceRejectsFilesForKeepAndReset(t *testing.T) {
	service := NewService(NewMemoryStore())
	for _, action := range []Action{ActionKeep, ActionReset} {
		_, err := service.Update(context.Background(), UpdateInput{
			SidebarLogoAction: action, SidebarLogo: encodePNG(t, 1, 1),
			SidebarCompactLogoAction: ActionKeep,
		})
		if !errors.Is(err, ErrInvalidAction) {
			t.Fatalf("action %q error = %v", action, err)
		}
	}
}

func encodePNG(t *testing.T, width, height int) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := png.Encode(&output, solidImage(width, height)); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func encodeJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := jpeg.Encode(&output, solidImage(width, height), nil); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func solidImage(width, height int) image.Image {
	value := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			value.Set(x, y, color.RGBA{R: 20, G: 120, B: 180, A: 255})
		}
	}
	return value
}
