import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { zip, type Zippable } from 'fflate';
import { parseSkillMarkdown } from '../codex/skills/validator.js';
import { ENTERPRISE_PACKAGE_MAX_BYTES } from '../enterprise/config-2026-07-30.js';
import {
  ENTERPRISE_ARCHIVE_MAX_EXPANDED_BYTES,
  ENTERPRISE_ARCHIVE_MAX_FILE_BYTES
} from '../enterprise/skill-package-2026-07-30.js';

const EXCLUDED_NAMES = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__']);

export class SkillPackageError extends Error {}

/** 仅打包当前项目或受管理用户技能目录内的一个 Skill，不落盘 ZIP。 */
export async function packageLocalSkill(input: {
  directory: string;
  cwd: string;
  codexHome: string;
}): Promise<Uint8Array> {
  const cwd = await realpath(input.cwd);
  const requested = resolve(cwd, input.directory);
  if ((await lstat(requested)).isSymbolicLink()) {
    throw new SkillPackageError('Skill 目录不能是符号链接。');
  }
  const root = await realpath(requested);
  const skills = resolve(input.codexHome, 'skills');
  const userSkill = relative(skills, requested);
  const inUserSkills = userSkill !== '' && !userSkill.startsWith('.')
    && !isAbsolute(userSkill) && !userSkill.includes(sep);
  const inManagedSkills = inUserSkills && root === join(await realpath(skills), userSkill);
  if (!isWithin(cwd, root) && !inManagedSkills) {
    throw new SkillPackageError('请选择当前项目或当前 CODEX_HOME/skills 下的用户技能目录。');
  }
  if (!(await lstat(root)).isDirectory()) {
    throw new SkillPackageError('请选择包含 SKILL.md 的技能目录。');
  }
  const manifest = await lstat(join(root, 'SKILL.md')).catch(() => undefined);
  if (!manifest?.isFile() || manifest.isSymbolicLink() || manifest.size > 1024 * 1024) {
    throw new SkillPackageError('技能根目录须包含普通文件 SKILL.md，且不能超过 1 MB。');
  }

  const files: Zippable = Object.create(null) as Zippable;
  let entries = 0;
  let totalBytes = 0;
  async function readDirectory(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      if (++entries > 2_000) throw new SkillPackageError('技能目录条目不能超过 2000 个。');
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !isWithin(root, await realpath(path))) {
        throw new SkillPackageError('技能目录不能包含符号链接或目录外文件。');
      }
      if (stat.isDirectory()) {
        await readDirectory(path);
        continue;
      }
      if (!stat.isFile()) throw new SkillPackageError('技能目录只能包含普通文件和目录。');
      if (stat.size > ENTERPRISE_ARCHIVE_MAX_FILE_BYTES || totalBytes + stat.size > ENTERPRISE_ARCHIVE_MAX_EXPANDED_BYTES) {
        throw new SkillPackageError('技能文件或目录内容超出大小限制。');
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
          throw new SkillPackageError('技能文件已变化，请检查后重新上传。');
        }
        // 有界读取，避免文件在检查后增长导致无限分配内存。
        const data = Buffer.alloc(stat.size + 1);
        let size = 0;
        while (size < data.length) {
          const { bytesRead } = await handle.read(data, size, data.length - size, size);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size !== stat.size) throw new SkillPackageError('技能文件已变化，请检查后重新上传。');
        totalBytes += size;
        const name = relative(root, path).split(sep).join('/');
        if (name.includes('\\')) throw new SkillPackageError('技能文件名不能包含反斜杠。');
        files[name] = [data.subarray(0, size), { os: 3, attrs: (0o100000 | (stat.mode & 0o777)) << 16 }];
      } finally {
        await handle.close();
      }
    }
  }
  await readDirectory(root);
  const markdown = files['SKILL.md'];
  if (markdown === undefined || !Array.isArray(markdown)
    || !parseSkillMarkdown(Buffer.from(markdown[0] as Uint8Array).toString('utf8')).ok) {
    throw new SkillPackageError('技能根目录须包含有效的 SKILL.md（name 和 description）。');
  }
  const archive = await new Promise<Uint8Array>((resolveZip, reject) => {
    zip(files, { level: 6 }, (error, data) => error ? reject(error) : resolveZip(data));
  });
  if (archive.byteLength > ENTERPRISE_PACKAGE_MAX_BYTES) {
    throw new SkillPackageError('ZIP 技能包不能超过 50 MB。');
  }
  return archive;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
