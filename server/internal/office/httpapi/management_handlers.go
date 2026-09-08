package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/office/registration"
)

const (
	defaultOnlineThreshold = management.DefaultCollectorOnlineThreshold
)

type ManagementStore interface {
	CollectorsOverview(context.Context, time.Time, time.Duration) (management.CollectorsOverview, error)
	CreateManagementRegistrationCode(context.Context, string, string, time.Time) (management.CreateRegistrationCodeResponse, error)
	EnsureManagementRegistrationCode(context.Context, string, string, time.Time) (management.RegistrationCodeSummary, error)
	DeleteCollector(context.Context, string, time.Time, time.Duration) error
	DeleteUserCollector(context.Context, string, string, time.Time, time.Duration) error
	RevokeCollectorToken(context.Context, string, time.Time) error
	BindMCPAgent(context.Context, string, string, string, time.Time) error
	UnbindMCPAgent(context.Context, string, string, time.Time) error
	DeleteOfficeAgent(context.Context, string, string) error
	UserCollectorsOverview(context.Context, string, time.Time, time.Duration) (management.CollectorsOverview, error)
	RevokeUserCollectorToken(context.Context, string, string, time.Time) error
}

type ManagementAPI struct {
	store         ManagementStore
	now           Clock
	publicBaseURL string
}

type ManagementAPIOptions struct {
	PublicBaseURL string
}

type managementOperatorKey struct{}
type managementOperatorNameKey struct{}

func ContextWithManagementOperator(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, managementOperatorKey{}, userID)
}

func managementOperator(ctx context.Context) string {
	value, _ := ctx.Value(managementOperatorKey{}).(string)
	return value
}

func ContextWithManagementOperatorName(ctx context.Context, name string) context.Context {
	return context.WithValue(ctx, managementOperatorNameKey{}, strings.TrimSpace(name))
}

func managementOperatorName(ctx context.Context) string {
	value, _ := ctx.Value(managementOperatorNameKey{}).(string)
	return strings.TrimSpace(value)
}

func NewManagementAPI(store ManagementStore, now Clock) *ManagementAPI {
	return NewManagementAPIWithOptions(store, now, ManagementAPIOptions{})
}

func NewManagementAPIWithOptions(store ManagementStore, now Clock, opts ManagementAPIOptions) *ManagementAPI {
	return &ManagementAPI{
		store:         store,
		now:           now,
		publicBaseURL: strings.TrimRight(opts.PublicBaseURL, "/"),
	}
}

func (api *ManagementAPI) CollectorsHandler() http.Handler {
	return http.HandlerFunc(api.handleCollectors)
}

func (api *ManagementAPI) CollectorDetailHandler() http.Handler {
	return http.HandlerFunc(api.handleCollectorDetail)
}

func (api *ManagementAPI) CollectorsOverviewHandler() http.Handler {
	return http.HandlerFunc(api.handleCollectorsOverview)
}

func (api *ManagementAPI) CollectorTokenRevokeHandler() http.Handler {
	return http.HandlerFunc(api.handleCollectorTokenRevoke)
}

func (api *ManagementAPI) CollectorDeleteHandler() http.Handler {
	return http.HandlerFunc(api.handleCollectorDelete)
}

func (api *ManagementAPI) AgentBindingHandler() http.Handler {
	return http.HandlerFunc(api.handleDirectAgentBinding)
}

func (api *ManagementAPI) AgentUnbindingHandler() http.Handler {
	return http.HandlerFunc(api.handleDirectAgentUnbinding)
}

func (api *ManagementAPI) AgentDeleteHandler() http.Handler {
	return http.HandlerFunc(api.handleAgentDelete)
}

func (api *ManagementAPI) UserCollectorsHandler() http.Handler {
	return http.HandlerFunc(api.handleUserCollectors)
}

func (api *ManagementAPI) UserCollectorDeleteHandler() http.Handler {
	return http.HandlerFunc(api.handleUserCollectorDelete)
}

func (api *ManagementAPI) RegistrationCodeHandler() http.Handler {
	return http.HandlerFunc(api.handleRegistrationCode)
}

func (api *ManagementAPI) handleDirectAgentBinding(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		w.Header().Set("Allow", http.MethodPut)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method must be PUT")
		return
	}
	var req struct {
		CollectorID string `json:"collector_id"`
		AgentID     string `json:"agent_id"`
		MCPAgentID  string `json:"mcp_agent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.CollectorID) == "" || strings.TrimSpace(req.AgentID) == "" || strings.TrimSpace(req.MCPAgentID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_agent_binding", "collector_id, agent_id and mcp_agent_id are required")
		return
	}
	api.bindMCPAgent(w, r, strings.TrimSpace(req.CollectorID), strings.TrimSpace(req.AgentID), strings.TrimSpace(req.MCPAgentID))
}

func (api *ManagementAPI) handleDirectAgentUnbinding(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", http.MethodPost+", "+http.MethodDelete)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method must be POST or DELETE")
		return
	}
	var req struct {
		CollectorID string `json:"collector_id"`
		AgentID     string `json:"agent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.CollectorID) == "" || strings.TrimSpace(req.AgentID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_agent_binding", "collector_id and agent_id are required")
		return
	}
	api.unbindMCPAgent(w, r, strings.TrimSpace(req.CollectorID), strings.TrimSpace(req.AgentID))
}

func (api *ManagementAPI) handleAgentDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", http.MethodPost+", "+http.MethodDelete)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method must be POST or DELETE")
		return
	}
	var req struct {
		CollectorID string `json:"collector_id"`
		AgentID     string `json:"agent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.CollectorID) == "" || strings.TrimSpace(req.AgentID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_agent_delete", "collector_id and agent_id are required")
		return
	}
	if err := api.store.DeleteOfficeAgent(r.Context(), strings.TrimSpace(req.CollectorID), strings.TrimSpace(req.AgentID)); err != nil {
		switch {
		case errors.Is(err, management.ErrOfficeAgentNotFound):
			writeError(w, http.StatusNotFound, "office_agent_not_found", err.Error())
		case errors.Is(err, management.ErrOfficeAgentBound):
			writeError(w, http.StatusConflict, "office_agent_bound", err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "internal_error", "office agent delete failed")
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api *ManagementAPI) bindMCPAgent(w http.ResponseWriter, r *http.Request, collectorID, officeAgentID, mcpAgentID string) {
	if err := api.store.BindMCPAgent(r.Context(), collectorID, officeAgentID, mcpAgentID, api.receivedAt()); err != nil {
		api.writeAgentBindingError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "bound"})
}

func (api *ManagementAPI) unbindMCPAgent(w http.ResponseWriter, r *http.Request, collectorID, officeAgentID string) {
	if err := api.store.UnbindMCPAgent(r.Context(), collectorID, officeAgentID, api.receivedAt()); err != nil {
		api.writeAgentBindingError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api *ManagementAPI) writeAgentBindingError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, management.ErrOfficeAgentNotFound):
		writeError(w, http.StatusNotFound, "office_agent_not_found", err.Error())
	case errors.Is(err, management.ErrMCPAgentNotFound):
		writeError(w, http.StatusNotFound, "mcp_agent_not_found", err.Error())
	case errors.Is(err, management.ErrAgentOwnerMismatch):
		writeError(w, http.StatusConflict, "agent_owner_mismatch", err.Error())
	case errors.Is(err, management.ErrOfficeAgentAlreadyBound):
		writeError(w, http.StatusConflict, "office_agent_already_bound", err.Error())
	case errors.Is(err, management.ErrMCPAgentAlreadyBound):
		writeError(w, http.StatusConflict, "mcp_agent_already_bound", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "agent binding failed")
	}
}

func (api *ManagementAPI) handleCollectorsOverview(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	overview, err := api.store.CollectorsOverview(r.Context(), api.receivedAt(), defaultOnlineThreshold)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "collector management overview failed")
		return
	}
	writeJSON(w, http.StatusOK, api.withOverviewInstallLinks(r, overview))
}

func (api *ManagementAPI) handleCollectors(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	overview, err := api.store.CollectorsOverview(r.Context(), api.receivedAt(), defaultOnlineThreshold)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "collector list failed")
		return
	}
	items := overview.Collectors
	if items == nil {
		items = []management.CollectorItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (api *ManagementAPI) handleCollectorDetail(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	collectorID := strings.TrimSpace(r.URL.Query().Get("collector_id"))
	overview, err := api.store.CollectorsOverview(r.Context(), api.receivedAt(), defaultOnlineThreshold)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "collector detail failed")
		return
	}
	item, ok := findCollector(overview.Collectors, collectorID, "")
	if !ok {
		writeError(w, http.StatusNotFound, "collector_not_found", "collector not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (api *ManagementAPI) handleUserCollectors(w http.ResponseWriter, r *http.Request) {
	userID := strings.TrimSpace(managementOperator(r.Context()))
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "account identity is required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		overview, err := api.store.UserCollectorsOverview(r.Context(), userID, api.receivedAt(), defaultOnlineThreshold)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "collector access failed")
			return
		}
		collectorID := strings.TrimSpace(r.URL.Query().Get("collector_id"))
		if collectorID != "" {
			item, ok := findCollector(overview.Collectors, collectorID, "")
			if !ok {
				writeError(w, http.StatusNotFound, "collector_not_found", "collector not found")
				return
			}
			writeJSON(w, http.StatusOK, item)
			return
		}
		items := overview.Collectors
		if items == nil {
			items = []management.CollectorItem{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	case http.MethodPost:
		var req struct {
			CollectorID string `json:"collector_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
			return
		}
		req.CollectorID = strings.TrimSpace(req.CollectorID)
		if err := api.store.RevokeUserCollectorToken(r.Context(), userID, req.CollectorID, api.receivedAt()); err != nil {
			api.writeCollectorRevokeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
	default:
		w.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method must be GET or POST")
	}
}

func findCollector(items []management.CollectorItem, collectorID, userID string) (management.CollectorItem, bool) {
	if collectorID == "" {
		return management.CollectorItem{}, false
	}
	for _, item := range items {
		if item.CollectorID == collectorID && (userID == "" || item.UserID == userID) {
			return item, true
		}
	}
	return management.CollectorItem{}, false
}

func (api *ManagementAPI) handleCollectorTokenRevoke(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	var req struct {
		CollectorID string `json:"collector_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.CollectorID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_collector_id", "collector_id is required")
		return
	}
	api.revokeCollectorToken(w, r, strings.TrimSpace(req.CollectorID))
}

func (api *ManagementAPI) handleCollectorDelete(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	collectorID, ok := decodeCollectorID(w, r)
	if !ok {
		return
	}
	if err := api.store.DeleteCollector(r.Context(), collectorID, api.receivedAt(), defaultOnlineThreshold); err != nil {
		api.writeCollectorDeleteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api *ManagementAPI) handleUserCollectorDelete(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	userID := strings.TrimSpace(managementOperator(r.Context()))
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "account identity is required")
		return
	}
	collectorID, ok := decodeCollectorID(w, r)
	if !ok {
		return
	}
	if err := api.store.DeleteUserCollector(r.Context(), userID, collectorID, api.receivedAt(), defaultOnlineThreshold); err != nil {
		api.writeCollectorDeleteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeCollectorID(w http.ResponseWriter, r *http.Request) (string, bool) {
	var req struct {
		CollectorID string `json:"collector_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.CollectorID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_collector_id", "collector_id is required")
		return "", false
	}
	return strings.TrimSpace(req.CollectorID), true
}

func (api *ManagementAPI) writeCollectorDeleteError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, management.ErrCollectorNotFound):
		writeError(w, http.StatusNotFound, "collector_not_found", "collector not found")
	case errors.Is(err, management.ErrCollectorOnline), errors.Is(err, management.ErrCollectorNotDisabled):
		writeError(w, http.StatusConflict, "collector_not_disabled", "only disabled collectors can be deleted")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "collector deletion failed")
	}
}

func (api *ManagementAPI) revokeCollectorToken(w http.ResponseWriter, r *http.Request, collectorID string) {
	if err := api.store.RevokeCollectorToken(r.Context(), collectorID, api.receivedAt()); err != nil {
		api.writeCollectorRevokeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

func (api *ManagementAPI) writeCollectorRevokeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, management.ErrCollectorNotFound):
		writeError(w, http.StatusNotFound, "collector_not_found", "collector not found")
	case errors.Is(err, management.ErrCollectorTokenRevoked):
		writeError(w, http.StatusConflict, "collector_token_revoked", "collector token is already revoked")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "collector token revocation failed")
	}
}

func (api *ManagementAPI) handleRegistrationCode(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
		if userID == "" {
			writeError(w, http.StatusBadRequest, "invalid_user_id", "user_id is required")
			return
		}
		api.getRegistrationCode(w, r, userID)
	case http.MethodPost:
		api.handleCreateRegistrationCode(w, r)
	default:
		w.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method must be GET or POST")
	}
}

func (api *ManagementAPI) handleCreateRegistrationCode(w http.ResponseWriter, r *http.Request) {
	var req management.CreateRegistrationCodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
		return
	}

	if strings.TrimSpace(req.UserID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_user_id", "user_id is required")
		return
	}

	api.createRegistrationCode(w, r, req.UserID)
}

func (api *ManagementAPI) GetAccountRegistrationCode(w http.ResponseWriter, r *http.Request, userID string) {
	if !requireGet(w, r) {
		return
	}
	if strings.TrimSpace(userID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_user_id", "user_id is required")
		return
	}
	api.getRegistrationCode(w, r, userID)
}

func (api *ManagementAPI) CreateAccountRegistrationCode(w http.ResponseWriter, r *http.Request, userID string) {
	if !requirePost(w, r) {
		return
	}
	if strings.TrimSpace(userID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_user_id", "user_id is required")
		return
	}
	api.createRegistrationCode(w, r, userID)
}

func (api *ManagementAPI) createRegistrationCode(w http.ResponseWriter, r *http.Request, userID string) {
	now := api.receivedAt()
	resp, err := api.store.CreateManagementRegistrationCode(r.Context(), userID, managementOperatorName(r.Context()), now)
	if err != nil {
		if errors.Is(err, registration.ErrRegistrationOwnerInvalid) {
			writeError(w, http.StatusBadRequest, "invalid_user_id", "target account must exist and be active")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "registration code creation failed")
		return
	}
	writeCreated(w, api.withCreateRegistrationInstallLinks(r, resp))
}

func (api *ManagementAPI) getRegistrationCode(w http.ResponseWriter, r *http.Request, userID string) {
	overview, err := api.store.UserCollectorsOverview(r.Context(), userID, api.receivedAt(), defaultOnlineThreshold)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "registration code query failed")
		return
	}
	writeJSON(w, http.StatusOK, api.withRegistrationCodeInstallLinks(r, overview.RegistrationCode))
}

func (api *ManagementAPI) receivedAt() time.Time {
	if api.now == nil {
		return time.Now().UTC()
	}
	return api.now().UTC()
}

type registrationCodeSummaryResponse struct {
	management.RegistrationCodeSummary
	InstallURL       string `json:"install_url,omitempty"`
	InstallScriptURL string `json:"install_script_url,omitempty"`
	InstallCommand   string `json:"install_command,omitempty"`
}

type collectorsOverviewResponse struct {
	SchemaVersion          string                          `json:"schema_version"`
	ServerTime             time.Time                       `json:"server_time"`
	OnlineThresholdSeconds int                             `json:"online_threshold_seconds"`
	RegistrationCode       registrationCodeSummaryResponse `json:"registration_code"`
	Summary                management.CollectorSummary     `json:"summary"`
	Collectors             []management.CollectorItem      `json:"collectors"`
}

type createRegistrationCodeResponse struct {
	management.CreateRegistrationCodeResponse
	InstallURL               string `json:"install_url,omitempty"`
	InstallScriptURL         string `json:"install_script_url,omitempty"`
	InstallCommand           string `json:"install_command,omitempty"`
	InstallPowerShellCommand string `json:"install_powershell_command,omitempty"`
}

type RegistrationCodeDetailResponse struct {
	Exists                   bool       `json:"exists"`
	RegistrationCode         string     `json:"registration_code,omitempty"`
	CreatedBy                string     `json:"created_by,omitempty"`
	CreatedAt                *time.Time `json:"created_at,omitempty"`
	ExpiresAt                *time.Time `json:"expires_at,omitempty"`
	UsedCount                int        `json:"used_count"`
	LastUsedAt               *time.Time `json:"last_used_at,omitempty"`
	Revoked                  bool       `json:"revoked"`
	InstallURL               string     `json:"install_url,omitempty"`
	InstallScriptURL         string     `json:"install_script_url,omitempty"`
	InstallCommand           string     `json:"install_command,omitempty"`
	InstallPowerShellCommand string     `json:"install_powershell_command,omitempty"`
}

func (api *ManagementAPI) withOverviewInstallLinks(r *http.Request, overview management.CollectorsOverview) collectorsOverviewResponse {
	overview.RegistrationCode.Code = ""
	resp := collectorsOverviewResponse{
		SchemaVersion:          overview.SchemaVersion,
		ServerTime:             overview.ServerTime,
		OnlineThresholdSeconds: overview.OnlineThresholdSeconds,
		RegistrationCode: registrationCodeSummaryResponse{
			RegistrationCodeSummary: overview.RegistrationCode,
		},
		Summary:    overview.Summary,
		Collectors: overview.Collectors,
	}
	return resp
}

func (api *ManagementAPI) withCreateRegistrationInstallLinks(r *http.Request, resp management.CreateRegistrationCodeResponse) createRegistrationCodeResponse {
	out := createRegistrationCodeResponse{CreateRegistrationCodeResponse: resp}
	out.InstallURL, out.InstallScriptURL, out.InstallCommand = api.installLinks(r, resp.RegistrationCode)
	powerShellURL := api.installBaseURL(r) + "/office/collectors/install.ps1?code=" + url.QueryEscape(resp.RegistrationCode)
	out.InstallPowerShellCommand = "irm " + powerShellSingleQuote(powerShellURL) + " | iex"
	return out
}

func (api *ManagementAPI) withRegistrationCodeInstallLinks(r *http.Request, summary management.RegistrationCodeSummary) RegistrationCodeDetailResponse {
	out := RegistrationCodeDetailResponse{
		Exists:           summary.Exists,
		RegistrationCode: summary.Code,
		CreatedBy:        summary.CreatedBy,
		CreatedAt:        summary.CreatedAt,
		ExpiresAt:        summary.ExpiresAt,
		UsedCount:        summary.UsedCount,
		LastUsedAt:       summary.LastUsedAt,
		Revoked:          summary.Revoked,
	}
	if summary.Code == "" {
		return out
	}
	out.InstallURL, out.InstallScriptURL, out.InstallCommand = api.installLinks(r, summary.Code)
	powerShellURL := api.installBaseURL(r) + "/office/collectors/install.ps1?code=" + url.QueryEscape(summary.Code)
	out.InstallPowerShellCommand = "irm " + powerShellSingleQuote(powerShellURL) + " | iex"
	return out
}

func (api *ManagementAPI) EnsureAccountRegistrationCode(r *http.Request, userID, createdBy string) (RegistrationCodeDetailResponse, error) {
	summary, err := api.store.EnsureManagementRegistrationCode(r.Context(), userID, createdBy, api.receivedAt())
	if err != nil {
		return RegistrationCodeDetailResponse{}, err
	}
	return api.withRegistrationCodeInstallLinks(r, summary), nil
}

func (api *ManagementAPI) installLinks(r *http.Request, code string) (string, string, string) {
	baseURL := api.installBaseURL(r)
	encodedCode := url.QueryEscape(code)
	installURL := baseURL + "/office/collectors/install?code=" + encodedCode
	scriptURL := baseURL + "/office/collectors/install.sh?code=" + encodedCode
	return installURL, scriptURL, "curl -fsSL " + shellQuote(scriptURL) + " | sh"
}

func (api *ManagementAPI) installBaseURL(r *http.Request) string {
	if api.publicBaseURL != "" {
		return api.publicBaseURL
	}
	return requestBaseURL(r)
}
