package agentactivitymcp

const (
	ServerID          = "agent-activity"
	ToolSummary       = "summary"
	ToolAgents        = "agents"
	ToolAgentDetail   = "agent_detail"
	ToolMetricExplain = "metric_explain"
)

type metricDefinition struct {
	MetricID    string `json:"metric_id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Unit        string `json:"unit"`
	Aggregation string `json:"aggregation"`
	Scope       string `json:"scope"`
	DataSource  string `json:"data_source"`
	Rules       string `json:"rules"`
}

var metricCatalog = map[string]metricDefinition{
	"total_tokens":        {MetricID: "total_tokens", Label: "总 Token", Description: "输入和输出 Token 的总使用量", Unit: "token", Aggregation: "sum", Scope: "授权组织视图", DataSource: "Sub2API", Rules: "仅在模型用量数据可用时返回权威值"},
	"input_tokens":        {MetricID: "input_tokens", Label: "输入 Token", Description: "模型请求的输入 Token 使用量", Unit: "token", Aggregation: "sum", Scope: "授权组织视图", DataSource: "Sub2API", Rules: "缓存输入单独统计"},
	"cached_input_tokens": {MetricID: "cached_input_tokens", Label: "缓存输入 Token", Description: "命中缓存的输入 Token 使用量", Unit: "token", Aggregation: "sum", Scope: "授权组织视图", DataSource: "Sub2API", Rules: "缺失数据不以零伪装"},
	"output_tokens":       {MetricID: "output_tokens", Label: "输出 Token", Description: "模型响应的输出 Token 使用量", Unit: "token", Aggregation: "sum", Scope: "授权组织视图", DataSource: "Sub2API", Rules: "缺失数据不以零伪装"},
	"active_employees":    {MetricID: "active_employees", Label: "活跃员工", Description: "周期内产生 Agent Turn 的去重账户数", Unit: "count", Aggregation: "distinct_count", Scope: "授权组织视图", DataSource: "Office activity store", Rules: "按自然日范围统计"},
	"active_agents":       {MetricID: "active_agents", Label: "活跃 Agent", Description: "周期内产生 Turn 的去重 Agent 分区数", Unit: "count", Aggregation: "distinct_count", Scope: "授权组织视图", DataSource: "Office activity store", Rules: "内部 Collector 分区不会返回给调用方"},
	"completed_turns":     {MetricID: "completed_turns", Label: "完成轮次", Description: "周期内完成的去重 Turn 数", Unit: "count", Aggregation: "distinct_count", Scope: "授权组织视图", DataSource: "Office activity store", Rules: "按完成时间落入查询周期"},
	"session_count":       {MetricID: "session_count", Label: "会话数", Description: "指定 Agent 在周期内开始的去重 Session 数", Unit: "count", Aggregation: "distinct_count", Scope: "单个 Agent", DataSource: "Office activity store", Rules: "不返回会话正文"},
	"turn_count":          {MetricID: "turn_count", Label: "轮次数", Description: "指定 Agent 在周期内开始的去重 Turn 数", Unit: "count", Aggregation: "distinct_count", Scope: "单个 Agent", DataSource: "Office activity store", Rules: "不返回用户或 Assistant 正文"},
	"tool_call_count":     {MetricID: "tool_call_count", Label: "工具调用数", Description: "指定 Agent 在周期内发起的工具调用数", Unit: "count", Aggregation: "distinct_count", Scope: "单个 Agent", DataSource: "Office activity store", Rules: "不返回工具输入输出"},
	"mcp_call_count":      {MetricID: "mcp_call_count", Label: "MCP 调用数", Description: "指定 Agent 在周期内成功执行的 MCP Tool 调用数", Unit: "count", Aggregation: "count", Scope: "单个 Agent", DataSource: "MCP Gateway audit", Rules: "只计允许或确认后完成的调用"},
}
