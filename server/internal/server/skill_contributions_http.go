package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/skillhub"
	"go.uber.org/zap"
)

func mountSkillContributionRoutes(app *gin.RouterGroup, opts Options) {
	group := app.Group("/skill-contributions", func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			activityError(c, 401, "unauthorized", "未登录")
			c.Abort()
			return
		}
		if opts.DataAccessService == nil || opts.SkillHubService == nil {
			activityError(c, 503, "data_unavailable", "Skill 贡献服务暂不可用")
			c.Abort()
			return
		}
		allowed, err := opts.DataAccessService.HasAction(c.Request.Context(), account.UserID, dataaccess.ResourceDataView, dataaccess.ViewSkillContributions, dataaccess.ActionRead)
		if err != nil {
			activityError(c, 503, "data_unavailable", "数据授权服务暂不可用")
			c.Abort()
			return
		}
		if !allowed {
			activityError(c, 403, "data_view_forbidden", "无权查看 Skill 贡献")
			c.Abort()
			return
		}
	})
	for _, endpoint := range []string{"summary", "records", "detail", "export"} {
		handler := func(c *gin.Context) {
			var query skillhub.ContributionQuery
			var result skillhub.ContributionResponse
			var err error
			if endpoint == "detail" {
				values, parseErr := url.ParseQuery(c.Request.URL.RawQuery)
				if parseErr != nil {
					contributionHTTPError(c, skillhub.ErrInvalidRequest)
					return
				}
				for key, value := range values {
					if (key != "skill_id" && key != "version_id") || len(value) != 1 {
						contributionHTTPError(c, skillhub.ErrInvalidRequest)
						return
					}
				}
				result, err = opts.SkillHubService.ContributionDetail(c.Request.Context(), values.Get("skill_id"), values.Get("version_id"))
			} else {
				if endpoint == "export" {
					if c.Request.URL.RawQuery != "" {
						contributionHTTPError(c, skillhub.ErrInvalidRequest)
						return
					}
					body, readErr := io.ReadAll(io.LimitReader(c.Request.Body, 8193))
					if readErr != nil || len(body) > 8192 {
						contributionHTTPError(c, skillhub.ErrInvalidRequest)
						return
					}
					var fields map[string]json.RawMessage
					if json.Unmarshal(body, &fields) != nil || fields == nil {
						contributionHTTPError(c, skillhub.ErrInvalidRequest)
						return
					}
					if _, exists := fields["page"]; exists {
						contributionHTTPError(c, skillhub.ErrInvalidRequest)
						return
					}
					if _, exists := fields["page_size"]; exists {
						contributionHTTPError(c, skillhub.ErrInvalidRequest)
						return
					}
					decoder := json.NewDecoder(strings.NewReader(string(body)))
					decoder.DisallowUnknownFields()
					err = decoder.Decode(&query)
					if err == nil {
						var trailing any
						if decoder.Decode(&trailing) != io.EOF {
							err = skillhub.ErrInvalidRequest
						}
					}
					if err != nil {
						contributionHTTPError(c, skillhub.ErrInvalidRequest)
						return
					}
				} else {
					if endpoint == "summary" {
						values, _ := url.ParseQuery(c.Request.URL.RawQuery)
						for key := range values {
							if key != "start_date" && key != "end_date" && key != "employee_id" {
								contributionHTTPError(c, skillhub.ErrInvalidRequest)
								return
							}
						}
					}
					query, err = contributionHTTPQuery(c.Request.URL.RawQuery)
				}
				if err == nil {
					result, err = opts.SkillHubService.Contributions(c.Request.Context(), query, endpoint == "summary", endpoint == "export")
				}
			}
			if err != nil {
				contributionHTTPError(c, err)
				return
			}
			account, _ := currentAccount(c)
			if opts.Logger != nil {
				opts.Logger.Info("skill contribution request", zap.String("user_id", account.UserID), zap.String("operation", endpoint), zap.Any("query", result.Query), zap.Int("rows", result.Total), zap.Time("generated_at", result.GeneratedAt))
			}
			if endpoint == "export" {
				body, csvErr := skillhub.ContributionCSV(result)
				if csvErr != nil {
					contributionHTTPError(c, csvErr)
					return
				}
				c.Header("Content-Disposition", `attachment; filename="skill-contributions.csv"`)
				c.Header("X-Result-Count", strconv.Itoa(result.Total))
				c.Header("Cache-Control", "no-store")
				c.Data(200, "text/csv; charset=utf-8", body)
				return
			}
			c.Header("Cache-Control", "no-store")
			c.JSON(http.StatusOK, gin.H{"data": result})
		}
		if endpoint == "export" {
			group.POST("/"+endpoint, handler)
		} else {
			group.GET("/"+endpoint, handler)
		}
	}
}

func contributionHTTPQuery(raw string) (skillhub.ContributionQuery, error) {
	var query skillhub.ContributionQuery
	values, err := url.ParseQuery(raw)
	if err != nil {
		return query, skillhub.ErrInvalidRequest
	}
	arguments := map[string]any{}
	for key, items := range values {
		if len(items) != 1 || strings.TrimSpace(items[0]) == "" {
			return query, skillhub.ErrInvalidRequest
		}
		value := items[0]
		switch key {
		case "start_date", "end_date", "report", "employee_id", "status":
			arguments[key] = value
		case "page", "page_size":
			number, parseErr := strconv.Atoi(value)
			if parseErr != nil || number < 1 {
				return query, skillhub.ErrInvalidRequest
			}
			arguments[key] = number
		case "min_total_score":
			number, parseErr := strconv.ParseFloat(value, 64)
			if parseErr != nil {
				return query, skillhub.ErrInvalidRequest
			}
			arguments[key] = number
		default:
			return query, skillhub.ErrInvalidRequest
		}
	}
	body, err := json.Marshal(arguments)
	if err != nil {
		return query, skillhub.ErrInvalidRequest
	}
	err = json.Unmarshal(body, &query)
	return query, err
}

func contributionHTTPError(c *gin.Context, err error) {
	status, code, message := 503, "data_unavailable", "Skill 贡献数据暂不可用"
	if errors.Is(err, skillhub.ErrInvalidRequest) {
		status, code, message = 400, "invalid_request", "查询条件无效或不适用于该视图"
	}
	if errors.Is(err, skillhub.ErrNotFound) {
		status, code, message = 404, "not_found", "未找到对应审核记录"
	}
	if errors.Is(err, skillhub.ErrContributionLimit) {
		status, code, message = 400, "export_limit", "导出超过 10,000 行，请缩小周期或员工范围"
	}
	activityError(c, status, code, message)
}
