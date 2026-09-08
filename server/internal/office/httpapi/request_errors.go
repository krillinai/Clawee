package httpapi

import (
	"context"
	"net/http"
)

type requestErrorSinkContextKey struct{}

type RequestErrorSink struct {
	errs []error
}

func NewRequestErrorSink() *RequestErrorSink {
	return &RequestErrorSink{}
}

func ContextWithRequestErrorSink(ctx context.Context, sink *RequestErrorSink) context.Context {
	return context.WithValue(ctx, requestErrorSinkContextKey{}, sink)
}

func AttachRequestError(r *http.Request, err error) {
	if r == nil || err == nil {
		return
	}
	sink, _ := r.Context().Value(requestErrorSinkContextKey{}).(*RequestErrorSink)
	if sink == nil {
		return
	}
	sink.errs = append(sink.errs, err)
}

func (s *RequestErrorSink) Errors() []error {
	if s == nil {
		return nil
	}
	return append([]error(nil), s.errs...)
}
