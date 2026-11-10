import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function runSmoke(configPath) {
  const child = spawn(process.execPath, ['scripts/ragflow-smoke.mjs'], {
    env: { ...process.env, CLAWEE_RAGFLOW_SMOKE_CONFIG: configPath, RAGFLOW_FIXTURE_KEY: 'fixture-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'close');
  return { code, output };
}

for (const mode of ['成功', '解析失败', '清理失败']) {
  test(`RAGFlow smoke 使用隔离契约并精确清理：${mode}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'ragflow-smoke-fixture-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const calls = [];
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer fixture-key');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const url = new URL(req.url, 'http://localhost');
      calls.push(`${req.method} ${url.pathname}`);
      const respond = data => res.end(JSON.stringify({ code: 0, data }));
      if (req.method === 'DELETE') {
        assert.deepEqual(JSON.parse(raw), { ids: ['fixture-dataset'] });
        if (mode === '清理失败') res.end(JSON.stringify({ code: 109, message: 'vendor-secret' }));
        else respond(null);
      } else if (url.pathname === '/api/v1/datasets') {
        const body = JSON.parse(raw);
        assert.match(body.name, /^P1隔离验收-/);
        delete body.name;
        assert.deepEqual(body, { language: 'Chinese', parse_type: 1, parser_id: 'general', permission: 'me' });
        respond({ id: 'fixture-dataset' });
      } else if (url.pathname.endsWith('/chunks')) {
        assert.deepEqual(JSON.parse(raw), { document_ids: ['fixture-document'] });
        if (mode === '解析失败') res.end(JSON.stringify({ code: 105, message: 'vendor-secret' }));
        else respond(null);
      } else if (url.pathname.endsWith('/documents') && req.method === 'POST') {
        assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.match(raw, /name="file"; filename="p1-fixture.txt"/);
        assert.match(raw, /37天/);
        respond([{ id: 'fixture-document' }]);
      } else if (url.pathname.endsWith('/documents')) {
        assert.equal(url.searchParams.get('id'), 'fixture-document');
        respond({ docs: [{ id: 'fixture-document', run: 'DONE' }] });
      } else if (url.pathname === '/api/v1/retrieval') {
        const body = JSON.parse(raw);
        assert.deepEqual(body.dataset_ids, ['fixture-dataset']);
        assert.equal(body.page_size, 5);
        assert.equal(body.top_k, undefined);
        respond({ chunks: [{ id: 'fixture-chunk', dataset_id: 'fixture-dataset', document_id: 'fixture-document', document_keyword: 'p1-fixture.txt', content: '报销期限为37天' }] });
      } else {
        res.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const configPath = join(directory, 'smoke.json');
    await writeFile(configPath, JSON.stringify({ disposable: true, ragflow_base_url: `http://127.0.0.1:${server.address().port}`, api_key_ref: 'RAGFLOW_FIXTURE_KEY' }), { mode: 0o600 });
    const result = await runSmoke(configPath);
    assert.equal(result.code, mode === '成功' ? 0 : 1, result.output);
    assert.equal(calls.filter(call => call.startsWith('DELETE')).length, 1);
    assert.equal(calls.at(-1), 'DELETE /api/v1/datasets');
    assert.doesNotMatch(result.output, /fixture-key|vendor-secret|报销期限/);
    if (mode === '清理失败') assert.match(result.output, /待核对测试数据集 ID：fixture-dataset/);
  });
}

test('RAGFlow smoke 默认拒绝无隔离声明的配置', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ragflow-smoke-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'smoke.json');
  await writeFile(configPath, JSON.stringify({ disposable: false, ragflow_base_url: 'http://127.0.0.1:1', api_key_ref: 'RAGFLOW_FIXTURE_KEY' }));
  const result = await runSmoke(configPath);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.output, /fixture-key/);
});
