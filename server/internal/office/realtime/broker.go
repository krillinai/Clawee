package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/dashboard"
)

type Event struct {
	ID       string
	Type     string
	Envelope dashboard.RealtimeEnvelope
}

type Subscriber struct {
	Events <-chan Event
}

type Broker struct {
	nextID      atomic.Uint64
	mu          sync.Mutex
	subscribers map[chan Event]struct{}
}

func NewBroker() *Broker {
	return &Broker{subscribers: make(map[chan Event]struct{})}
}

func (b *Broker) Subscribe(ctx context.Context) Subscriber {
	ch := make(chan Event, 16)
	b.mu.Lock()
	b.subscribers[ch] = struct{}{}
	b.mu.Unlock()

	go func() {
		<-ctx.Done()
		b.mu.Lock()
		delete(b.subscribers, ch)
		close(ch)
		b.mu.Unlock()
	}()

	return Subscriber{Events: ch}
}

func (b *Broker) Publish(eventType string, scope dashboard.RealtimeScope, data json.RawMessage, emittedAt time.Time) Event {
	idNumber := b.nextID.Add(1)
	id := fmt.Sprintf("%d", idNumber)
	event := Event{
		ID:   id,
		Type: eventType,
		Envelope: dashboard.RealtimeEnvelope{
			SchemaVersion: dashboard.SchemaVersion,
			EventID:       "sse_" + id,
			EventType:     eventType,
			EmittedAt:     emittedAt,
			Cursor:        id,
			Scope:         scope,
			Data:          data,
		},
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subscribers {
		select {
		case ch <- event:
		default:
		}
	}
	return event
}

func (b *Broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.ServeFilteredHTTP(w, r, nil)
}

func (b *Broker) ServeFilteredHTTP(w http.ResponseWriter, r *http.Request, allow func(dashboard.RealtimeScope) bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming is not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	sub := b.Subscribe(r.Context())
	hello := newEvent("0", "hello", dashboard.RealtimeScope{}, json.RawMessage(`{"message":"connected"}`), time.Now().UTC())
	writeSSE(w, hello)
	flusher.Flush()

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case event, ok := <-sub.Events:
			if !ok {
				return
			}
			if allow != nil && !allow(event.Envelope.Scope) {
				continue
			}
			writeSSE(w, event)
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, "event: heartbeat\n")
			fmt.Fprintf(w, "data: {\"schema_version\":\"%s\"}\n\n", dashboard.SchemaVersion)
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func newEvent(id string, eventType string, scope dashboard.RealtimeScope, data json.RawMessage, emittedAt time.Time) Event {
	return Event{
		ID:   id,
		Type: eventType,
		Envelope: dashboard.RealtimeEnvelope{
			SchemaVersion: dashboard.SchemaVersion,
			EventID:       "sse_" + id,
			EventType:     eventType,
			EmittedAt:     emittedAt,
			Cursor:        id,
			Scope:         scope,
			Data:          data,
		},
	}
}

func writeSSE(w http.ResponseWriter, event Event) {
	body, _ := json.Marshal(event.Envelope)
	fmt.Fprintf(w, "event: %s\n", event.Type)
	fmt.Fprintf(w, "id: %s\n", event.ID)
	fmt.Fprintf(w, "data: %s\n\n", string(body))
}
