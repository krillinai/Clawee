package adapter

import (
	"context"
	"net/http"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type EventSink interface {
	Accept(events []collectorapi.CollectorEvent)
}

type Adapter interface {
	Type() collectorapi.AgentType
	Handler() http.Handler
	Start(ctx context.Context) error
}
