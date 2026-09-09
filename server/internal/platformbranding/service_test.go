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
