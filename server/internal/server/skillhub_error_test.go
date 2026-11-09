package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestSkillErrorDatabasePermissionDenied(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		code    string
		message string
	}{
		{
			name:    "database permission denied",
			err:     fmt.Errorf("review: %w", &pgconn.PgError{Code: "42501", Message: "permission denied for table approval_requests"}),
			code:    "skill_database_permission_denied",
			message: "技能中心数据库权限不足，请联系管理员检查服务账号授权",
		},
		{
			name: "other database error", err: &pgconn.PgError{Code: "42P01", Message: "relation does not exist"},
			code: "internal_error", message: "技能中心操作失败",
		},
		{
			name: "other internal error", err: errors.New("failure"),
			code: "internal_error", message: "技能中心操作失败",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			skillError(c, tt.err)
			if response.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500", response.Code)
			}
			var body struct {
				Code  string `json:"code"`
				Error string `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Code != tt.code || body.Error != tt.message {
				t.Fatalf("response = %#v, want code %q and message %q", body, tt.code, tt.message)
			}
			if len(c.Errors) != 1 || !errors.Is(c.Errors[0].Err, tt.err) {
				t.Fatalf("context errors = %v, want original error %v", c.Errors, tt.err)
			}
		})
	}
}

func TestSkillErrorReportsExistingSkillAndSpace(t *testing.T) {
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	skillError(c, &skillhub.SkillConflictError{
		Kind: skillhub.SkillConflictExisting, SkillName: "functional-competency-model", SpaceName: "人力资源部",
	})

	if response.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", response.Code)
	}
	var body struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := "技能“functional-competency-model”已存在于“人力资源部”空间，请选择该空间或修改 Skill 名称"
	if body.Code != "conflict" || body.Error != want {
		t.Fatalf("response = %#v, want message %q", body, want)
	}
}

func TestSkillErrorReportsExistingVersion(t *testing.T) {
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	skillError(c, &skillhub.SkillConflictError{
		Kind: skillhub.SkillConflictVersion, SkillName: "functional-competency-model", SpaceName: "人力资源部", Version: "1.0.0",
	})

	if response.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", response.Code)
	}
	var body struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := "技能“functional-competency-model”在“人力资源部”空间已存在版本 1.0.0，请使用新的版本号"
	if body.Code != "conflict" || body.Error != want {
		t.Fatalf("response = %#v, want message %q", body, want)
	}
}
