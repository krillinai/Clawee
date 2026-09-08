package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestAgentAPIErrorUsesP8ContractCodes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{accounts.ErrInvalidAccountRequest, http.StatusBadRequest, "invalid_request"},
		{accounts.ErrAccountNotFound, http.StatusNotFound, "account_not_found"},
		{accounts.ErrAccountNotActive, http.StatusConflict, "account_not_active"},
		{mcpgateway.ErrAccountTokenNotFound, http.StatusNotFound, "account_token_not_found"},
		{mcpgateway.ErrGrantAlreadyExists, http.StatusConflict, "grant_already_exists"},
		{mcpgateway.ErrGrantNotFound, http.StatusNotFound, "grant_not_found"},
	} {
		t.Run(test.code, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(recorder)
			agentAPIError(context, errors.Join(errors.New("wrapped"), test.err))
			if recorder.Code != test.status || !strings.Contains(recorder.Body.String(), `"error":"`+test.code+`"`) {
				t.Fatalf("status=%d body=%s, want %d %s", recorder.Code, recorder.Body.String(), test.status, test.code)
			}
		})
	}
}
