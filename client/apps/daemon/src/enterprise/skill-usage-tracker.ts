import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isValidSkillId, parseSkillMarkdown } from '../codex/skills/validator.js';

export type SkillUsageEvidence = {
  skillId: string;
  skillName: string;
  skillKey: string;
  source: 'enterprise' | 'local';
  versionId?: string;
  evidence: 'explicit_request' | 'skill_file_read' | 'skill_resource_run';
  invocation: 'explicit' | 'implicit';
};

type Skill = Omit<SkillUsageEvidence, 'evidence' | 'invocation'> & {
  directory: string;
  paths: string[];
  names: string[];
};

export async function createSkillUsageTracker(input: {
  codexHome: string;
  cwd: string;
  homeDir: string;
  enterpriseVersion?(name: string, directory: string): Promise<{ skillId: string; versionId: string } | undefined>;
}) {
  const homeSkills = join(input.codexHome, 'skills');
  const roots: Array<{ path: string; enterprise: boolean }> = [
    { path: homeSkills, enterprise: true },
    { path: join(homeSkills, '.system'), enterprise: false },
    { path: join(input.homeDir, '.agents', 'skills'), enterprise: false }
  ];
  for (let directory = resolve(input.cwd); ; directory = dirname(directory)) {
    roots.push({ path: join(directory, '.agents', 'skills'), enterprise: false });
    if (existsSync(join(directory, '.git')) || dirname(directory) === directory) break;
  }
  const byDirectory = new Map<string, Skill>();
  for (const skill of (await Promise.all(roots.map(root => scanSkills(root.path, root.enterprise, input.enterpriseVersion)))).flat()) {
    const existing = byDirectory.get(skill.directory);
    if (existing === undefined) byDirectory.set(skill.directory, skill);
    else existing.paths.push(...skill.paths);
  }
  const skills = [...byDirectory.values()];
  const requested = new Set<string>();

  return {
    explicitRequests(prompt: string): SkillUsageEvidence[] {
      const mentions = new Set([...prompt.matchAll(/(?:^|[^\w])\$([A-Za-z0-9_.-]+)/g)].map(match => match[1]).filter((name): name is string => name !== undefined));
      const emitted = new Set<string>();
      return [...mentions].flatMap(name => {
        const matches = skills.filter(skill => skill.names.includes(name));
        const match = matches.length === 1 ? matches[0] : undefined;
        if (match === undefined || emitted.has(match.skillKey)) return [];
        emitted.add(match.skillKey);
        requested.add(match.skillKey);
        return [evidence(match, 'explicit_request', 'explicit')];
      });
    },
    observeCommand(command: string, exitCode: number | null): SkillUsageEvidence[] {
      if (exitCode !== 0) return [];
      const args = commandArgs(command);
      if (args === undefined) return [];
      const read = /^(?:cat|head|tail|less|bat|sed)$/.test(args[0] ?? '')
        && (args[0] !== 'sed' || args.length >= 3)
        && !args.includes('--help') && !args.includes('--version');
      const execute = /^(?:node|bun|python3?|bash|sh|zsh)$/.test(args[0] ?? '');
      const readPath = args.at(-1);
      const scriptPath = args[1];
      return skills.flatMap(skill => {
        if (read && readPath !== undefined && skill.paths.some(path => readPath === join(path, 'SKILL.md'))) {
          return [evidence(skill, 'skill_file_read', requested.has(skill.skillKey) ? 'explicit' : 'implicit')];
        }
        if (execute && scriptPath !== undefined && skill.paths.some(path => {
          const prefix = join(path, 'scripts') + sep;
          return scriptPath.startsWith(prefix) && !scriptPath.slice(prefix.length).split(sep).includes('..');
        })) {
          return [evidence(skill, 'skill_resource_run', requested.has(skill.skillKey) ? 'explicit' : 'implicit')];
        }
        return [];
      });
    }
  };
}

async function scanSkills(
  root: string,
  enterprise: boolean,
  enterpriseVersion?: (name: string, directory: string) => Promise<{ skillId: string; versionId: string } | undefined>
): Promise<Skill[]> {
  if (!existsSync(root)) return [];
  try {
    const entries = await Promise.all(readdirSync(root, { withFileTypes: true }).map(async entry => {
      try {
        if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !isValidSkillId(entry.name)) return [];
        const installedPath = join(root, entry.name);
        const directory = realpathSync(installedPath);
        const skillFile = join(directory, 'SKILL.md');
        if (!existsSync(skillFile)) return [];
        const parsed = parseSkillMarkdown(readFileSync(skillFile, 'utf8'));
        if (!parsed.ok) return [];
        const name = parsed.metadata.name;
        const installed = enterprise ? await enterpriseVersion?.(name, directory) : undefined;
        if (!validLabel(name) || !validLabel(installed?.skillId ?? entry.name)
          || (installed !== undefined && !validLabel(installed.versionId))) return [];
        return [{
          directory,
          paths: [installedPath, directory],
          names: [entry.name, name],
          skillId: installed?.skillId ?? entry.name,
          skillName: name,
          skillKey: installed?.skillId ?? createHash('sha256').update(directory).digest('hex'),
          source: installed === undefined ? 'local' as const : 'enterprise' as const,
          ...(installed === undefined ? {} : { versionId: installed.versionId })
        }];
      } catch {
        return [];
      }
    }));
    return entries.flat();
  } catch {
    return [];
  }
}

function validLabel(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 128
    && value.trim() === value && !/[\/\\\r\n]/.test(value);
}

function commandArgs(command: string): string[] | undefined {
  if (/[;&|<>`$#\\\r\n]/.test(command)) return undefined;
  const args: string[] = [];
  const token = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/gy;
  let position = 0;
  while (position < command.length) {
    if (command.slice(position).trim() === '') break;
    token.lastIndex = position;
    const match = token.exec(command);
    if (match === null) return undefined;
    args.push(match[1] ?? match[2] ?? match[3]!);
    position = token.lastIndex;
  }
  return args.length > 1 ? args : undefined;
}

function evidence(
  skill: Skill,
  kind: SkillUsageEvidence['evidence'],
  invocation: SkillUsageEvidence['invocation']
): SkillUsageEvidence {
  const { skillId, skillName, skillKey, source, versionId } = skill;
  return { skillId, skillName, skillKey, source, ...(versionId === undefined ? {} : { versionId }), evidence: kind, invocation };
}
