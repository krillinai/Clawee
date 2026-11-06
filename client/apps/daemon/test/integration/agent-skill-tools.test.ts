import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCapabilityTokenStore } from '../../src/agent-tools/capability-token.js';
import { registerAgentSkillRoutes } from '../../src/agent-tools/skill-routes.js';
import { registerAgentScheduleMcpRoute } from '../../src/agent-tools/mcp-routes.js';
import type { RuntimeThread } from '../../src/threads/types.js';

let root: string;
let server: FastifyInstance;
let client: Client | undefined;
let tokens: ReturnType<typeof createAgentCapabilityTokenStore>;
let enabled: boolean;
let token: string;
const listSpaces = vi.fn();
const uploadSkill = vi.fn();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clawee-skill-tools-'));
  await mkdir(join(root, 'weekly-report'));
  await writeFile(join(root, 'weekly-report/SKILL.md'), '---\nname: weekly-report\ndescription: 整理周报\n---\n周报。\n');
  enabled = true;
  tokens = createAgentCapabilityTokenStore();
  token = tokens.issue({ runId: 'run-1', threadId: 'thread-1', createdBy: 'api', scopes: ['skill:list_spaces', 'skill:upload'] }).token;
  listSpaces.mockReset().mockResolvedValue({ spaces: [
    { spaceId: 'read-only', name: '只读', actions: ['read'] },
    { spaceId: 'office', name: '综合办公', actions: ['read', 'write'] }
  ] });
  uploadSkill.mockReset().mockResolvedValue({ skillId: 'skill-1', spaceId: 'office', name: 'weekly-report', version: '1.0.0', approvalRequestId: 'review-1' });
  server = Fastify();
  await registerAgentSkillRoutes(server, {
    capabilities: tokens,
    skills: { listSpaces, uploadSkill },
    threads: { getThread: id => id === 'thread-1' ? { id, canonicalCwd: root } as RuntimeThread : undefined },
    codexHome: join(root, 'codex'),
    enabled: () => enabled
  });
  await registerAgentScheduleMcpRoute(server, { capabilities: tokens, getBaseUrl: () => server.listeningOrigin });
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await server.close();
  tokens.close();
  await rm(root, { recursive: true, force: true });
});

const body = { directory: 'weekly-report', spaceId: 'office', version: '1.0.0' };
function upload(payload = body, authorization = token) {
  return server.inject({ method: 'POST', url: '/internal/agent-tools/skills/upload', headers: { authorization: `Bearer ${authorization}` }, payload });
}

describe('对话 Skill 上传链路', () => {
  it('经真实 MCP 查询可写空间并按目录打包，复用现有上传 manager 返回审核信息', async () => {
    await server.listen({ port: 0, host: '127.0.0.1' });
    client = new Client({ name: 'skill-upload-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.listeningOrigin}/internal/agent-tools/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const tools = (await client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toEqual(['clawee_skill_list_spaces', 'clawee_skill_upload']);
    expect(tools[1]?.description).toContain('等待用户明确确认');
    const spaces = await client.callTool({ name: 'clawee_skill_list_spaces', arguments: {} });
    expect(spaces.structuredContent).toEqual({ spaces: [{ spaceId: 'office', name: '综合办公', actions: ['read', 'write'] }] });
    const result = await client.callTool({ name: 'clawee_skill_upload', arguments: body });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ spaceId: 'office', version: '1.0.0', approvalRequestId: 'review-1' });
    const request = uploadSkill.mock.calls[0]![0];
    expect(request).toMatchObject({ spaceId: 'office', version: '1.0.0', changelog: '' });
    expect(request.package).toBeInstanceOf(Uint8Array);
    expect(strFromU8(unzipSync(request.package)['SKILL.md']!)).toContain('整理周报');
    const forged = await client.callTool({ name: 'clawee_skill_upload', arguments: { ...body, accessToken: 'forged', files: [] } });
    expect(forged.isError).toBe(true);
    expect(uploadSkill).toHaveBeenCalledTimes(1);
  });

  it('在读取文件前拒绝无权限空间、未登录、失效授权和伪造上下文', async () => {
    expect((await upload({ ...body, spaceId: 'read-only' })).statusCode).toBe(403);
    expect((await upload({ ...body, threadId: 'forged' } as typeof body)).statusCode).toBe(400);
    enabled = false;
    expect((await upload()).statusCode).toBe(403);
    enabled = true;
    tokens.revokeRun('run-1');
    expect((await upload()).statusCode).toBe(401);
    expect(uploadSkill).not.toHaveBeenCalled();
  });

  it('上传时重查空间权限，拒绝自动任务取得上传能力', async () => {
    listSpaces.mockResolvedValue({ spaces: [{ spaceId: 'office', name: '综合办公', actions: ['read'] }] });
    expect((await upload()).statusCode).toBe(403);
    expect(uploadSkill).not.toHaveBeenCalled();
    expect(() => tokens.issue({ runId: 'automatic', threadId: 'thread-1', createdBy: 'schedule', scopes: ['skill:upload'] })).toThrow();
  });
});
