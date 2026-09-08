package businessdata

import "context"

type Connector interface {
	Provider() string
	Pull(context.Context, Source, PullRequest) (Batch, error)
}
