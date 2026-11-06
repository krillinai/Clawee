import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openPromise } from 'yauzl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageLocalSkill } from '../../src/agent-tools/skill-package.js';
import { extractEnterpriseSkillPackage } from '../../src/enterprise/skill-package-2026-07-30.js';

let root: string;
let cwd: string;
let codexHome: string;
const markdown = '---\nname: weekly-report\ndescription: 整理周报\n---\n生成周报。\n';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clawee-skill-package-'));
  cwd = join(root, 'project');
  codexHome = join(root, 'codex');
  await mkdir(join(cwd, 'weekly-report'), { recursive: true });
  await writeFile(join(cwd, 'weekly-report/SKILL.md'), markdown);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('客户端 Skill 目录打包', () => {
  it('生成可安装的 ZIP，保留二进制、相对路径和脚本执行权限，排除无关目录', async () => {
    const skill = join(cwd, 'weekly-report');
    await mkdir(join(skill, 'scripts'));
    await mkdir(join(skill, '.git'));
    await writeFile(join(skill, '.git/config'), '不能上传');
    await writeFile(join(skill, 'scripts/run.sh'), '#!/bin/sh\necho ok\n');
    await chmod(join(skill, 'scripts/run.sh'), 0o755);
    // Windows 不支持 POSIX 执行位，仍须验证 ZIP 保留源文件的实际权限。
    const sourceMode = (await stat(join(skill, 'scripts/run.sh'))).mode & 0o777;
    if (process.platform !== 'win32') expect(sourceMode).toBe(0o755);
    const binary = Buffer.concat([Buffer.from([0, 255, 128, 0, 1]), randomBytes(512 * 1024)]);
    await writeFile(join(skill, 'asset.bin'), binary);
    const bytes = await packageLocalSkill({ directory: 'weekly-report', cwd, codexHome });
    const archivePath = join(root, 'skill.zip');
    await writeFile(archivePath, bytes);
    const archive = await openPromise(archivePath);
    const modes: Record<string, number> = {};
    for await (const entry of archive.eachEntry()) modes[entry.fileName] = (entry.externalFileAttributes >>> 16) & 0o777;
    expect(Object.keys(modes).sort()).toEqual(['SKILL.md', 'asset.bin', 'scripts/run.sh']);
    expect(modes['scripts/run.sh']).toBe(sourceMode);
    const extracted = join(root, 'extracted');
    await extractEnterpriseSkillPackage({ archivePath, extractionPath: extracted, expectedName: 'weekly-report' });
    expect(await readFile(join(extracted, 'asset.bin'))).toEqual(binary);
    expect(await readFile(join(extracted, 'SKILL.md'), 'utf8')).toBe(markdown);
  });

  it('允许当前 CODEX_HOME 下的用户技能，拒绝项目外目录和内置技能目录', async () => {
    const managed = join(codexHome, 'skills/custom');
    await mkdir(managed, { recursive: true });
    await writeFile(join(managed, 'SKILL.md'), markdown);
    expect((await packageLocalSkill({ directory: managed, cwd, codexHome })).byteLength).toBeGreaterThan(0);
    await expect(packageLocalSkill({ directory: root, cwd, codexHome })).rejects.toThrow('当前项目');
    const builtin = join(codexHome, 'skills/.system/builtin');
    await mkdir(builtin, { recursive: true });
    await expect(packageLocalSkill({ directory: builtin, cwd, codexHome })).rejects.toThrow('当前项目');
  });

  it('拒绝缺少或无效的 SKILL.md', async () => {
    await expect(packageLocalSkill({ directory: '.', cwd, codexHome })).rejects.toThrow('SKILL.md');
    await writeFile(join(cwd, 'weekly-report/SKILL.md'), '无元数据');
    await expect(packageLocalSkill({ directory: 'weekly-report', cwd, codexHome })).rejects.toThrow('SKILL.md');
  });

  it('拒绝根目录链接和嵌套目录链接', async () => {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(join(cwd, 'weekly-report'), join(cwd, 'linked'), linkType);
    await expect(packageLocalSkill({ directory: 'linked', cwd, codexHome })).rejects.toThrow('符号链接');
    await mkdir(join(root, 'private'));
    await writeFile(join(root, 'private/secret.txt'), 'private');
    await symlink(join(root, 'private'), join(cwd, 'weekly-report/secret'), linkType);
    await expect(packageLocalSkill({ directory: 'weekly-report', cwd, codexHome })).rejects.toThrow('符号链接');
  });

  it('拒绝嵌套文件符号链接', async ({ skip }) => {
    await writeFile(join(root, 'private.txt'), 'private');
    try {
      await symlink(join(root, 'private.txt'), join(cwd, 'weekly-report/secret'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('当前 Windows 环境没有创建文件符号链接的权限');
        return;
      }
      throw error;
    }
    await expect(packageLocalSkill({ directory: 'weekly-report', cwd, codexHome })).rejects.toThrow('符号链接');
  });
});
