package knowledge

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

type ValidatedDocumentFile struct {
	Name      string
	Extension string
	MIMEType  string
}

func ValidateDocumentFile(name string, size int64, reader io.Reader) (ValidatedDocumentFile, error) {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "." || name == "" || size <= 0 || size > MaxDocumentSize {
		return ValidatedDocumentFile{}, ErrInvalidRequest
	}
	ext := strings.ToLower(filepath.Ext(name))
	mimeTypes := map[string]string{
		".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".md": "text/markdown", ".txt": "text/plain", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".csv": "text/csv",
	}
	mimeType, ok := mimeTypes[ext]
	if !ok {
		return ValidatedDocumentFile{}, ErrInvalidRequest
	}
	data, err := io.ReadAll(io.LimitReader(reader, MaxDocumentSize+1))
	if err != nil || int64(len(data)) != size {
		return ValidatedDocumentFile{}, ErrInvalidRequest
	}
	switch ext {
	case ".pdf":
		if !bytes.HasPrefix(data, []byte("%PDF-")) {
			return ValidatedDocumentFile{}, ErrInvalidRequest
		}
	case ".docx":
		if err := validateOfficeZIP(data, "word/"); err != nil {
			return ValidatedDocumentFile{}, err
		}
	case ".xlsx":
		if err := validateOfficeZIP(data, "xl/"); err != nil {
			return ValidatedDocumentFile{}, err
		}
	default:
		if bytes.IndexByte(data, 0) >= 0 {
			return ValidatedDocumentFile{}, ErrInvalidRequest
		}
	}
	return ValidatedDocumentFile{Name: name, Extension: ext, MIMEType: mimeType}, nil
}

func validateOfficeZIP(data []byte, requiredPrefix string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("%w: invalid office archive", ErrInvalidRequest)
	}
	var contentTypes, required bool
	for _, file := range zr.File {
		if file.Name == "[Content_Types].xml" {
			contentTypes = true
		}
		if strings.HasPrefix(file.Name, requiredPrefix) {
			required = true
		}
	}
	if !contentTypes || !required {
		return ErrInvalidRequest
	}
	return nil
}
