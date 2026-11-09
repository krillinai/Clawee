import { describe, expect, it } from 'vitest';
import { parseJsonLine } from '../../src/events/parser.js';
import {
  normalizeAppServerEvent,
  normalizeCodexEvent
} from '../../src/events/normalizer.js';

describe('event parser and normalizer', () => {
  it('思考摘要增量保留空白、item 和 turn 身份，完成快照保持相同身份', () => {
    const delta = normalizeAppServerEvent({ runId: 'r', seq: 1, raw: {
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'thinking', turnId: 'turn', summaryIndex: 0, delta: ' 第一段\n' }
    } });
    expect(delta).toMatchObject({ type: 'reasoning_summary', rawEventId: 'thinking', turnId: 'turn',
      payload: { delivery: 'delta', text: ' 第一段\n' } });
    const completed = normalizeAppServerEvent({ runId: 'r', seq: 2, raw: {
      method: 'item/completed',
      params: { turnId: 'turn', item: { id: 'thinking', type: 'reasoning', summary: ['第一段', '第二段'] } }
    } });
    expect(completed).toMatchObject({ type: 'reasoning_summary', rawEventId: 'thinking', turnId: 'turn',
      payload: { delivery: 'summary', text: '第一段\n\n第二段' } });
  });

  it('思考摘要的新段落转换为分隔增量，首段不插入空行', () => {
    const raw = { method: 'item/reasoning/summaryPartAdded',
      params: { itemId: 'thinking', turnId: 'turn', summaryIndex: 1 } };
    expect(normalizeAppServerEvent({ runId: 'r', seq: 1, raw })).toMatchObject({
      type: 'reasoning_summary', rawEventId: 'thinking', turnId: 'turn',
      payload: { delivery: 'delta', text: '\n\n' }
    });
    expect(normalizeAppServerEvent({ runId: 'r', seq: 2,
      raw: { ...raw, params: { ...raw.params, summaryIndex: 0 } } }).type).toBe('unknown_event');
  });

  it('无效思考摘要增量和非摘要正文不进入摘要展示', () => {
    for (const params of [{ delta: '错误' }, { itemId: ' ', delta: '错误' },
      { itemId: 'thinking', delta: '' }, { itemId: 'thinking', delta: 1 }]) {
      expect(normalizeAppServerEvent({ runId: 'r', seq: 1,
        raw: { method: 'item/reasoning/summaryTextDelta', params } }).type).toBe('unknown_event');
    }
    expect(normalizeAppServerEvent({ runId: 'r', seq: 1, raw: {
      method: 'item/reasoning/textDelta', params: { itemId: 'thinking', contentIndex: 0, delta: '正文' }
    } }).type).toBe('unknown_event');
  });

  it('正文增量保留 item 和 turn 身份，完成快照仍是同一正文项', () => {
    const delta = normalizeAppServerEvent({ runId: 'r', seq: 1, raw: { method: 'item/agentMessage/delta',
      params: { itemId: 'body', turnId: 'turn', delta: '第一段' } } });
    expect(delta).toMatchObject({ type: 'assistant_message', rawEventId: 'body', turnId: 'turn',
      normalizerVersion: 2, payload: { delivery: 'delta', text: '第一段' } });
    for (const params of [{ turnId: 'turn', delta: '错误' }, { itemId: 'body', delta: '' }, { itemId: ' ', delta: '错误' }]) {
      expect(normalizeAppServerEvent({ runId: 'r', seq: 2, raw: { method: 'item/agentMessage/delta', params } }).type).toBe('unknown_event');
    }
  });
  it('parses valid json lines', () => {
    expect(parseJsonLine('{"type":"turn.started"}')).toEqual({ ok: true, value: { type: 'turn.started' } });
  });

  it('reports invalid json lines', () => {
    const result = parseJsonLine('{broken');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe('{broken');
      expect(result.error).toEqual(expect.any(String));
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('normalizes agent messages', () => {
    const event = normalizeCodexEvent({
      runId: 'run_1',
      seq: 1,
      raw: {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello' }
      }
    });
    expect(event.type).toBe('assistant_message');
    expect(event.payload).toMatchObject({ type: 'assistant_message', text: 'hello' });
  });

  it('normalizes command execution result', () => {
    const event = normalizeCodexEvent({
      runId: 'run_1',
      seq: 2,
      raw: {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'pwd',
          aggregated_output: '/repo',
          exit_code: 0,
          status: 'completed'
        }
      }
    });
    expect(event.type).toBe('tool_result');
    expect(event.payload).toMatchObject({ type: 'tool_result', output: '/repo', exitCode: 0 });
  });

  it.each([
    { name: 'transport error takes precedence', status: 'failed', error: { message: '连接超时' },
      result: { structuredContent: { code: 'content_forbidden', message: '未获授权查看员工会话正文' } },
      output: '连接超时', isError: true },
    { name: 'structured business error', status: 'failed', error: null,
      result: { content: [], structuredContent: { code: 'content_forbidden', message: '未获授权查看员工会话正文', retryable: false } },
      output: '未获授权查看员工会话正文（content_forbidden）', isError: true },
    { name: 'blank transport message falls through', status: 'failed', error: { message: '  ' },
      result: { structuredContent: { message: '权限不足' } }, output: '权限不足', isError: true },
    { name: 'text business error', status: 'completed',
      result: { isError: true, content: [{ type: 'text', text: '上游服务不可用' }] },
      output: '上游服务不可用', isError: true },
    { name: 'structured error takes precedence over text', status: 'completed',
      result: { isError: true, structuredContent: { code: 'forbidden', message: '权限不足' }, content: [{ type: 'text', text: '其他说明' }] },
      output: '权限不足（forbidden）', isError: true },
    { name: 'blank structured message falls through', status: 'failed',
      result: { structuredContent: { code: 'upstream_failed', message: '\n' }, content: [{ type: 'text', text: 'HTTP 503' }] },
      output: 'HTTP 503', isError: true },
    { name: 'error without details', status: 'failed', output: '工具调用失败，未返回具体原因', isError: true },
    { name: 'blank text without details', status: 'failed',
      result: { content: [{ type: 'text', text: '\n  ' }, { type: 'image', data: 'binary' }] },
      output: '工具调用失败，未返回具体原因', isError: true },
    { name: 'successful data containing code and message', status: 'completed',
      result: { structuredContent: { code: 'ok', message: '查询成功' }, content: [{ type: 'text', text: '正常结果' }] },
      output: '正常结果', isError: false },
    { name: 'successful structured result without text', status: 'completed',
      result: { structuredContent: { count: 1 } }, output: '', isError: false }
  ])('normalizes MCP $name', ({ status, error, result, output, isError }) => {
    const event = normalizeAppServerEvent({ runId: 'run_1', seq: 1, raw: {
      method: 'item/completed', params: { item: { type: 'mcpToolCall', id: 'call_1', status, error, result, durationMs: 12 } }
    } });
    expect(event).toMatchObject({ type: 'tool_result', payload: { toolCallId: 'call_1', output, isError, durationMs: 12 } });
    if (event.payload.type !== 'tool_result') throw new Error('missing MCP tool result');
    expect(event.payload.response).toEqual(result?.structuredContent);
    expect(JSON.stringify(event)).not.toContain('binary');
  });

  it('normalizes file change items as visible file_change events', () => {
    const event = normalizeCodexEvent({
      runId: 'run_1',
      seq: 3,
      raw: {
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'file_change',
          changes: [
            { path: '/repo/放假.md', kind: 'add' },
            { path: '/repo/old.md', kind: 'delete' },
            { path: 123, kind: 'replace' }
          ],
          status: 'completed'
        }
      }
    });

    expect(event.type).toBe('file_change');
    expect(event.payload).toMatchObject({
      type: 'file_change',
      changes: [
        { path: '/repo/放假.md', kind: 'add' },
        { path: '/repo/old.md', kind: 'delete' },
        { path: '', kind: 'unknown' }
      ],
      status: 'completed'
    });
  });

  it('normalizes public reasoning summaries', () => {
    const event = normalizeCodexEvent({
      runId: 'run_1',
      seq: 4,
      raw: {
        type: 'item.completed',
        item: {
          type: 'reasoning',
          summary: [
            { type: 'summary_text', text: '我先确认项目结构和可用命令。' },
            { type: 'summary_text', text: '然后运行测试验证结果。' }
          ]
        }
      }
    });

    expect(event.type).toBe('reasoning_summary');
    expect(event.payload).toMatchObject({
      type: 'reasoning_summary',
      text: '我先确认项目结构和可用命令。\n\n然后运行测试验证结果。',
      format: 'plain_text',
      delivery: 'summary'
    });
  });

  it('normalizes reasoning summaries from text fields', () => {
    const event = normalizeCodexEvent({
      runId: 'run_1',
      seq: 4,
      raw: {
        type: 'item.completed',
        item: {
          type: 'reasoning',
          text: '我会先读取输入，再给出结果。'
        }
      }
    });

    expect(event.type).toBe('reasoning_summary');
    expect(event.payload).toMatchObject({
      type: 'reasoning_summary',
      text: '我会先读取输入，再给出结果。'
    });
  });

  it('normalizes top-level Codex stream errors as visible runtime errors', () => {
    const event = normalizeCodexEvent({
      runId: 'run_1',
      seq: 5,
      raw: {
        type: 'error',
        message: 'Reconnecting... 1/5 (unexpected status 503 Service Unavailable)'
      }
    });

    expect(event.type).toBe('error');
    expect(event.payload).toMatchObject({
      type: 'error',
      code: 'CODEX_STREAM_ERROR',
      message: 'Reconnecting... 1/5 (unexpected status 503 Service Unavailable)'
    });
  });

  it('normalizes Codex error items as visible diagnostics', () => {
    const event = normalizeCodexEvent({
      runId: 'run_1',
      seq: 6,
      raw: {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'error',
          message: 'Skill descriptions were shortened to fit the skills context budget.'
        }
      }
    });

    expect(event.type).toBe('diagnostic');
    expect(event.payload).toMatchObject({
      type: 'diagnostic',
      code: 'CODEX_ITEM_ERROR',
      severity: 'warning',
      message: 'Skill descriptions were shortened to fit the skills context budget.'
    });
  });

  it('读取配置告警的 summary 并保留详情和配置路径', () => {
    const params = { summary: '配置项已弃用', details: '请改用新的配置项。', path: '/runtime/config.toml', range: null };
    const event = normalizeAppServerEvent({ runId: 'run_warning', seq: 1, raw: { method: 'configWarning', params } });
    expect(event).toMatchObject({ type: 'diagnostic', payload: {
      code: 'CODEX_WARNING', severity: 'warning', message: params.summary, details: { raw: params }
    } });
  });

  it.each(['warning', 'guardianWarning'])('保留 %s 的 message', method => {
    const params = { message: '运行环境权限受限', threadId: 'thread_warning' };
    const event = normalizeAppServerEvent({ runId: 'run_warning', seq: 1, raw: { method, params } });
    expect(event).toMatchObject({ type: 'diagnostic', payload: {
      code: 'CODEX_WARNING', severity: 'warning', message: params.message, details: { raw: params }
    } });
  });

  it('shows app-server reconnect attempts as warnings instead of terminal errors', () => {
    const event = normalizeAppServerEvent({
      runId: 'run_1',
      seq: 7,
      raw: {
        method: 'error',
        params: {
          error: {
            message: 'Reconnecting... 1/5',
            codexErrorInfo: {
              responseStreamDisconnected: {
                httpStatusCode: null
              }
            }
          },
          additionalDetails: 'stream disconnected before completion'
        }
      }
    });

    expect(event.type).toBe('diagnostic');
    expect(event.payload).toMatchObject({
      type: 'diagnostic',
      code: 'CODEX_STREAM_RETRYING',
      severity: 'warning',
      message: '模型响应连接中断，具体原因未返回，正在重试（1/5）',
      modelResponse: { errorCode: 'responseStreamDisconnected', retryAttempt: 1, retryLimit: 5 }
    });
  });

  it.each(['error', 'turn/completed'])('将 %s 中的 Codex 底层错误传入会话事件', method => {
    const error = { message: 'Response protection failed', additionalDetails: 'Unsupported response event', codexErrorInfo: 'other' };
    const event = normalizeAppServerEvent({ runId: 'run_protection', seq: 1,
      raw: { method, params: method === 'error' ? { error, willRetry: false } : { turn: { status: 'failed', error } } } });
    expect(event).toMatchObject({ type: 'error', payload: { modelResponse: {
      runtimeMessage: 'Response protection failed', runtimeDetails: 'Unsupported response event', retrying: false
    } } });
  });

  it('forwards app-server MCP progress into the UI event stream', () => {
    const event = normalizeAppServerEvent({
      runId: 'run_1',
      seq: 8,
      raw: {
        method: 'item/mcpToolCall/progress',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_1',
          itemId: 'mcp_call_1',
          message: '任务已接收，正在执行'
        }
      }
    });

    expect(event).toMatchObject({
      type: 'diagnostic',
      rawEventId: 'mcp_call_1',
      payload: {
        type: 'diagnostic',
        code: 'MCP_TOOL_PROGRESS',
        severity: 'info',
        message: '任务已接收，正在执行',
        details: {
          itemId: 'mcp_call_1',
          threadId: 'thread_1',
          turnId: 'turn_1'
        }
      }
    });
  });

  it('normalizes turn completion as finalizing before daemon exit decides done', () => {
    const event = normalizeCodexEvent({
      runId: 'run_1',
      seq: 3,
      raw: { type: 'turn.completed' }
    });
    expect(event.type).toBe('status');
    expect(event.payload).toMatchObject({ type: 'status', label: 'finalizing' });
  });

  it('uses fallback raw event id inside unknown event payload', () => {
    const event = normalizeCodexEvent({
      runId: 'run_1',
      seq: 3,
      raw: {
        id: 'raw_evt_1',
        type: 'unexpected.event'
      }
    });
    expect(event.type).toBe('unknown_event');
    expect(event.rawEventId).toBe('raw_evt_1');
    expect(event.payload).toMatchObject({
      type: 'unknown_event',
      rawEventId: 'run_1:3',
      codexType: 'unexpected.event'
    });
  });
});
