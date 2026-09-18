package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/feedback"
)

func mountFeedbackCollectionRoutes(admin *gin.RouterGroup, opts Options) {
	allowed := func() bool { return opts.ExternalFeedbackAllowed == nil || *opts.ExternalFeedbackAllowed }
	group := admin.Group("/feedback", requireAdminAccess(opts.RBACService))
	group.GET("/collection-policy", func(c *gin.Context) {
		feedbackResponse(c, gin.H{"external_feedback_allowed": allowed()}, nil, 200)
	})
	group.POST("/collect", func(c *gin.Context) {
		if !allowed() {
			feedbackResponse(c, nil, &feedback.Error{Status: 403, Code: "feedback_policy_disabled"}, 0)
			return
		}
		if origin := c.GetHeader("Origin"); origin != "" {
			parsed, err := url.Parse(origin)
			if err != nil || parsed.Host != c.Request.Host || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				feedbackResponse(c, nil, &feedback.Error{Status: 403, Code: "feedback_invalid_origin"}, 0)
				return
			}
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 52<<20)
		if err := c.Request.ParseMultipartForm(1 << 20); err != nil {
			feedbackResponse(c, nil, &feedback.Error{Status: 413, Code: "feedback_request_too_large"}, 0)
			return
		}
		defer c.Request.MultipartForm.RemoveAll()
		metadata := c.Request.FormValue("metadata")
		if len(metadata) > 2<<20 {
			feedbackResponse(c, nil, &feedback.Error{Status: 413, Code: "feedback_request_too_large"}, 0)
			return
		}
		if _, err := feedback.CanonicalHash([]byte(metadata)); err != nil {
			feedbackResponse(c, nil, err, 0)
			return
		}
		var input feedback.ConsoleInput
		decoder := json.NewDecoder(strings.NewReader(metadata))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			feedbackResponse(c, nil, &feedback.Error{Status: 400, Code: "feedback_invalid_request"}, 0)
			return
		}
		files := c.Request.MultipartForm.File["screenshots"]
		if len(files) > 5 {
			feedbackResponse(c, nil, &feedback.Error{Status: 413, Code: "feedback_quota_exceeded"}, 0)
			return
		}
		screenshots := []feedback.ConsoleScreenshot{}
		for _, file := range files {
			f, err := file.Open()
			if err != nil {
				feedbackResponse(c, nil, err, 0)
				return
			}
			data, err := io.ReadAll(io.LimitReader(f, (10<<20)+1))
			_ = f.Close()
			if err != nil || len(data) > 10<<20 {
				feedbackResponse(c, nil, &feedback.Error{Status: 413, Code: "feedback_quota_exceeded"}, 0)
				return
			}
			screenshots = append(screenshots, feedback.ConsoleScreenshot{ContentType: file.Header.Get("Content-Type"), Data: data})
		}
		out, err := feedback.SubmitConsoleFeedback(c.Request.Context(), input, screenshots, nil, allowed)
		feedbackResponse(c, out, err, 200)
	})
}
