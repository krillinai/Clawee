package server_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accountgovernance"
	"github.com/krillinai/Clawee/server/internal/server"
)

type governanceHTTPStore struct {
	transferInput accountgovernance.TransferAgentInput
	mergeInput    accountgovernance.MergeAccountsInput
	err           error
}

func (s *governanceHTTPStore) TransferAgent(_ context.Context, input accountgovernance.TransferAgentInput) (accountgovernance.Result, error) {
	s.transferInput = input
	return accountgovernance.Result{
		Action: accountgovernance.ActionAgentTransfer, AgentIDs: []string{input.AgentID},
		SourceUserID: input.SourceUserID, TargetUserID: input.TargetUserID,
		TokensPreserved: true, GrantsPreserved: true, TokenCount: 1, GrantCount: 2, CompletedAt: time.Now().UTC(),
	}, s.err
}

func (s *governanceHTTPStore) MergeAccounts(_ context.Context, input accountgovernance.MergeAccountsInput) (accountgovernance.Result, error) {
	s.mergeInput = input
	return accountgovernance.Result{
		Action: accountgovernance.ActionAccountMerge, SourceUserID: input.SourceUserID, TargetUserID: input.TargetUserID,
		TokensPreserved: true, GrantsPreserved: true, CompletedAt: time.Now().UTC(),
	}, s.err
}

func TestAccountGovernanceRoutesPreserveAccessAndRecordOperator(t *testing.T) {
	store := &governanceHTTPStore{}
	router := newTestRouter(t, server.Options{AccountGovernanceService: accountgovernance.NewService(store)})
	adminUserID := testAdminUserID(t, router)

	transfer := doJSON(t, router, http.MethodPost, "/api/v1/admin/mcp/agents/transfer", `{
		"agent_id":"agent-1","source_user_id":"user-source","target_user_id":"user-target","reason":"duplicate account"
	}`, nil, http.StatusOK)
	data := transfer["data"].(map[string]any)
	if data["tokens_preserved"] != true || data["grants_preserved"] != true {
		t.Fatalf("transfer response = %#v", transfer)
	}
	if store.transferInput.OperatorUserID != adminUserID || store.transferInput.RequestID == "" {
		t.Fatalf("transfer audit context = %+v", store.transferInput)
	}

	merge := doJSON(t, router, http.MethodPost, "/api/v1/admin/accounts/merge", `{
		"source_user_id":"user-source","target_user_id":"user-target","reason":"duplicate account"
	}`, nil, http.StatusOK)
	data = merge["data"].(map[string]any)
	if data["tokens_preserved"] != true || data["grants_preserved"] != true {
		t.Fatalf("merge response = %#v", merge)
	}
	if store.mergeInput.OperatorUserID != adminUserID || store.mergeInput.RequestID == "" {
		t.Fatalf("merge audit context = %+v", store.mergeInput)
	}
}

func TestAccountGovernanceRouteMapsStateConflict(t *testing.T) {
	store := &governanceHTTPStore{err: accountgovernance.ErrPendingGate}
	router := newTestRouter(t, server.Options{AccountGovernanceService: accountgovernance.NewService(store)})
	body := doJSON(t, router, http.MethodPost, "/api/v1/admin/mcp/agents/transfer", `{
		"agent_id":"agent-1","source_user_id":"user-source","target_user_id":"user-target","reason":"duplicate account"
	}`, nil, http.StatusConflict)
	errorBody := body["error"].(map[string]any)
	if errorBody["code"] != "state_conflict" {
		t.Fatalf("error = %#v", errorBody)
	}
}
