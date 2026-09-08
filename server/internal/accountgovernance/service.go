package accountgovernance

import (
	"context"
	"strings"
)

const maxReasonLength = 500

type Store interface {
	TransferAgent(context.Context, TransferAgentInput) (Result, error)
	MergeAccounts(context.Context, MergeAccountsInput) (Result, error)
}

type Service struct {
	store Store
}

func NewService(store Store) *Service {
	return &Service{store: store}
}

func (s *Service) TransferAgent(ctx context.Context, input TransferAgentInput) (Result, error) {
	input.AgentID = strings.TrimSpace(input.AgentID)
	input.SourceUserID = strings.TrimSpace(input.SourceUserID)
	input.TargetUserID = strings.TrimSpace(input.TargetUserID)
	input.Reason = strings.TrimSpace(input.Reason)
	input.OperatorUserID = strings.TrimSpace(input.OperatorUserID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if s == nil || s.store == nil || input.AgentID == "" || !validCommonInput(input.SourceUserID, input.TargetUserID, input.Reason, input.OperatorUserID) {
		return Result{}, ErrInvalidRequest
	}
	if input.SourceUserID == input.TargetUserID {
		return Result{}, ErrSameAccount
	}
	return s.store.TransferAgent(ctx, input)
}

func (s *Service) MergeAccounts(ctx context.Context, input MergeAccountsInput) (Result, error) {
	input.SourceUserID = strings.TrimSpace(input.SourceUserID)
	input.TargetUserID = strings.TrimSpace(input.TargetUserID)
	input.Reason = strings.TrimSpace(input.Reason)
	input.OperatorUserID = strings.TrimSpace(input.OperatorUserID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if s == nil || s.store == nil || !validCommonInput(input.SourceUserID, input.TargetUserID, input.Reason, input.OperatorUserID) {
		return Result{}, ErrInvalidRequest
	}
	if input.SourceUserID == input.TargetUserID {
		return Result{}, ErrSameAccount
	}
	return s.store.MergeAccounts(ctx, input)
}

func validCommonInput(sourceUserID, targetUserID, reason, operatorUserID string) bool {
	return sourceUserID != "" && targetUserID != "" && reason != "" && len([]rune(reason)) <= maxReasonLength && operatorUserID != ""
}
