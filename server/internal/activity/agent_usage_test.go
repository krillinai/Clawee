package activity

import (
	"context"
	"errors"
	"testing"
	"time"
)

type agentUsageFake struct {
	calls                  int
	user, collector, agent string
	dateRange              DateRange
}

func (f *agentUsageFake) Statistics(context.Context, time.Time, time.Time) (ActivitySnapshot, error) {
	return ActivitySnapshot{}, nil
}
func (f *agentUsageFake) AgentUsage(_ context.Context, user, collector, agent string, r DateRange) (AgentUsage, error) {
	f.calls++
	f.user, f.collector, f.agent, f.dateRange = user, collector, agent, r
	return AgentUsage{TurnCount: 3, Points: []AgentUsagePoint{{BucketStart: r.Start, TurnCount: 3}}}, nil
}
func TestAgentUsageRangesAndZeroBuckets(t *testing.T) {
	for _, tc := range []struct {
		rangeName   string
		buckets     int
		granularity string
	}{{RangeToday, 24, "hour"}, {Range7Days, 7, "day"}, {Range30Days, 30, "day"}} {
		t.Run(tc.rangeName, func(t *testing.T) {
			store := &agentUsageFake{}
			svc, err := NewService(nil, store, nil, "Asia/Shanghai")
			if err != nil {
				t.Fatal(err)
			}
			svc.clock = func() time.Time { return time.Date(2026, 10, 29, 4, 0, 0, 0, time.UTC) }
			result, err := svc.AgentUsage(context.Background(), " user ", " source ", " agent ", tc.rangeName)
			if err != nil {
				t.Fatal(err)
			}
			if result.TurnCount != 3 || len(result.Points) != tc.buckets || result.Points[0].TurnCount != 3 || result.Points[1].TurnCount != 0 || result.Granularity != tc.granularity || result.Range != tc.rangeName {
				t.Fatalf("unexpected usage: %#v", result)
			}
			if store.user != "user" || store.collector != "source" || store.agent != "agent" || store.dateRange.Start.Hour() != 0 || store.dateRange.Start.Location().String() != "Asia/Shanghai" {
				t.Fatalf("scope/range = %#v", store)
			}
			if _, err := svc.AgentUsage(context.Background(), "user", "source", "agent", "invalid"); !errors.Is(err, ErrInvalidRange) || store.calls != 1 {
				t.Fatal("invalid range must not query store")
			}
		})
	}
}
