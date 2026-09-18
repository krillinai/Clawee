package server

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/feedback"
)

func feedbackResponse(c *gin.Context, data any, err error, status int) {
	c.Header("Cache-Control", "no-store")
	if err != nil {
		code, name := feedback.HTTPError(err)
		if code == 429 {
			c.Header("Retry-After", "60")
		}
		c.JSON(code, gin.H{"error": gin.H{"code": name, "message": "反馈请求未完成", "details": []any{}}})
		return
	}
	c.JSON(status, gin.H{"data": data})
}
func feedbackJSON(c *gin.Context, dst any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
	b, err := io.ReadAll(c.Request.Body)
	if err != nil {
		feedbackResponse(c, nil, &feedback.Error{Status: 413, Code: "feedback_request_too_large"}, 0)
		return false
	}
	if _, err = feedback.CanonicalHash(b); err != nil {
		feedbackResponse(c, nil, err, 0)
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(string(b)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(dst); err != nil {
		feedbackResponse(c, nil, &feedback.Error{Status: 400, Code: "feedback_invalid_request"}, 0)
		return false
	}
	return true
}
func feedbackBearer(c *gin.Context) string {
	h := c.GetHeader("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return ""
}
func feedbackActor(c *gin.Context) feedback.Actor {
	account, _ := currentAccount(c)
	return feedback.Actor{UserID: account.UserID, RequestID: c.GetHeader("X-Request-ID")}
}
func feedbackClientIP(r *http.Request, proxies []string) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	ip, e := netip.ParseAddr(host)
	if e != nil {
		return "unknown"
	}
	trusted := func(addr netip.Addr) bool {
		for _, cidr := range proxies {
			prefix, e := netip.ParsePrefix(cidr)
			if e == nil && prefix.Contains(addr.Unmap()) {
				return true
			}
			parsed, e := netip.ParseAddr(cidr)
			if e == nil && parsed.Unmap() == addr.Unmap() {
				return true
			}
		}
		return false
	}
	if !trusted(ip) {
		return ip.Unmap().String()
	}
	forwarded := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	if len(forwarded) > 32 {
		return ip.Unmap().String()
	}
	for i := len(forwarded) - 1; i >= 0; i-- {
		next, e := netip.ParseAddr(strings.TrimSpace(forwarded[i]))
		if e != nil {
			return ip.Unmap().String()
		}
		ip = next
		if !trusted(ip) {
			break
		}
	}
	return ip.Unmap().String()
}
func mountFeedbackRoutes(api, admin *gin.RouterGroup, opts Options) {
	if opts.FeedbackService == nil {
		return
	}
	svc := opts.FeedbackService
	public := api.Group("/feedback")
	public.Use(func(c *gin.Context) { c.Header("Cache-Control", "no-store"); c.Next() })
	public.POST("/reports", func(c *gin.Context) {
		var in feedback.CreateInput
		if !feedbackJSON(c, &in) {
			return
		}
		ip := feedbackClientIP(c.Request, opts.FeedbackTrustedProxies)
		out, created, err := svc.Create(c.Request.Context(), in, ip, c.GetHeader("X-Feedback-Deployment-Token"))
		status := 200
		if created {
			status = 201
			if id, ok := out["report_id"].(string); ok {
				c.Header("Location", "/api/v1/feedback/reports/"+id)
			}
		}
		feedbackResponse(c, out, err, status)
	})
	public.POST("/reports/:id/upload-credentials", func(c *gin.Context) {
		out, err := svc.Recover(c.Request.Context(), c.Param("id"), feedbackBearer(c))
		feedbackResponse(c, out, err, 200)
	})
	public.GET("/reports/:id/upload", func(c *gin.Context) {
		out, err := svc.Progress(c.Request.Context(), c.Param("id"), feedbackBearer(c))
		feedbackResponse(c, out, err, 200)
	})
	public.GET("/reports/:id/status", func(c *gin.Context) {
		out, err := svc.Status(c.Request.Context(), c.Param("id"), feedbackBearer(c))
		feedbackResponse(c, out, err, 200)
	})
	public.PUT("/reports/:id/artifacts/:artifactId", func(c *gin.Context) {
		controller := http.NewResponseController(c.Writer)
		_ = controller.SetReadDeadline(time.Now().Add(4 * time.Minute))
		created, err := svc.Upload(c.Request.Context(), c.Param("id"), c.Param("artifactId"), feedbackBearer(c), c.GetHeader("Content-Type"), c.GetHeader("X-Content-SHA256"), c.Request.ContentLength, http.MaxBytesReader(c.Writer, c.Request.Body, feedback.MaxArtifactBytes+1))
		if err == nil && created {
			_ = controller.SetReadDeadline(time.Time{})
		} else {
			c.Request.Close = true
			c.Header("Connection", "close")
		}
		status := 200
		if created {
			status = 201
		}
		feedbackResponse(c, gin.H{"received": err == nil}, err, status)
	})
	public.POST("/reports/:id/submit", func(c *gin.Context) {
		var in struct {
			ManifestSHA256 string `json:"manifest_sha256"`
			AcceptPartial  bool   `json:"accept_partial"`
		}
		if !feedbackJSON(c, &in) {
			return
		}
		out, err := svc.Submit(c.Request.Context(), c.Param("id"), feedbackBearer(c), in.ManifestSHA256, in.AcceptPartial)
		feedbackResponse(c, out, err, 200)
	})
	// 普通实例的演示/匿名管理模式不能用于反馈。
	management := admin.Group("/feedback")
	management.Use(func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if opts.AccountService == nil || opts.RBACService == nil || opts.DataAccessService == nil {
			c.AbortWithStatus(503)
			return
		}
		c.Next()
	})
	management.GET("/reports", func(c *gin.Context) {
		limit, _ := strconv.Atoi(c.Query("limit"))
		out, next, err := svc.List(c.Request.Context(), feedbackActor(c), feedback.Filter{Status: c.Query("status"), Source: c.Query("source"), Version: c.Query("version"), Keyword: c.Query("keyword"), From: c.Query("from"), To: c.Query("to"), Cursor: c.Query("cursor"), Limit: limit, IncludeUnavailable: c.Query("include_unavailable") == "true"})
		if err != nil {
			feedbackResponse(c, nil, err, 0)
			return
		}
		c.JSON(200, gin.H{"data": out, "meta": gin.H{"next_cursor": next, "has_next": next != ""}})
	})
	management.GET("/reports/:id", func(c *gin.Context) {
		out, err := svc.Get(c.Request.Context(), feedbackActor(c), c.Param("id"))
		feedbackResponse(c, out, err, 200)
	})
	for _, kind := range []string{"conversation", "logs"} {
		management.GET("/reports/:id/"+kind, func(c *gin.Context) {
			limit, _ := strconv.Atoi(c.Query("limit"))
			out, err := svc.Read(c.Request.Context(), feedbackActor(c), c.Param("id"), kind, feedback.ReadInput{ArtifactID: c.Query("artifact_id"), Cursor: c.Query("cursor"), Limit: limit, Keyword: c.Query("keyword"), Level: c.Query("level"), RunID: c.Query("run_id"), From: c.Query("from"), To: c.Query("to")})
			feedbackResponse(c, out, err, 200)
		})
	}
	for _, op := range []string{"investigate", "resolve", "reopen"} {
		management.POST("/reports/:id/"+op, func(c *gin.Context) {
			var in feedback.OperationInput
			if !feedbackJSON(c, &in) {
				return
			}
			out, err := svc.Operate(c.Request.Context(), feedbackActor(c), c.Param("id"), op, in)
			feedbackResponse(c, out, err, 200)
		})
	}
	content := func(c *gin.Context, download bool) {
		f, a, err := svc.Open(c.Request.Context(), feedbackActor(c), c.Param("id"), c.Param("artifactId"), download)
		if err != nil {
			feedbackResponse(c, nil, err, 0)
			return
		}
		defer f.Close()
		if !download && a.Kind != "screenshot" {
			c.Status(404)
			return
		}
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Content-Security-Policy", "default-src 'none'")
		if download {
			c.Header("Content-Disposition", "attachment")
		}
		c.DataFromReader(200, a.Size, a.ContentType, f, nil)
	}
	management.GET("/reports/:id/screenshots/:artifactId", func(c *gin.Context) { content(c, false) })
	management.GET("/reports/:id/artifacts/:artifactId/content", func(c *gin.Context) { content(c, true) })
}
