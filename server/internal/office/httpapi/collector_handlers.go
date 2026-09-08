package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/krillinai/Clawee/server/internal/agentprovisioning"
	"github.com/krillinai/Clawee/server/internal/office/auth"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/dashboard"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/office/registration"
)

const maxCollectorBodyBytes int64 = 1 << 20

type CollectorIdentity struct {
	CollectorID string
	UserID      string
}

type Authenticator interface {
	Authenticate(context.Context, string) (CollectorIdentity, bool, error)
}

type Reducer interface {
	ApplyHeartbeat(context.Context, collectorapi.HeartbeatRequest, time.Time) error
	ApplyEvents(context.Context, collectorapi.EventsRequest, time.Time) (int, error)
}

type DashboardNotifier interface {
	NotifyCollectorWriteApplied(context.Context, string, []dashboard.CollectorChange)
}

type Registrar interface {
	RegisterCollector(context.Context, collectorapi.RegistrationRequest, time.Time) (collectorapi.RegistrationResponse, error)
}

type AgentProvisioner interface {
	EnsureOwnedAgent(context.Context, agentprovisioning.EnsureRequest) (agentprovisioning.EnsureResult, error)
}

type AgentBinder interface {
	BindMCPAgent(context.Context, string, string, string, time.Time) error
}

type Clock func() time.Time

type CollectorAPI struct {
	authenticator     Authenticator
	reducer           Reducer
	registrar         Registrar
	now               Clock
	dashboardNotifier DashboardNotifier
	agentProvisioner  AgentProvisioner
	agentBinder       AgentBinder
	taskBroker        TaskBroker
}

type CollectorAPIOptions struct {
	Authenticator     Authenticator
	Reducer           Reducer
	Registrar         Registrar
	Now               Clock
	DashboardNotifier DashboardNotifier
	AgentProvisioner  AgentProvisioner
	AgentBinder       AgentBinder
	TaskBroker        TaskBroker
}

func NewCollectorAPI(authenticator Authenticator, reducer Reducer, registrar Registrar, now Clock) *CollectorAPI {
	return NewCollectorAPIWithOptions(CollectorAPIOptions{
		Authenticator: authenticator,
		Reducer:       reducer,
		Registrar:     registrar,
		Now:           now,
	})
}

func NewCollectorAPIWithNotifier(authenticator Authenticator, reducer Reducer, registrar Registrar, now Clock, dashboardNotifier DashboardNotifier) *CollectorAPI {
	return NewCollectorAPIWithOptions(CollectorAPIOptions{
		Authenticator:     authenticator,
		Reducer:           reducer,
		Registrar:         registrar,
		Now:               now,
		DashboardNotifier: dashboardNotifier,
	})
}

func NewCollectorAPIWithOptions(opts CollectorAPIOptions) *CollectorAPI {
	return &CollectorAPI{
		authenticator:     opts.Authenticator,
		reducer:           opts.Reducer,
		registrar:         opts.Registrar,
		now:               opts.Now,
		dashboardNotifier: opts.DashboardNotifier,
		agentProvisioner:  opts.AgentProvisioner,
		agentBinder:       opts.AgentBinder,
		taskBroker:        opts.TaskBroker,
	}
}

func (api *CollectorAPI) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/collector/register", api.handleRegister)
	mux.HandleFunc("/api/v1/collector/heartbeat", api.handleHeartbeat)
	mux.HandleFunc("/api/v1/collector/events", api.handleEvents)
	mux.HandleFunc("/api/v1/collector/tasks/pull", api.handleTaskPull)
	mux.HandleFunc("/api/v1/collector/tasks/result", api.handleTaskResult)
	return mux
}

func (api *CollectorAPI) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}

	var req collectorapi.RegistrationRequest
	if !decodeCollectorRequest(w, r, &req) {
		return
	}
	if req.SchemaVersion != collectorapi.SchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_schema_version", "schema_version must be collector.v1")
		return
	}
	if req.RegistrationCode == "" {
		writeError(w, http.StatusUnauthorized, "invalid_registration_code", "registration code is invalid")
		return
	}
	req.AgentID = strings.TrimSpace(req.AgentID)
	if req.AgentID == "" || utf8.RuneCountInString(req.AgentID) > 64 {
		writeError(w, http.StatusBadRequest, "invalid_agent_id", "agent_id is invalid")
		return
	}
	if req.OS == "" || req.Arch == "" || req.CollectorVersion == "" {
		writeError(w, http.StatusBadRequest, "invalid_device", "os, arch, and collector_version are required")
		return
	}
	if api.registrar == nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "collector registration is unavailable")
		return
	}

	resp, err := api.registrar.RegisterCollector(r.Context(), req, api.receivedAt())
	if err != nil {
		AttachRequestError(r, err)
		writeRegistrationError(w, err)
		return
	}
	writeCreated(w, resp)
}

func (api *CollectorAPI) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	identity, ok := api.authenticate(w, r)
	if !ok {
		return
	}

	var req collectorapi.HeartbeatRequest
	if !decodeCollectorRequest(w, r, &req) {
		return
	}
	for i := range req.Agents {
		req.Agents[i].AgentID = strings.TrimSpace(req.Agents[i].AgentID)
		req.Agents[i].DisplayName = ""
	}
	if !validateCollectorRequest(w, identity, req.SchemaVersion, req.CollectorID, req.DeviceID) {
		return
	}

	receivedAt := api.receivedAt()
	agents, err := api.ensureCollectorAgents(r.Context(), identity, heartbeatCollectorAgents(req.Agents))
	if err != nil {
		AttachRequestError(r, err)
		writeAgentProvisioningError(w, err)
		return
	}
	if err := api.reducer.ApplyHeartbeat(r.Context(), req, receivedAt); err != nil {
		AttachRequestError(r, err)
		writeError(w, http.StatusInternalServerError, "internal_error", "failed to apply heartbeat")
		return
	}
	if err := api.bindCollectorAgents(r.Context(), req.CollectorID, agents, receivedAt); err != nil {
		AttachRequestError(r, err)
		writeCollectorAgentBindingError(w, err)
		return
	}
	changes := make([]dashboard.CollectorChange, 0, len(req.Agents))
	for _, agent := range req.Agents {
		changes = append(changes, dashboard.CollectorChange{AgentID: agent.AgentID})
	}
	api.notifyCollectorWriteApplied(r.Context(), req.CollectorID, changes)
	writeAccepted(w, collectorapi.AcceptedResponse{
		Accepted:       true,
		ServerTime:     receivedAt,
		ReceivedAgents: len(req.Agents),
	})
}

func (api *CollectorAPI) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	identity, ok := api.authenticate(w, r)
	if !ok {
		return
	}

	var req collectorapi.EventsRequest
	if !decodeCollectorRequest(w, r, &req) {
		return
	}
	for i := range req.Events {
		req.Events[i].AgentID = strings.TrimSpace(req.Events[i].AgentID)
	}
	if !validateCollectorRequest(w, identity, req.SchemaVersion, req.CollectorID, req.DeviceID) {
		return
	}
	if !validateCollectorEvents(w, req.Events) {
		return
	}

	receivedAt := api.receivedAt()
	agents, err := api.ensureCollectorAgents(r.Context(), identity, eventCollectorAgents(req.Events))
	if err != nil {
		AttachRequestError(r, err)
		writeAgentProvisioningError(w, err)
		return
	}
	count, err := api.reducer.ApplyEvents(r.Context(), req, receivedAt)
	if err != nil {
		AttachRequestError(r, err)
		writeError(w, http.StatusInternalServerError, "internal_error", "failed to apply events")
		return
	}
	if err := api.bindCollectorAgents(r.Context(), req.CollectorID, agents, receivedAt); err != nil {
		AttachRequestError(r, err)
		writeCollectorAgentBindingError(w, err)
		return
	}
	changes := make([]dashboard.CollectorChange, 0, len(req.Events))
	for _, event := range req.Events {
		changes = append(changes, collectorChangeFromEvent(event))
	}
	api.notifyCollectorWriteApplied(r.Context(), req.CollectorID, changes)
	writeAccepted(w, collectorapi.AcceptedResponse{
		Accepted:       true,
		ServerTime:     receivedAt,
		ReceivedEvents: count,
	})
}

type collectorAgentCandidate struct {
	agentID  string
	clientID string
}

func heartbeatCollectorAgents(agents []collectorapi.AgentSummary) []collectorAgentCandidate {
	candidates := make([]collectorAgentCandidate, 0, len(agents))
	for _, agent := range agents {
		candidates = append(candidates, collectorAgentCandidate{
			agentID:  agent.AgentID,
			clientID: string(agent.AgentType),
		})
	}
	return uniqueCollectorAgentCandidates(candidates)
}

func eventCollectorAgents(events []collectorapi.CollectorEvent) []collectorAgentCandidate {
	candidates := make([]collectorAgentCandidate, 0, len(events))
	for _, event := range events {
		candidates = append(candidates, collectorAgentCandidate{
			agentID:  event.AgentID,
			clientID: string(event.AgentType),
		})
	}
	return uniqueCollectorAgentCandidates(candidates)
}

func uniqueCollectorAgentCandidates(candidates []collectorAgentCandidate) []collectorAgentCandidate {
	seen := make(map[string]struct{}, len(candidates))
	unique := make([]collectorAgentCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		key := strings.TrimSpace(candidate.agentID)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, candidate)
	}
	return unique
}

func (api *CollectorAPI) ensureCollectorAgents(ctx context.Context, identity CollectorIdentity, candidates []collectorAgentCandidate) ([]collectorAgentCandidate, error) {
	if api.agentProvisioner == nil && api.agentBinder == nil {
		return nil, nil
	}
	if api.agentProvisioner == nil || api.agentBinder == nil {
		return nil, errors.New("collector agent provisioning is unavailable")
	}
	for _, candidate := range candidates {
		if _, err := api.agentProvisioner.EnsureOwnedAgent(ctx, agentprovisioning.EnsureRequest{
			UserID:   identity.UserID,
			AgentID:  candidate.agentID,
			ClientID: candidate.clientID,
			Source:   agentprovisioning.SourceCollector,
		}); err != nil {
			return nil, err
		}
	}
	return candidates, nil
}

func (api *CollectorAPI) bindCollectorAgents(ctx context.Context, collectorID string, candidates []collectorAgentCandidate, receivedAt time.Time) error {
	for _, candidate := range candidates {
		if err := api.agentBinder.BindMCPAgent(ctx, collectorID, candidate.agentID, candidate.agentID, receivedAt); err != nil {
			return err
		}
	}
	return nil
}

func (api *CollectorAPI) authenticate(w http.ResponseWriter, r *http.Request) (CollectorIdentity, bool) {
	token, ok := auth.BearerToken(r.Header.Get("Authorization"))
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "collector token is required")
		return CollectorIdentity{}, false
	}

	identity, ok, err := api.authenticator.Authenticate(r.Context(), token)
	if err != nil {
		AttachRequestError(r, err)
		writeError(w, http.StatusInternalServerError, "internal_error", "collector authentication failed")
		return CollectorIdentity{}, false
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "collector token is invalid")
		return CollectorIdentity{}, false
	}
	return identity, true
}

func (api *CollectorAPI) receivedAt() time.Time {
	if api.now == nil {
		return time.Now().UTC()
	}
	return api.now().UTC()
}

func requirePost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodPost {
		return true
	}
	w.Header().Set("Allow", http.MethodPost)
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method must be POST")
	return false
}

func decodeCollectorRequest(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.ContentLength > maxCollectorBodyBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "collector payload is too large")
		return false
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxCollectorBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		if isCollectorBodyTooLarge(err) {
			writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "collector payload is too large")
			return false
		}
		writeError(w, http.StatusBadRequest, "invalid_json", "request body must be valid json")
		return false
	}

	if err := json.Unmarshal(body, dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body must be valid json")
		return false
	}
	return true
}

func isCollectorBodyTooLarge(err error) bool {
	var maxBytesErr *http.MaxBytesError
	return errors.As(err, &maxBytesErr)
}

func validateCollectorRequest(w http.ResponseWriter, identity CollectorIdentity, schemaVersion string, collectorID string, deviceID string) bool {
	if schemaVersion != collectorapi.SchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_schema_version", "schema_version must be collector.v1")
		return false
	}
	if collectorID == "" {
		writeError(w, http.StatusBadRequest, "invalid_collector_id", "collector_id is required")
		return false
	}
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "invalid_device_id", "device_id is required")
		return false
	}
	if identity.CollectorID != collectorID {
		writeError(w, http.StatusForbidden, "collector_mismatch", "collector_id does not match bearer token")
		return false
	}
	return true
}

func validateCollectorEvents(w http.ResponseWriter, events []collectorapi.CollectorEvent) bool {
	for _, event := range events {
		if event.EventID == "" {
			writeError(w, http.StatusBadRequest, "invalid_event_id", "event_id is required")
			return false
		}
		if event.EventType == "" {
			writeError(w, http.StatusBadRequest, "invalid_event_type", "event_type is required")
			return false
		}
		if event.OccurredAt.IsZero() {
			writeError(w, http.StatusBadRequest, "invalid_occurred_at", "occurred_at is required")
			return false
		}
		if event.AgentID == "" {
			writeError(w, http.StatusBadRequest, "invalid_agent_id", "agent_id is required")
			return false
		}
	}
	return true
}

func writeRegistrationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, registration.ErrInvalidRegistrationCode):
		writeError(w, http.StatusUnauthorized, "invalid_registration_code", "registration code is invalid")
	case errors.Is(err, registration.ErrRegistrationCodeExpired):
		writeError(w, http.StatusUnauthorized, "registration_code_expired", "registration code is expired")
	case errors.Is(err, registration.ErrRegistrationCodeRevoked):
		writeError(w, http.StatusUnauthorized, "registration_code_revoked", "registration code is revoked")
	case errors.Is(err, registration.ErrRegistrationOwnerInvalid):
		writeError(w, http.StatusUnauthorized, "invalid_registration_code", "registration code is invalid")
	case errors.Is(err, registration.ErrAgentIDConflict):
		writeError(w, http.StatusConflict, "agent_id_conflict", "agent_id belongs to another account")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "collector registration failed")
	}
}

func writeAgentProvisioningError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, agentprovisioning.ErrInvalidAgentID):
		writeError(w, http.StatusBadRequest, "invalid_agent_id", "agent_id is invalid")
	case errors.Is(err, agentprovisioning.ErrAgentIDConflict):
		writeError(w, http.StatusConflict, "agent_id_conflict", "agent_id belongs to another account")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "failed to provision agent")
	}
}

func writeCollectorAgentBindingError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, management.ErrOfficeAgentAlreadyBound),
		errors.Is(err, management.ErrMCPAgentAlreadyBound),
		errors.Is(err, management.ErrAgentOwnerMismatch):
		writeError(w, http.StatusConflict, "agent_binding_conflict", "agent binding conflicts with an existing association")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "failed to bind agent")
	}
}

func (api *CollectorAPI) notifyCollectorWriteApplied(ctx context.Context, collectorID string, changes []dashboard.CollectorChange) {
	if api.dashboardNotifier == nil {
		return
	}
	merged := make(map[string]dashboard.CollectorChange)
	order := make([]string, 0, len(changes))
	for _, change := range changes {
		if change.AgentID == "" {
			continue
		}
		if _, exists := merged[change.AgentID]; !exists {
			order = append(order, change.AgentID)
		}
		current := merged[change.AgentID]
		current.AgentID = change.AgentID
		if change.SubAgentID != "" {
			current.SubAgentID = change.SubAgentID
		}
		if change.ActivityID != "" {
			current.ActivityID = change.ActivityID
		}
		current.SubAgentIDs = mergeChangeIDs(current.SubAgentIDs, change.SubAgentIDs, "")
		if change.HasSubAgentChange {
			current.SubAgentIDs = mergeChangeIDs(current.SubAgentIDs, nil, change.SubAgentID)
		}
		current.ActivityStartedIDs = mergeChangeIDs(current.ActivityStartedIDs, change.ActivityStartedIDs, "")
		if change.HasActivityStarted {
			current.ActivityStartedIDs = mergeChangeIDs(current.ActivityStartedIDs, nil, change.ActivityID)
		}
		current.ActivityCompletedIDs = mergeChangeIDs(current.ActivityCompletedIDs, change.ActivityCompletedIDs, "")
		if change.HasActivityCompleted {
			current.ActivityCompletedIDs = mergeChangeIDs(current.ActivityCompletedIDs, nil, change.ActivityID)
		}
		if change.SessionID != "" {
			current.SessionID = change.SessionID
		}
		if change.TurnID != "" {
			current.TurnID = change.TurnID
		}
		current.SessionIDs = mergeChangeIDs(current.SessionIDs, change.SessionIDs, "")
		if change.HasSessionChange {
			current.SessionIDs = mergeChangeIDs(current.SessionIDs, nil, change.SessionID)
		}
		current.TurnIDs = mergeChangeIDs(current.TurnIDs, change.TurnIDs, "")
		if change.HasTurnChange {
			current.TurnIDs = mergeChangeIDs(current.TurnIDs, nil, change.TurnID)
		}
		current.CompletedTurnIDs = mergeChangeIDs(current.CompletedTurnIDs, change.CompletedTurnIDs, "")
		if change.HasTurnCompleted {
			current.CompletedTurnIDs = mergeChangeIDs(current.CompletedTurnIDs, nil, change.TurnID)
		}
		current.HasSubAgentChange = current.HasSubAgentChange || change.HasSubAgentChange
		current.HasActivityStarted = current.HasActivityStarted || change.HasActivityStarted
		current.HasActivityCompleted = current.HasActivityCompleted || change.HasActivityCompleted
		current.HasSessionChange = current.HasSessionChange || change.HasSessionChange
		current.HasTurnChange = current.HasTurnChange || change.HasTurnChange
		current.HasTurnCompleted = current.HasTurnCompleted || change.HasTurnCompleted
		current.RequiresSnapshot = current.RequiresSnapshot || change.RequiresSnapshot
		merged[change.AgentID] = current
	}
	unique := make([]dashboard.CollectorChange, 0, len(order))
	for _, agentID := range order {
		unique = append(unique, merged[agentID])
	}
	if len(unique) == 0 {
		return
	}
	api.dashboardNotifier.NotifyCollectorWriteApplied(ctx, collectorID, unique)
}

func collectorChangeFromEvent(event collectorapi.CollectorEvent) dashboard.CollectorChange {
	change := dashboard.CollectorChange{
		AgentID:   event.AgentID,
		SessionID: event.SessionID,
		TurnID:    event.TurnID,
	}
	if event.SubAgentID != nil {
		change.SubAgentID = *event.SubAgentID
	}
	if event.Activity != nil {
		change.ActivityID = event.Activity.ActivityID
	}
	switch event.EventType {
	case collectorapi.EventSubAgentCreated, collectorapi.EventSubAgentStatusChanged, collectorapi.EventSubAgentCompleted:
		change.HasSubAgentChange = true
		if change.SubAgentID != "" {
			change.SubAgentIDs = []string{change.SubAgentID}
		}
	case collectorapi.EventActivityStarted:
		change.HasActivityStarted = true
		if change.ActivityID != "" {
			change.ActivityStartedIDs = []string{change.ActivityID}
		}
	case collectorapi.EventActivityCompleted, collectorapi.EventToolCallCompleted, collectorapi.EventToolCallFailed, collectorapi.EventAgentError:
		change.HasActivityCompleted = true
		if change.ActivityID != "" {
			change.ActivityCompletedIDs = []string{change.ActivityID}
		}
	case collectorapi.EventSessionStarted, collectorapi.EventSessionUpdated, collectorapi.EventSessionCompleted:
		change.HasSessionChange = true
		if event.SessionID != "" {
			change.SessionIDs = []string{event.SessionID}
		}
	case collectorapi.EventTurnStarted, collectorapi.EventTurnUpdated:
		change.HasTurnChange = true
		if event.TurnID != "" {
			change.TurnIDs = []string{event.TurnID}
		}
	case collectorapi.EventTurnCompleted:
		change.HasTurnCompleted = true
		if event.TurnID != "" {
			change.CompletedTurnIDs = []string{event.TurnID}
		}
	}
	return change
}

func mergeChangeIDs(existing []string, incoming []string, single string) []string {
	seen := make(map[string]bool, len(existing)+len(incoming)+1)
	out := make([]string, 0, len(existing)+len(incoming)+1)
	for _, id := range existing {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	for _, id := range incoming {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	if single != "" && !seen[single] {
		out = append(out, single)
	}
	return out
}
