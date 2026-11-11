package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

func newTestRAGFlow(t *testing.T, handler http.HandlerFunc, configure ...func(*RAGFlowConfig)) *RAGFlowProvider {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	cfg := RAGFlowConfig{BaseURL: server.URL + "/", APIKey: "fixture-key"}
	for _, apply := range configure {
		apply(&cfg)
	}
	p, err := NewRAGFlowProvider(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func assertRAGFlowError(t *testing.T, err error, code string) *ProviderError {
	t.Helper()
	var typed *ProviderError
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("error=%v，期望 %s", err, code)
	}
	if typed.ProviderMessage != "" || strings.Contains(fmt.Sprintf("%+v", typed), "vendor-secret") {
		t.Fatal("泄露上游原始错误")
	}
	return typed
}

func TestRAGFlowCreateV1Contract(t *testing.T) {
	for _, model := range []string{"", "fixture-model@fixture-factory"} {
		t.Run(model, func(t *testing.T) {
			calls := 0
			p := newTestRAGFlow(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != http.MethodPost || r.URL.Path != "/api/v1/datasets" || r.Header.Get("Authorization") != "Bearer fixture-key" {
					t.Errorf("错误请求: %s %s", r.Method, r.URL.Path)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				want := map[string]any{"name": "制度库", "language": "Chinese", "parse_type": float64(1), "parser_id": "general", "permission": "me"}
				if model != "" {
					want["embedding_model"] = model
				}
				if !reflect.DeepEqual(body, want) {
					t.Errorf("body=%v，期望 %v", body, want)
				}
				io.WriteString(w, `{"code":0,"data":{"id":"returned-id","name":"制度库 (2)"}}`)
			}, func(cfg *RAGFlowConfig) { cfg.EmbeddingModel = model })
			got, err := p.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseRequest{Name: "制度库", Description: "只保存在本地"})
			if err != nil || got.ExternalID != "returned-id" || calls != 1 {
				t.Fatalf("got=%+v error=%v calls=%d", got, err, calls)
			}
			_, err = p.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseRequest{Name: "库😀"})
			assertRAGFlowError(t, err, ErrorInvalidRequest)
			if calls != 1 {
				t.Fatal("非法字符不应发起请求")
			}
		})
	}
}

func TestRAGFlowResponseErrors(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     int
		body, code string
		retryable  bool
	}{
		{"401", 401, `vendor-secret`, ErrorUnauthorized, false},
		{"403", 403, `{"code":0}`, ErrorUnauthorized, false},
		{"429", 429, `{"code":0}`, ErrorRateLimited, true},
		{"500", 500, `vendor-secret`, ErrorInternal, true},
		{"400", 400, `{"code":101}`, ErrorInvalidRequest, false},
		{"404路由", 404, `{"code":0}`, ErrorInternal, false},
		{"101", 200, `{"code":101,"message":"vendor-secret"}`, ErrorInvalidRequest, false},
		{"102", 200, `{"code":102,"message":"vendor-secret"}`, ErrorInternal, false},
		{"10", 200, `{"code":10}`, ErrorInternal, false},
		{"103", 200, `{"code":103}`, ErrorInternal, false},
		{"106", 200, `{"code":106}`, ErrorInternal, false},
		{"105", 200, `{"code":105}`, ErrorInternal, true},
		{"108", 200, `{"code":108}`, ErrorUnauthorized, false},
		{"109", 200, `{"code":109}`, ErrorUnauthorized, false},
		{"缺code", 200, `{"data":{"id":"id"}}`, ErrorInternal, false},
		{"null code", 200, `{"code":null,"data":{"id":"id"}}`, ErrorInternal, false},
		{"无ID", 200, `{"code":0,"data":{}}`, ErrorInternal, false},
		{"非JSON", 200, `vendor-secret`, ErrorInternal, false},
		{"多份JSON", 200, `{"code":0,"data":{"id":"id"}} {}`, ErrorInternal, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			p := newTestRAGFlow(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(test.status)
				io.WriteString(w, test.body)
			})
			_, err := p.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseRequest{Name: "制度库"})
			typed := assertRAGFlowError(t, err, test.code)
			if typed.Retryable != test.retryable || calls != 1 {
				t.Fatalf("retryable=%v calls=%d", typed.Retryable, calls)
			}
		})
	}
}

func TestRAGFlowRejectsRedirectAndTimeout(t *testing.T) {
	forwarded := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded = true }))
	defer target.Close()
	p := newTestRAGFlow(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	_, err := p.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseRequest{Name: "制度库"})
	assertRAGFlowError(t, err, ErrorInternal)
	if forwarded {
		t.Fatal("不允许跟随重定向")
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	_, err = p.CreateKnowledgeBase(ctx, CreateKnowledgeBaseRequest{Name: "制度库"})
	if !assertRAGFlowError(t, err, ErrorTimeout).Retryable {
		t.Fatal("超时应可重试")
	}
}

func TestRAGFlowBodyDeadlineIsRetryableAndLogsUncertainWrite(t *testing.T) {
	for _, operation := range []string{"create", "upload"} {
		t.Run(operation, func(t *testing.T) {
			core, logs := observer.New(zapcore.WarnLevel)
			p := newTestRAGFlow(t, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				io.WriteString(w, `{"code":0,"data":`)
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}, func(cfg *RAGFlowConfig) {
				cfg.Logger = zap.New(core)
				if operation == "upload" {
					cfg.HTTPClient = &http.Client{Timeout: 200 * time.Millisecond}
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			var err error
			if operation == "create" {
				_, err = p.CreateKnowledgeBase(ctx, CreateKnowledgeBaseRequest{Name: "合成库"})
			} else {
				_, err = p.UploadDocument(ctx, "dataset", DocumentFile{Name: "fixture.txt", Reader: strings.NewReader("合成")})
			}
			typed := assertRAGFlowError(t, err, ErrorTimeout)
			if !typed.Retryable || typed.HTTPStatus != http.StatusOK || logs.Len() != 1 || logs.All()[0].Message != "RAGFlow 写入结果待核对" {
				t.Fatalf("error=%+v logs=%v", typed, logs.All())
			}
		})
	}
}

type ragflowRoundTripFunc func(*http.Request) (*http.Response, error)

func (f ragflowRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRAGFlowUploadStartsParsingAndCompensates(t *testing.T) {
	for _, test := range []struct {
		name                      string
		fail, cancel, cleanupFail bool
	}{
		{name: "正常"}, {name: "解析失败", fail: true}, {name: "取消后补偿", cancel: true}, {name: "补偿失败", fail: true, cleanupFail: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			core, logs := observer.New(zapcore.DebugLevel)
			var calls []string
			p := newTestRAGFlow(t, func(w http.ResponseWriter, r *http.Request) {
				calls = append(calls, r.Method+" "+r.URL.Path)
				switch {
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/documents"):
					reader, err := r.MultipartReader()
					if err != nil {
						t.Error(err)
						return
					}
					part, err := reader.NextPart()
					if err != nil {
						t.Error(err)
						return
					}
					content, _ := io.ReadAll(part)
					if part.FormName() != "file" || part.FileName() != "fixture.txt" || string(content) != "合成资料" {
						t.Error("multipart 不符合契约")
					}
					if _, err := reader.NextPart(); err != io.EOF {
						t.Error("只能上传一个文件")
					}
					io.WriteString(w, `{"code":0,"data":[{"id":"new-doc"}]}`)
				case strings.HasSuffix(r.URL.Path, "/chunks"):
					var body map[string][]string
					json.NewDecoder(r.Body).Decode(&body)
					if !reflect.DeepEqual(body, map[string][]string{"document_ids": {"new-doc"}}) {
						t.Errorf("parse body=%v", body)
					}
					if test.fail {
						io.WriteString(w, `{"code":105,"message":"vendor-secret"}`)
					} else {
						io.WriteString(w, `{"code":0}`)
					}
				case r.Method == http.MethodDelete:
					if r.Context().Err() != nil {
						t.Error("补偿 context 已取消")
					}
					var body map[string][]string
					json.NewDecoder(r.Body).Decode(&body)
					if !reflect.DeepEqual(body, map[string][]string{"ids": {"new-doc"}}) {
						t.Errorf("cleanup body=%v", body)
					}
					if test.cleanupFail {
						io.WriteString(w, `{"code":109}`)
					} else {
						io.WriteString(w, `{"code":0}`)
					}
				default:
					io.WriteString(w, `{"code":109}`)
				}
			}, func(cfg *RAGFlowConfig) {
				cfg.Logger = zap.New(core)
				if test.cancel {
					cfg.HTTPClient = &http.Client{Transport: ragflowRoundTripFunc(func(r *http.Request) (*http.Response, error) {
						if strings.HasSuffix(r.URL.Path, "/chunks") {
							cancel()
							return nil, context.Canceled
						}
						return http.DefaultTransport.RoundTrip(r)
					})}
				}
			})
			doc, err := p.UploadDocument(ctx, "dataset", DocumentFile{Name: "fixture.txt", Size: 12, MIMEType: "text/plain", Reader: strings.NewReader("合成资料")})
			if !test.fail && !test.cancel {
				if err != nil || doc.ExternalID != "new-doc" || doc.Status != DocumentProcessing || len(calls) != 2 {
					t.Fatalf("doc=%+v error=%v calls=%v", doc, err, calls)
				}
			} else {
				assertRAGFlowError(t, err, ErrorInternal)
				if logs.Len() != 1 || logs.All()[0].ContextMap()["compensation_failed"] != test.cleanupFail {
					t.Fatalf("补偿日志=%v", logs.All())
				}
				deletes := 0
				for _, call := range calls {
					if strings.HasPrefix(call, "DELETE") {
						deletes++
					}
				}
				if deletes != 1 {
					t.Fatalf("补偿次数=%d", deletes)
				}
			}
		})
	}
}

func TestRAGFlowDocumentStatuses(t *testing.T) {
	for _, test := range []struct {
		value   string
		status  DocumentStatus
		message string
	}{
		{"UNSTART", DocumentProcessing, ""}, {"RUNNING", DocumentProcessing, ""}, {"SCHEDULE", DocumentProcessing, ""},
		{"DONE", DocumentReady, ""}, {"FAIL", DocumentFailed, "文档处理失败"}, {"CANCEL", DocumentFailed, "文档处理已取消"},
		{"0", DocumentProcessing, ""}, {"1", DocumentProcessing, ""}, {"5", DocumentProcessing, ""}, {"3", DocumentReady, ""},
		{"4", DocumentFailed, "文档处理失败"}, {"2", DocumentFailed, "文档处理已取消"},
		{"UNKNOWN", DocumentFailed, "无法识别文档处理状态"}, {"1.5", DocumentFailed, "无法识别文档处理状态"},
	} {
		t.Run(test.value, func(t *testing.T) {
			raw, _ := json.Marshal(test.value)
			status, message := ragflowDocumentStatus(raw)
			if status != test.status || message != test.message {
				t.Fatalf("status=%s message=%s", status, message)
			}
			if test.value[0] >= '0' && test.value[0] <= '9' {
				status, message = ragflowDocumentStatus(json.RawMessage(test.value))
				if status != test.status || message != test.message {
					t.Fatalf("数字状态=%s message=%s", status, message)
				}
			}
		})
	}
	for _, raw := range []string{"", "null", "true", "{}", "1.0"} {
		status, message := ragflowDocumentStatus(json.RawMessage(raw))
		if status != DocumentFailed || message != "无法识别文档处理状态" {
			t.Fatalf("非法状态 %s 被接受", raw)
		}
	}
}

func TestRAGFlowPaginationIsCompleteOrFails(t *testing.T) {
	for _, mode := range []string{"完整", "重复页", "后页失败", "缺docs"} {
		t.Run(mode, func(t *testing.T) {
			pages := 0
			p := newTestRAGFlow(t, func(w http.ResponseWriter, r *http.Request) {
				pages++
				q := r.URL.Query()
				if q.Get("page") != fmt.Sprint(pages) || q.Get("page_size") != "100" || q.Get("orderby") != "create_time" || q.Get("desc") != "false" {
					t.Errorf("query=%v", q)
				}
				if mode == "重复页" && pages == 2 {
					io.WriteString(w, `{"code":0,"data":{"docs":[{"id":"doc-1","run":"DONE"}]}}`)
					return
				}
				if mode == "后页失败" && pages == 3 {
					w.WriteHeader(503)
					io.WriteString(w, `{"code":105}`)
					return
				}
				if mode == "缺docs" {
					io.WriteString(w, `{"code":0,"data":{}}`)
					return
				}
				if pages == 4 {
					io.WriteString(w, `{"code":0,"data":{"docs":[]}}`)
					return
				}
				progress := `"vendor-secret"`
				if pages == 2 {
					progress = `["vendor-secret"]`
				}
				fmt.Fprintf(w, `{"code":0,"data":{"docs":[{"id":"doc-%d","dataset_id":"dataset","name":"fixture.txt","run":%d,"progress_msg":%s}]}}`, pages, pages, progress)
			})
			docs, err := p.ListDocuments(context.Background(), "dataset")
			if mode == "完整" {
				if err != nil || len(docs) != 3 || pages != 4 || docs[0].Status != DocumentProcessing || docs[1].Status != DocumentFailed || docs[2].Status != DocumentReady {
					t.Fatalf("docs=%+v err=%v pages=%d", docs, err, pages)
				}
				for _, doc := range docs {
					if strings.Contains(doc.ErrorMessage, "vendor-secret") {
						t.Fatal("泄露 progress_msg")
					}
				}
			} else if err == nil || docs != nil {
				t.Fatalf("不能返回部分快照: docs=%+v err=%v", docs, err)
			}
		})
	}
}

func TestRAGFlowRetrievalContract(t *testing.T) {
	p := newTestRAGFlow(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/retrieval" || r.Method != http.MethodPost {
			t.Error("错误检索路由")
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		want := map[string]any{"question": "合成问题", "dataset_ids": []any{"dataset"}, "page": float64(1), "page_size": float64(3), "highlight": false, "use_kg": false, "include_knowledge_compilation": false, "rerank_id": "fixture-reranker"}
		if !reflect.DeepEqual(body, want) {
			t.Errorf("body=%v", body)
		}
		io.WriteString(w, `{"code":0,"data":{"chunks":[{"id":"chunk-1","dataset_id":"dataset","document_id":"doc-1","content":"合成正文","document_keyword":"","similarity":0.8,"highlight":"<b>不使用</b>"},{"id":"chunk-2","content":"第二条"},{"id":"","content":"忽略"},{"id":"chunk-3","content":" "}],"doc_aggs":[{"document_id":"doc-1","doc_name":"fixture.txt"}]}}`)
	}, func(cfg *RAGFlowConfig) { cfg.RerankID = "fixture-reranker" })
	result, err := p.Search(context.Background(), SearchRequest{ExternalKnowledgeBaseID: "dataset", Query: "合成问题", TopK: 3})
	if err != nil || len(result.Chunks) != 2 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if result.Chunks[0].Text != "合成正文" || result.Chunks[0].DocumentName != "fixture.txt" || result.Chunks[0].SourceID != "chunk-1" || result.Chunks[0].Score == nil || result.Chunks[0].Section != "" || result.Chunks[1].Score != nil || result.Chunks[1].DocumentName != "未命名文档" {
		t.Fatalf("chunks=%+v", result.Chunks)
	}
}

func TestRAGFlowRetrievalRejectsInvalidSnapshot(t *testing.T) {
	for _, test := range []struct {
		body string
		ok   bool
	}{
		{`{"code":0,"data":{"chunks":[]}}`, true},
		{`{"code":0,"data":{}}`, false},
		{`{"code":0,"data":{"chunks":null}}`, false},
		{`{"code":0,"data":{"chunks":[{"id":"chunk","dataset_id":"other","content":"不能返回"}]}}`, false},
		{`{"code":0,"data":{"chunks":[{"dataset_id":"other"}]}}`, false},
		{`{"code":0,"data":{"chunks":[{"id":"chunk","content":"合成","similarity":1e999}]}}`, false},
	} {
		t.Run(test.body, func(t *testing.T) {
			p := newTestRAGFlow(t, func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				if _, ok := body["rerank_id"]; ok {
					t.Error("空 rerank_id 应省略")
				}
				io.WriteString(w, test.body)
			})
			result, err := p.Search(context.Background(), SearchRequest{ExternalKnowledgeBaseID: "dataset", Query: "合成问题", TopK: 5})
			if test.ok {
				if err != nil || result.Chunks == nil || len(result.Chunks) != 0 {
					t.Fatalf("result=%+v err=%v", result, err)
				}
			} else {
				assertRAGFlowError(t, err, ErrorInternal)
			}
		})
	}
}

func TestRAGFlowDeletionRequiresExactMissingConfirmation(t *testing.T) {
	for _, document := range []bool{false, true} {
		for _, mode := range []string{"成功", "确认缺失", "仍存在", "确认鉴权失败", "102确认失败", "数据集缺失", "错误路由"} {
			t.Run(fmt.Sprintf("document=%v/%s", document, mode), func(t *testing.T) {
				deletes, queries := 0, 0
				p := newTestRAGFlow(t, func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "Bearer fixture-key" {
						t.Error("查询必须鉴权")
					}
					if r.Method == http.MethodDelete {
						deletes++
						var body map[string][]string
						json.NewDecoder(r.Body).Decode(&body)
						id := "dataset"
						if document {
							id = "document"
						}
						if !reflect.DeepEqual(body, map[string][]string{"ids": {id}}) {
							t.Errorf("delete body=%v", body)
						}
						if mode == "成功" {
							io.WriteString(w, `{"code":0}`)
						} else {
							io.WriteString(w, `{"code":101,"message":"vendor-secret"}`)
						}
						return
					}
					queries++
					id := "dataset"
					if strings.HasSuffix(r.URL.Path, "/documents") {
						id = "document"
					}
					if r.URL.Query().Get("id") != id {
						t.Errorf("必须精确查询: %s", r.URL)
					}
					if mode == "确认鉴权失败" {
						io.WriteString(w, `{"code":109}`)
						return
					}
					if mode == "102确认失败" {
						io.WriteString(w, `{"code":102}`)
						return
					}
					if mode == "错误路由" {
						w.WriteHeader(404)
						io.WriteString(w, `{"code":0}`)
						return
					}
					if mode == "数据集缺失" && id == "document" {
						io.WriteString(w, `{"code":102}`)
						return
					}
					data := `[]`
					if mode == "仍存在" {
						data = fmt.Sprintf(`[{"id":%q}]`, id)
					}
					if id == "document" {
						data = `{"docs":` + data + `}`
					}
					fmt.Fprintf(w, `{"code":0,"data":%s}`, data)
				})
				var err error
				if document {
					err = p.DeleteDocument(context.Background(), "dataset", "document")
				} else {
					err = p.DeleteKnowledgeBase(context.Background(), "dataset")
				}
				ok := mode == "成功" || mode == "确认缺失" || mode == "数据集缺失"
				if ok && err != nil {
					t.Fatal(err)
				}
				if !ok {
					assertRAGFlowError(t, err, ErrorInternal)
				}
				if deletes != 1 || (mode == "成功" && queries != 0) {
					t.Fatalf("deletes=%d queries=%d", deletes, queries)
				}
				if document {
					err = p.DeleteDocument(context.Background(), "dataset", "")
				} else {
					err = p.DeleteKnowledgeBase(context.Background(), "")
				}
				assertRAGFlowError(t, err, ErrorInvalidRequest)
				if deletes != 1 {
					t.Fatal("空 ID 不能发起删除")
				}
			})
		}
	}
}
