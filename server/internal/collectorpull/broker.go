package collectorpull

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

const maxInFlightPerCollector = 4

const taskTimeout = 10 * time.Minute

var (
	ErrBusy     = errors.New("collector pull upstream is busy")
	ErrConflict = errors.New("collector task state conflict")
	ErrInvalid  = errors.New("invalid collector task")
	ErrNotFound = errors.New("collector task not found")
)

type Submission struct {
	CollectorID      string
	UpstreamServerID string
	TraceID          string
	Tool             string
	Arguments        map[string]any
}

type Completion struct {
	TaskID string
	Status collectorapi.TaskResultStatus
	Output *collectorapi.TaskResultOutput
	Error  *collectorapi.TaskResultError
}

type taskState string

const (
	taskPending taskState = "pending"
	taskClaimed taskState = "claimed"
)

type task struct {
	delivery    collectorapi.TaskDelivery
	collectorID string
	state       taskState
	result      chan Completion
}

type completedTask struct {
	collectorID string
	claimID     string
	completedAt time.Time
}

type Broker struct {
	mu        sync.Mutex
	tasks     map[string]*task
	pending   map[string][]string
	notify    map[string]chan struct{}
	completed map[string]completedTask
	now       func() time.Time
}

func NewBroker() *Broker {
	return &Broker{
		tasks:     map[string]*task{},
		pending:   map[string][]string{},
		notify:    map[string]chan struct{}{},
		completed: map[string]completedTask{},
		now:       time.Now,
	}
}

func (b *Broker) Submit(ctx context.Context, submission Submission) (Completion, error) {
	if strings.TrimSpace(submission.CollectorID) == "" || strings.TrimSpace(submission.UpstreamServerID) == "" || strings.TrimSpace(submission.Tool) == "" {
		return Completion{}, ErrInvalid
	}
	taskID, err := randomID("task_")
	if err != nil {
		return Completion{}, err
	}
	t := &task{
		collectorID: strings.TrimSpace(submission.CollectorID),
		state:       taskPending,
		result:      make(chan Completion, 1),
		delivery: collectorapi.TaskDelivery{
			SchemaVersion:    collectorapi.TaskSchemaVersion,
			TaskID:           taskID,
			TraceID:          strings.TrimSpace(submission.TraceID),
			UpstreamServerID: strings.TrimSpace(submission.UpstreamServerID),
			Tool:             strings.TrimSpace(submission.Tool),
			Arguments:        cloneMap(submission.Arguments),
		},
	}

	b.mu.Lock()
	b.cleanupCompletedLocked()
	if b.inFlightLocked(t.collectorID) >= maxInFlightPerCollector {
		b.mu.Unlock()
		return Completion{}, ErrBusy
	}
	b.tasks[taskID] = t
	b.pending[t.collectorID] = append(b.pending[t.collectorID], taskID)
	b.signalLocked(t.collectorID)
	b.mu.Unlock()

	waitCtx, cancel := context.WithTimeout(ctx, taskTimeout)
	defer cancel()
	select {
	case result := <-t.result:
		return result, nil
	case <-waitCtx.Done():
		b.cancel(taskID)
		return Completion{}, waitCtx.Err()
	}
}

func (b *Broker) Pull(ctx context.Context, collectorID string) (collectorapi.TaskDelivery, bool, error) {
	collectorID = strings.TrimSpace(collectorID)
	if collectorID == "" {
		return collectorapi.TaskDelivery{}, false, ErrInvalid
	}
	for {
		b.mu.Lock()
		if delivery, ok, err := b.claimLocked(collectorID); ok || err != nil {
			b.mu.Unlock()
			return delivery, ok, err
		}
		notify := b.notifyLocked(collectorID)
		b.mu.Unlock()

		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return collectorapi.TaskDelivery{}, false, nil
			}
			return collectorapi.TaskDelivery{}, false, ctx.Err()
		case <-notify:
		}
	}
}

func (b *Broker) Complete(collectorID string, req collectorapi.TaskResultRequest) error {
	collectorID = strings.TrimSpace(collectorID)
	if collectorID == "" || strings.TrimSpace(req.TaskID) == "" || strings.TrimSpace(req.ClaimID) == "" {
		return ErrInvalid
	}
	if req.Status != collectorapi.TaskResultSucceeded && req.Status != collectorapi.TaskResultFailed {
		return ErrInvalid
	}
	if req.Status == collectorapi.TaskResultSucceeded && (req.Output == nil || strings.TrimSpace(req.Output.Answer) == "") {
		return ErrInvalid
	}
	if req.Status == collectorapi.TaskResultFailed && (req.Error == nil || strings.TrimSpace(req.Error.Code) == "") {
		return ErrInvalid
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	b.cleanupCompletedLocked()
	if completed, ok := b.completed[req.TaskID]; ok {
		if completed.collectorID == collectorID && completed.claimID == req.ClaimID {
			return nil
		}
		return ErrConflict
	}
	t, ok := b.tasks[req.TaskID]
	if !ok {
		return ErrNotFound
	}
	if t.collectorID != collectorID || t.state != taskClaimed || t.delivery.ClaimID != req.ClaimID {
		return ErrConflict
	}
	completion := Completion{TaskID: req.TaskID, Status: req.Status, Output: req.Output, Error: req.Error}
	t.result <- completion
	delete(b.tasks, req.TaskID)
	b.completed[req.TaskID] = completedTask{collectorID: collectorID, claimID: req.ClaimID, completedAt: b.now().UTC()}
	return nil
}

func (b *Broker) claimLocked(collectorID string) (collectorapi.TaskDelivery, bool, error) {
	queue := b.pending[collectorID]
	for len(queue) > 0 {
		taskID := queue[0]
		queue = queue[1:]
		b.pending[collectorID] = queue
		t, ok := b.tasks[taskID]
		if !ok || t.state != taskPending {
			continue
		}
		claimID, err := randomID("claim_")
		if err != nil {
			return collectorapi.TaskDelivery{}, false, err
		}
		t.state = taskClaimed
		t.delivery.ClaimID = claimID
		return cloneDelivery(t.delivery), true, nil
	}
	return collectorapi.TaskDelivery{}, false, nil
}

func (b *Broker) cancel(taskID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t, ok := b.tasks[taskID]
	if !ok {
		return
	}
	delete(b.tasks, taskID)
	if t.state != taskPending {
		return
	}
	queue := b.pending[t.collectorID]
	for index, pendingTaskID := range queue {
		if pendingTaskID == taskID {
			b.pending[t.collectorID] = append(queue[:index], queue[index+1:]...)
			return
		}
	}
}

func (b *Broker) inFlightLocked(collectorID string) int {
	count := 0
	for _, t := range b.tasks {
		if t.collectorID == collectorID {
			count++
		}
	}
	return count
}

func (b *Broker) notifyLocked(collectorID string) chan struct{} {
	if ch := b.notify[collectorID]; ch != nil {
		return ch
	}
	ch := make(chan struct{})
	b.notify[collectorID] = ch
	return ch
}

func (b *Broker) signalLocked(collectorID string) {
	if ch := b.notify[collectorID]; ch != nil {
		close(ch)
	}
	b.notify[collectorID] = make(chan struct{})
}

func (b *Broker) cleanupCompletedLocked() {
	cutoff := b.now().UTC().Add(-10 * time.Minute)
	for taskID, completed := range b.completed {
		if completed.completedAt.Before(cutoff) {
			delete(b.completed, taskID)
		}
	}
}

func randomID(prefix string) (string, error) {
	var raw [18]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func cloneDelivery(value collectorapi.TaskDelivery) collectorapi.TaskDelivery {
	value.Arguments = cloneMap(value.Arguments)
	return value
}

func cloneMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(value))
	for key, item := range value {
		out[key] = item
	}
	return out
}
