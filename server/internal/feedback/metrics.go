package feedback

import "github.com/prometheus/client_golang/prometheus"

var (
	operations        = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "clawee_feedback_operations_total", Help: "反馈操作次数，仅含操作与脱敏结果码。"}, []string{"operation", "result"})
	uploadedBytes     = prometheus.NewCounter(prometheus.CounterOpts{Name: "clawee_feedback_uploaded_bytes_total", Help: "成功接收的反馈附件字节数。"})
	missingItems      = prometheus.NewCounter(prometheus.CounterOpts{Name: "clawee_feedback_missing_items_total", Help: "已创建反馈的明确缺失项数。"})
	capacityRemaining = prometheus.NewGauge(prometheus.GaugeOpts{Name: "clawee_feedback_capacity_remaining_bytes", Help: "反馈数据库容量预留后的剩余字节数。"})
)

func init() { prometheus.MustRegister(operations, uploadedBytes, missingItems, capacityRemaining) }
func observeOperation(operation string, err error) {
	result := "success"
	if err != nil {
		_, result = HTTPError(err)
	}
	operations.WithLabelValues(operation, result).Inc()
}
