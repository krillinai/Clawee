package accountgovernance

import (
	"context"
	"errors"
	"testing"
)

type recordingStore struct {
	transferInput TransferAgentInput
	mergeInput    MergeAccountsInput
	err           error
}

func (s *recordingStore) TransferAgent(_ context.Context, input TransferAgentInput) (Result, error) {
	s.transferInput = input
	return Result{Action: ActionAgentTransfer}, s.err
}

func (s *recordingStore) MergeAccounts(_ context.Context, input MergeAccountsInput) (Result, error) {
	s.mergeInput = input
	return Result{Action: ActionAccountMerge}, s.err
}

func TestServiceNormalizesGovernanceInputs(t *testing.T) {
	store := &recordingStore{}
	service := NewService(store)

	if _, err := service.TransferAgent(context.Background(), TransferAgentInput{
		AgentID: " agent-1 ", SourceUserID: " source ", TargetUserID: " target ",
		Reason: " duplicate account ", OperatorUserID: " admin ", RequestID: " request-1 ",
	}); err != nil {
		t.Fatal(err)
	}
	if got := store.transferInput; got.AgentID != "agent-1" || got.SourceUserID != "source" || got.TargetUserID != "target" || got.Reason != "duplicate account" || got.OperatorUserID != "admin" || got.RequestID != "request-1" {
		t.Fatalf("normalized transfer input = %+v", got)
	}

	if _, err := service.MergeAccounts(context.Background(), MergeAccountsInput{
		SourceUserID: " source ", TargetUserID: " target ", Reason: " duplicate ", OperatorUserID: " admin ", RequestID: " request-2 ",
	}); err != nil {
		t.Fatal(err)
	}
	if got := store.mergeInput; got.SourceUserID != "source" || got.TargetUserID != "target" || got.Reason != "duplicate" || got.OperatorUserID != "admin" || got.RequestID != "request-2" {
		t.Fatalf("normalized merge input = %+v", got)
	}
}

func TestServiceRejectsInvalidGovernanceInputs(t *testing.T) {
	service := NewService(&recordingStore{})
	tests := []struct {
		name string
		err  error
		run  func() error
	}{
		{name: "missing agent", err: ErrInvalidRequest, run: func() error {
			_, err := service.TransferAgent(context.Background(), TransferAgentInput{SourceUserID: "source", TargetUserID: "target", Reason: "reason", OperatorUserID: "admin"})
			return err
		}},
		{name: "same transfer account", err: ErrSameAccount, run: func() error {
			_, err := service.TransferAgent(context.Background(), TransferAgentInput{AgentID: "agent", SourceUserID: "same", TargetUserID: "same", Reason: "reason", OperatorUserID: "admin"})
			return err
		}},
		{name: "missing reason", err: ErrInvalidRequest, run: func() error {
			_, err := service.MergeAccounts(context.Background(), MergeAccountsInput{SourceUserID: "source", TargetUserID: "target", OperatorUserID: "admin"})
			return err
		}},
		{name: "same merge account", err: ErrSameAccount, run: func() error {
			_, err := service.MergeAccounts(context.Background(), MergeAccountsInput{SourceUserID: "same", TargetUserID: "same", Reason: "reason", OperatorUserID: "admin"})
			return err
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.run(); !errors.Is(err, test.err) {
				t.Fatalf("error = %v, want %v", err, test.err)
			}
		})
	}
}
