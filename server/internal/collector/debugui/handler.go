package debugui

import (
	"encoding/json"
	"html/template"
	"net/http"
	"strconv"

	"github.com/krillinai/Clawee/server/internal/collector/debugstore"
)

type Handler struct {
	store *debugstore.Store
}

func New(store *debugstore.Store) *Handler {
	return &Handler{store: store}
}

func (h *Handler) Healthz(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	_, _ = w.Write([]byte("ok"))
}

func (h *Handler) State(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	limit := debugstore.DefaultCapacity
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err == nil {
			limit = parsed
		}
	}
	writeJSON(w, http.StatusOK, h.store.State(limit))
}

func (h *Handler) Index(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = indexTemplate.Execute(w, nil)
}

func (h *Handler) Page(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = pageTemplate.Execute(w, nil)
}

func requireGet(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet {
		return true
	}
	w.Header().Set("Allow", http.MethodGet)
	http.Error(w, "method must be GET", http.StatusMethodNotAllowed)
	return false
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

var indexTemplate = template.Must(template.New("collector-debug-index").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>采集器调试入口</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #171717; }
    main { max-width: 960px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    p { color: #667085; margin: 0 0 20px; }
    section { background: #fff; border: 1px solid #e4e7ec; border-radius: 8px; padding: 16px; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
    li { border: 1px solid #edf0f3; border-radius: 6px; padding: 12px; }
    a { color: #155eef; font-weight: 650; text-decoration: none; overflow-wrap: anywhere; }
    a:hover { text-decoration: underline; }
    .desc { color: #667085; font-size: 13px; margin-top: 6px; }
    code { background: #f2f4f7; border-radius: 4px; padding: 2px 5px; }
  </style>
</head>
<body>
<main>
  <h1>采集器调试入口</h1>
  <p>本页汇总采集器本地服务提供的调试页面和接口。</p>
  <section>
    <ul>
      <li>
        <a href="/debug/collector">/debug/collector</a>
        <div class="desc">采集器健康、统计、最近链路和最近上报请求页面。</div>
      </li>
      <li>
        <a href="/debug/api/collector/state?limit=50">/debug/api/collector/state?limit=50</a>
        <div class="desc">采集器调试状态 JSON，可通过 <code>limit</code> 控制最近记录数量。</div>
      </li>
      <li>
        <a href="/healthz">/healthz</a>
        <div class="desc">采集器健康检查 JSON，不包含最近原始链路数据。</div>
      </li>
    </ul>
  </section>
</main>
</body>
</html>`))

var pageTemplate = template.Must(template.New("collector-debug").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>采集器健康与数据</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #171717; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    section { background: #fff; border: 1px solid #e4e7ec; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .metric { border: 1px solid #edf0f3; border-radius: 6px; padding: 12px; }
    .metric .value.metric-danger { color: #b42318; }
    .label { color: #667085; font-size: 12px; }
    .value { font-size: 20px; font-weight: 650; margin-top: 4px; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { text-align: left; border-bottom: 1px solid #edf0f3; padding: 8px; font-size: 13px; vertical-align: top; overflow-wrap: anywhere; }
    th { color: #667085; font-weight: 600; }
    details { margin-top: 8px; }
    summary { cursor: pointer; color: #344054; }
    pre { max-height: 360px; overflow: auto; background: #101828; color: #f9fafb; padding: 12px; border-radius: 6px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
    .muted { color: #667085; font-size: 12px; }
    .chain-detail-row td { padding: 0 8px 12px; }
    .detail-panel { margin: 0; border: 1px solid #edf0f3; border-radius: 6px; background: #fcfcfd; padding: 10px 12px; }
    .detail-sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 10px; }
    .detail-block h3 { margin: 0 0 6px; color: #344054; font-size: 13px; }
    .detail-block pre { max-height: 280px; margin: 0; }
    .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
    input { width: 72px; padding: 6px 8px; border: 1px solid #d0d5dd; border-radius: 6px; }
    button { padding: 7px 10px; border: 1px solid #d0d5dd; border-radius: 6px; background: #fff; cursor: pointer; }
  </style>
</head>
<body>
<main>
  <h1>采集器健康与数据</h1>
  <div class="toolbar">
    <label>最近条数 <input id="limit" type="number" min="1" max="50" value="50"></label>
    <button id="refresh">刷新</button>
  </div>
  <section>
    <h2>服务健康</h2>
    <div id="health" class="grid"></div>
  </section>
  <section>
    <h2>统计</h2>
    <div id="stats" class="grid"></div>
  </section>
  <section>
    <h2>最近链路</h2>
    <table>
      <thead><tr><th>接收时间</th><th>解析</th><th>映射</th><th>上报</th><th>详情</th></tr></thead>
      <tbody id="chains"></tbody>
    </table>
  </section>
  <section>
    <h2>最近上报请求</h2>
    <table>
      <thead><tr><th>发送时间</th><th>类型</th><th>路径</th><th>状态</th><th>详情</th></tr></thead>
      <tbody id="reports"></tbody>
    </table>
  </section>
</main>
<script>
const fields = {
  health: [["started_at","启动时间"],["uptime_seconds","运行秒数"],["collector_id","Collector ID"],["device_id","Device ID"],["version","版本"],["office_url","Office URL"]],
  stats: [["chains_total","链路总数"],["chains_parse_failed","解析失败"],["chains_mapped_empty","映射为空"],["chains_report_success","链路上报成功"],["chains_report_failed","链路上报失败"],["reports_total","上报总数"],["reports_success","上报成功"],["reports_failed","上报失败"],["heartbeat_success_10m","最近10分钟心跳正常"],["heartbeat_failed_10m","最近10分钟心跳失败"]]
};
const dangerMetricKeys = new Set(["chains_parse_failed", "chains_report_failed", "reports_failed", "heartbeat_failed_10m"]);
function metric(key, label, value) {
  const valueClassName = dangerMetricKeys.has(key) && Number(value) > 0 ? "value metric-danger" : "value";
  return '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="' + valueClassName + '">' + escapeHtml(String(value ?? "")) + '</div></div>';
}
function renderMetrics(id, data, spec) {
  document.getElementById(id).innerHTML = spec.map(([key,label]) => metric(key, label, data[key])).join("");
}
function pretty(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}
function parseMaybeJSON(value) {
  if (!value) return "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function prettyPayload(value) {
  const parsed = parseMaybeJSON(value);
  if (typeof parsed === "string") return escapeHtml(parsed);
  return pretty(parsed);
}
function detailBlock(title, content, truncated) {
  const hint = truncated ? ' <span class="muted">已截断</span>' : "";
  return '<div class="detail-block"><h3>' + escapeHtml(title) + hint + '</h3><pre>' + content + '</pre></div>';
}
function chainReportDetail(chain) {
  return {
    report_status: chain.report_status || "",
    reported_at: chain.reported_at || "",
    report_kind: chain.report_kind || "",
    report_path: chain.report_path || "",
    report_response_status: chain.report_response_status || "",
    report_error: chain.report_error || "",
    report_duration_ms: chain.report_duration_ms || "",
    report_request: parseMaybeJSON(chain.report_request || "")
  };
}
function chainDetailRow(chain) {
  return '<tr class="chain-detail-row"><td colspan="5"><details class="detail-panel"><summary>查看详情</summary><div class="detail-sections">' +
    detailBlock("原始 Hook Payload", prettyPayload(chain.raw_payload || ""), chain.raw_payload_truncated) +
    detailBlock("映射后的事件", pretty(chain.mapped_events || []), false) +
    detailBlock("上报信息", pretty(chainReportDetail(chain)), chain.report_request_truncated) +
    '</div></details></td></tr>';
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
async function load() {
  const limit = document.getElementById("limit").value || "50";
  const resp = await fetch("/debug/api/collector/state?limit=" + encodeURIComponent(limit));
  const state = await resp.json();
  renderMetrics("health", state.health || {}, fields.health);
  renderMetrics("stats", state.stats || {}, fields.stats);
  document.getElementById("chains").innerHTML = (state.recent_chains || []).map(chain => [
    '<tr>',
    '<td>' + escapeHtml(chain.received_at || "") + '</td>',
    '<td>' + escapeHtml(chain.parse_status || "") + (chain.parse_error ? "<br>" + escapeHtml(chain.parse_error) : "") + '</td>',
    '<td>' + escapeHtml(chain.map_status || "") + '<br>' + ((chain.mapped_events || []).length) + ' events</td>',
    '<td>' + escapeHtml(chain.report_status || "") + '<br>' + escapeHtml(String(chain.report_response_status || "")) + (chain.report_error ? "<br>" + escapeHtml(chain.report_error) : "") + '</td>',
    '<td><span class="muted">见下方</span></td>',
    '</tr>',
    chainDetailRow(chain)
  ].join("")).join("");
  document.getElementById("reports").innerHTML = (state.recent_reports || []).map(report => [
    '<tr>',
    '<td>' + escapeHtml(report.sent_at || "") + '</td>',
    '<td>' + escapeHtml(report.kind || "") + '</td>',
    '<td>' + escapeHtml(report.path || "") + '</td>',
    '<td>' + escapeHtml(String(report.response_status || "")) + (report.error ? "<br>" + escapeHtml(report.error) : "") + '</td>',
    '<td><details><summary>查看</summary><pre>' + pretty(report) + '</pre></details></td>',
    '</tr>'
  ].join("")).join("");
}
document.getElementById("refresh").addEventListener("click", load);
load();
</script>
</body>
</html>`))
