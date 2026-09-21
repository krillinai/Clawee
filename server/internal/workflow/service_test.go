package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
)

func TestObjectAndCursorValidation(t *testing.T) {
	for _, raw := range []string{`[]`, `null`, `"text"`, `{broken`} {
		if _, err := object(json.RawMessage(raw)); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: %v", raw, err)
		}
	}
	if _, err := object(json.RawMessage(`{"value":1}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := object(json.RawMessage(`{"value":"` + strings.Repeat("x", 1<<20) + `"}`)); !errors.Is(err, ErrLarge) {
		t.Fatal(err)
	}
	if _, _, _, err := page(51, ""); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if _, _, _, err := page(20, "broken"); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}

func workflowTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := testpostgres.New(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = pool.Exec(context.Background(), `INSERT INTO accounts (user_id,email,name,password_hash,status,created_at,updated_at) VALUES
		('a','a@workflow.test','A','test','active',now(),now()),
		('b','b@workflow.test','B','test','active',now(),now()),
		('c','c@workflow.test','C','test','active',now(),now()),
		('other','other@workflow.test','Other','test','active',now(),now())`)
	if err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestWorkflowSerialLifecycle(t *testing.T) {
	s := &Service{DB: workflowTestDB(t)}
	ctx := context.Background()
	nodes := []Node{{ID: "first", Order: 0, Type: "agent", Title: "生成", Assignee: "a", Instruction: "生成"}, {ID: "review", Order: 1, Type: "approval", Title: "审核", Assignee: "b", Instruction: "审核"}, {ID: "last", Order: 2, Type: "agent", Title: "收尾", Assignee: "c", Instruction: "收尾"}}
	template, err := s.Save(ctx, "a", "", "案例", "", 0, nodes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Save(ctx, "a", template.ID, "案例", "", 0, nodes); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision: %v", err)
	}
	if _, err = s.Start(ctx, template.ID, "other", "unrelated", json.RawMessage(`{}`)); !errors.Is(err, ErrMissing) {
		t.Fatalf("non-participant start: %v", err)
	}
	if _, err = s.Start(ctx, template.ID, "a", "start", json.RawMessage(`{}`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("draft start: %v", err)
	}
	_, err = s.SetStatus(ctx, template.ID, "a", true)
	if err != nil {
		t.Fatal(err)
	}
	start, err := s.Start(ctx, template.ID, "a", "start", json.RawMessage(`{"text":"input"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Instance(ctx, start.InstanceID, "other", false); !errors.Is(err, ErrMissing) {
		t.Fatalf("non-participant: %v", err)
	}
	_, err = s.SetStatus(ctx, template.ID, "a", false)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := s.Start(ctx, template.ID, "a", "start", json.RawMessage(`{"text":"input"}`))
	if err != nil || retry != start {
		t.Fatalf("start replay: %+v %v", retry, err)
	}
	if _, err = s.Start(ctx, template.ID, "a", "start", json.RawMessage(`{"text":"other"}`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed start: %v", err)
	}
	newNodes := append([]Node(nil), nodes...)
	newNodes[1].Instruction = "新审核"
	_, err = s.Save(ctx, "a", template.ID, "案例新版", "", template.Revision, newNodes)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.Task(ctx, start.TaskID, "a", "agent")
	if err != nil || string(first.Input) != `{"text": "input"}` && string(first.Input) != `{"text":"input"}` {
		t.Fatalf("first input: %+v %v", first, err)
	}
	result, err := s.Complete(ctx, start.TaskID, "a", "agent-a", "complete-1", "", "", json.RawMessage(`{"text":"output"}`))
	if err != nil {
		t.Fatal(err)
	}
	if result.NextTask == nil || result.NextTask.Assignee != "b" {
		t.Fatalf("next: %+v", result)
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			replayed, e := s.Complete(ctx, start.TaskID, "a", "agent-a", "complete-1", "", "", json.RawMessage(`{"text":"output"}`))
			if e != nil || replayed.NextTask == nil || replayed.NextTask.ID != result.NextTask.ID {
				t.Errorf("replay: %+v %v", replayed, e)
			}
		}()
	}
	wg.Wait()
	if _, err = s.Complete(ctx, start.TaskID, "a", "agent-a", "new-key", "", "", json.RawMessage(`{"text":"output"}`)); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	review, err := s.Task(ctx, result.NextTask.ID, "b", "approval")
	if err != nil || review.Instruction != "审核" || string(review.Input) != `{"text": "output"}` && string(review.Input) != `{"text":"output"}` {
		t.Fatalf("snapshot/input: %+v %v", review, err)
	}
	approved, err := s.Complete(ctx, review.ID, "b", "", "approve", "approve", "ok", nil)
	if err != nil {
		t.Fatal(err)
	}
	last, err := s.Task(ctx, approved.NextTask.ID, "c", "agent")
	if err != nil || string(last.Input) != string(review.Input) {
		t.Fatalf("approval passthrough: %+v %v", last, err)
	}
	final, err := s.Complete(ctx, last.ID, "c", "agent-c", "last", "", "", json.RawMessage(`{"done":true}`))
	if err != nil || final.Status != "succeeded" {
		t.Fatalf("final: %+v %v", final, err)
	}
	instance, err := s.Instance(ctx, start.InstanceID, "b", false)
	if err != nil || len(instance.Tasks) != 3 || instance.Nodes[1].Instruction != "审核" {
		t.Fatalf("detail: %+v %v", instance, err)
	}
}

func TestWorkflowTaskPagination(t *testing.T) {
	s := &Service{DB: workflowTestDB(t)}
	ctx := context.Background()
	nodes := []Node{{ID: "first", Order: 0, Type: "agent", Title: "生成", Assignee: "a", Instruction: "生成"}}
	template, err := s.Save(ctx, "a", "", "分页", "", 0, nodes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetStatus(ctx, template.ID, "a", true); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, 21)
	for i := 0; i < 21; i++ {
		result, startErr := s.Start(ctx, template.ID, "a", fmt.Sprintf("start-%d", i), json.RawMessage(`{}`))
		if startErr != nil {
			t.Fatal(startErr)
		}
		ids = append(ids, result.TaskID)
	}
	first, cursor, err := s.Tasks(ctx, "a", "agent", 20, "")
	if err != nil || len(first) != 20 || cursor == "" {
		t.Fatalf("first page: %d, %q, %v", len(first), cursor, err)
	}
	second, next, err := s.Tasks(ctx, "a", "agent", 20, cursor)
	if err != nil || len(second) != 1 || next != "" {
		t.Fatalf("second page: %d, %q, %v", len(second), next, err)
	}
	if first[0].ID != ids[20] || second[0].ID != ids[0] {
		t.Fatalf("unexpected task order: first=%s last=%s", first[0].ID, second[0].ID)
	}
	for _, task := range first {
		if task.ID == second[0].ID {
			t.Fatal("duplicate task across pages")
		}
	}
}

func TestWorkflowRejectAndTerminate(t *testing.T) {
	s := &Service{DB: workflowTestDB(t)}
	ctx := context.Background()
	nodes := []Node{{ID: "review", Order: 0, Type: "approval", Title: "审核", Assignee: "a", Instruction: "审核"}, {ID: "agent", Order: 1, Type: "agent", Title: "执行", Assignee: "b", Instruction: "执行"}}
	tpl, err := s.Save(ctx, "a", "", "审查", "", 0, nodes)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.SetStatus(ctx, tpl.ID, "a", true)
	if err != nil {
		t.Fatal(err)
	}
	one, err := s.Start(ctx, tpl.ID, "a", "one", nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := s.Complete(ctx, one.TaskID, "a", "", "reject", "reject", "原因", nil)
	if err != nil || result.Status != "rejected" || result.NextTask != nil {
		t.Fatalf("reject: %+v %v", result, err)
	}
	instance, err := s.Instance(ctx, one.InstanceID, "b", false)
	if err != nil || len(instance.Tasks) != 1 {
		t.Fatalf("reject detail: %+v %v", instance, err)
	}
	two, err := s.Start(ctx, tpl.ID, "a", "two", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Terminate(ctx, two.InstanceID, "a", "取消"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Complete(ctx, two.TaskID, "a", "", "key", "approve", "", nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("submit terminated: %v", err)
	}
	if err = s.Terminate(ctx, two.InstanceID, "a", "再次取消"); !errors.Is(err, ErrConflict) {
		t.Fatalf("terminate twice: %v", err)
	}
}
