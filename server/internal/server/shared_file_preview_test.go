package server

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

func TestSharedFilePreview(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name, content, kind, contentType string
		size                             int64
		status                           int
	}{
		{"guide.md", "# hello", "text", "text/plain; charset=utf-8", 7, 200},
		{"page.html", "<script>alert(1)</script>", "text", "text/plain; charset=utf-8", 25, 200},
		{"image.svg", "<svg></svg>", "text", "text/plain; charset=utf-8", 11, 200},
		{"paper.pdf", "%PDF-1.7\n", "pdf", "application/pdf", 9, 200},
		{"image.png", "\x89PNG\r\n\x1a\n", "image", "image/png", 8, 200},
		{"file.docx", "zip", "", "", 3, 415},
		{"fake.png", "<html>unsafe</html>", "", "", 19, 415},
		{"binary.txt", "a\x00b", "", "", 3, 415},
		{"large.txt", "small", "", "", 1024*1024 + 1, 413},
		{"large.pdf", "%PDF-1.7\n", "", "", 20*1024*1024 + 1, 413},
		{"lying.txt", strings.Repeat("a", 1024*1024+1), "", "", 1, 413},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest("GET", "/content?preview=1", nil)
			writeSharedFileContent(c, sharedfiles.File{FileName: test.name, ContentType: "text/html", SizeBytes: test.size}, io.NopCloser(strings.NewReader(test.content)))
			if recorder.Code != test.status {
				t.Fatalf("status=%d body length=%d", recorder.Code, recorder.Body.Len())
			}
			if test.status == 200 {
				if recorder.Header().Get("X-Preview-Kind") != test.kind || recorder.Header().Get("Content-Type") != test.contentType || recorder.Body.String() != test.content {
					t.Fatalf("headers=%v body=%q", recorder.Header(), recorder.Body.String())
				}
				if recorder.Header().Get("Cache-Control") != "no-store" || !strings.HasPrefix(recorder.Header().Get("Content-Disposition"), "attachment") {
					t.Fatalf("unsafe headers=%v", recorder.Header())
				}
			}
		})
	}
}
