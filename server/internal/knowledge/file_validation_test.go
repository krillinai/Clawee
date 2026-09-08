package knowledge

import (
	"archive/zip"
	"bytes"
	"testing"
)

func TestValidateDocumentFileAcceptsSupportedContent(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{name: "handbook.pdf", data: []byte("%PDF-1.7\n")},
		{name: "notes.md", data: []byte("# title\ncontent")},
		{name: "data.csv", data: []byte("name,value\na,1\n")},
		{name: "manual.docx", data: officeZIP(t, "word/document.xml")},
		{name: "sheet.xlsx", data: officeZIP(t, "xl/workbook.xml")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := ValidateDocumentFile(tt.name, int64(len(tt.data)), bytes.NewReader(tt.data)); err != nil {
				t.Fatalf("ValidateDocumentFile() error = %v", err)
			}
		})
	}
}

func TestValidateDocumentFileRejectsInvalidContent(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		size int64
	}{
		{name: "bad.pdf", data: []byte("not pdf")},
		{name: "bad.txt", data: []byte{'a', 0, 'b'}},
		{name: "bad.exe", data: []byte("MZ")},
		{name: "large.md", data: []byte("x"), size: MaxDocumentSize + 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			size := tt.size
			if size == 0 {
				size = int64(len(tt.data))
			}
			if _, err := ValidateDocumentFile(tt.name, size, bytes.NewReader(tt.data)); err == nil {
				t.Fatal("ValidateDocumentFile() error = nil")
			}
		})
	}
}

func officeZIP(t *testing.T, entry string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range []string{"[Content_Types].xml", entry} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
