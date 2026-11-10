import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)));

function controlledError(operation, detail) {
  return new Error(`${operation}：${detail}`);
}

async function loadConfig() {
  const filename = process.env.CLAWEE_RAGFLOW_SMOKE_CONFIG;
  if (!filename || !path.isAbsolute(filename)) {
    throw controlledError('配置', '请用 CLAWEE_RAGFLOW_SMOKE_CONFIG 指定仓库外的绝对配置路径');
  }
  const resolved = await realpath(filename);
  const relative = path.relative(repoRoot, resolved);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw controlledError('配置', '配置必须位于仓库外');
  }
  const config = JSON.parse(await readFile(resolved, 'utf8'));
  if (config.disposable !== true) {
    throw controlledError('配置', '必须显式设置 disposable: true，确认使用专用测试环境及服务账号');
  }
  const url = new URL(config.ragflow_base_url);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || /[?#]/.test(config.ragflow_base_url)) {
    throw controlledError('配置', 'ragflow_base_url 必须是无凭据、路径、查询串和片段的 HTTP(S) 根地址');
  }
  if (typeof config.api_key_ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.api_key_ref)) {
    throw controlledError('配置', 'api_key_ref 必须是专用 API Key 的环境变量名称');
  }
  const key = process.env[config.api_key_ref]?.trim();
  if (!key) throw controlledError('配置', '专用 API Key 环境变量为空');
  if (config.embedding_model !== undefined && typeof config.embedding_model !== 'string') {
    throw controlledError('配置', 'embedding_model 必须是字符串');
  }
  return { baseURL: url.origin, key, embeddingModel: config.embedding_model?.trim() };
}

function documentStatus(run) {
  if (['DONE', '3', 3].includes(run)) return 'ready';
  if (['FAIL', '4', 4, 'CANCEL', '2', 2].includes(run)) return 'failed';
  if (['UNSTART', '0', 0, 'RUNNING', '1', 1, 'SCHEDULE', '5', 5].includes(run)) return 'processing';
  return 'unknown';
}

async function main() {
  const config = await loadConfig();
  async function request(operation, method, suffix, body, timeout = 30_000) {
    let response;
    try {
      response = await fetch(`${config.baseURL}/api/v1${suffix}`, {
        method,
        headers: { Authorization: `Bearer ${config.key}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw controlledError(operation, '请求失败或超时，结果待核对');
    }
    let envelope;
    try { envelope = await response.json(); } catch { throw controlledError(operation, `响应协议错误（HTTP ${response.status}）`); }
    if (!response.ok || !Number.isInteger(envelope?.code) || envelope.code !== 0) {
      const code = Number.isInteger(envelope?.code) ? envelope.code : 'missing';
      throw controlledError(operation, `上游失败（HTTP ${response.status}，code ${code}）`);
    }
    return envelope.data;
  }

  let datasetID;
  let failure;
  let state = 'creating';
  try {
    const body = { name: `P1隔离验收-${randomUUID()}`, language: 'Chinese', parse_type: 1, parser_id: 'general', permission: 'me' };
    if (config.embeddingModel) body.embedding_model = config.embeddingModel;
    const dataset = await request('创建数据集', 'POST', '/datasets', body);
    if (typeof dataset?.id !== 'string' || !dataset.id.trim()) throw controlledError('创建数据集', '缺少返回 ID，结果待核对');
    datasetID = dataset.id;
    const datasetPath = `/datasets/${encodeURIComponent(datasetID)}`;
    state = 'uploading';
    const form = new FormData();
    form.append('file', new Blob(['P1验收：报销期限为37天。'], { type: 'text/plain' }), 'p1-fixture.txt');
    const uploaded = await request('上传文档', 'POST', `${datasetPath}/documents`, form);
    if (!Array.isArray(uploaded) || uploaded.length !== 1 || typeof uploaded[0]?.id !== 'string' || !uploaded[0].id.trim()) {
      throw controlledError('上传文档', '返回文档结构或 ID 无效');
    }
    const documentID = uploaded[0].id;
    await request('启动解析', 'POST', `${datasetPath}/chunks`, { document_ids: [documentID] });
    state = 'processing';
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const query = new URLSearchParams({ id: documentID, page: '1', page_size: '100' });
      const data = await request('查询状态', 'GET', `${datasetPath}/documents?${query}`, undefined, Math.max(1, Math.min(30_000, remaining)));
      if (!Array.isArray(data?.docs) || data.docs.length !== 1 || data.docs[0]?.id !== documentID) throw controlledError('查询状态', '目标文档结构无效');
      state = documentStatus(data.docs[0].run);
      if (state === 'ready') break;
      if (state !== 'processing') throw controlledError('解析', `文档状态 ${state}`);
      await delay(Math.min(2000, Math.max(0, deadline - Date.now())));
    }
    if (state !== 'ready') throw controlledError('解析', '等待超过 180 秒');
    const retrieval = await request('检索', 'POST', '/retrieval', {
      question: '验收资料中的报销期限是多少天？', dataset_ids: [datasetID], page: 1, page_size: 5,
      highlight: false, use_kg: false, include_knowledge_compilation: false,
    });
    if (!Array.isArray(retrieval?.chunks) || retrieval.chunks.some(chunk => chunk.dataset_id && chunk.dataset_id !== datasetID)) {
      throw controlledError('检索', '返回片段结构或数据集范围无效');
    }
    const names = new Map((Array.isArray(retrieval.doc_aggs) ? retrieval.doc_aggs : []).map(doc => [doc.document_id, doc.doc_name]));
    if (!retrieval.chunks.some(chunk => chunk.id && chunk.document_id === documentID && typeof chunk.content === 'string' && chunk.content.includes('37天') && (chunk.document_keyword || names.get(documentID)))) {
      throw controlledError('检索', '未命中验收期限或缺少文档来源');
    }
  } catch (error) {
    failure = error;
  } finally {
    if (datasetID) {
      try {
        await request('清理测试数据集', 'DELETE', '/datasets', { ids: [datasetID] });
      } catch {
        // 仅报告本次已取得的对象 ID，供运维精确核对。
        console.error(`清理失败，待核对测试数据集 ID：${datasetID}`);
        failure ??= controlledError('清理', '测试数据集未确认删除');
      }
    }
  }
  if (failure) {
    console.error(`RAGFlow 隔离 smoke 失败，阶段状态：${state}；${failure.message}`);
    process.exitCode = 1;
  } else {
    console.log('RAGFlow 1.0 隔离 smoke 通过：创建、上传、解析、检索及精确清理完成。');
  }
}

main().catch(() => {
  console.error('RAGFlow 隔离 smoke 配置无效或不可读取；请检查仓库外配置及专用凭据环境变量。');
  process.exitCode = 1;
});
