import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoMultiAgentTools,
  assertNoUsageRequest,
  collectModelToolNames
} from '../../scripts/codex-runtime/app-server-release-contract.mjs';

test('collects nested and plain model tool names', () => {
  assert.deepEqual(collectModelToolNames([
    { type: 'function', name: 'shell' },
    {
      type: 'namespace',
      name: 'browser',
      tools: [{ type: 'function', name: 'open' }]
    },
    {
      type: 'function',
      function: { name: 'apply_patch' }
    }
  ]), [
    'apply_patch',
    'browser',
    'browser.open',
    'shell'
  ]);
});

test('rejects v1 and v2 multi-agent tool surfaces', () => {
  assert.throws(
    () => assertNoMultiAgentTools(['multi_agent_v1.spawn_agent']),
    /CODEX_RUNTIME_MULTI_AGENT_TOOLS_PRESENT/
  );
  assert.throws(
    () => assertNoMultiAgentTools(['collaboration.wait_agent']),
    /CODEX_RUNTIME_MULTI_AGENT_TOOLS_PRESENT/
  );
  assert.throws(
    () => assertNoMultiAgentTools(['spawn_agent']),
    /CODEX_RUNTIME_MULTI_AGENT_TOOLS_PRESENT/
  );
  assert.doesNotThrow(() => assertNoMultiAgentTools([
    'shell',
    'apply_patch',
    'web_search'
  ]));
});

test('rejects Thread Usage requests', () => {
  assert.throws(
    () => assertNoUsageRequest(['initialize', 'account/usage/read']),
    /CODEX_RUNTIME_THREAD_USAGE_REQUESTED/
  );
  assert.doesNotThrow(() => assertNoUsageRequest([
    'initialize',
    'config/read',
    'thread/start',
    'turn/start'
  ]));
});
