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

export function createSkillUsageTracker(input: {
  codexHome: string;
  cwd: string;
  homeDir: string;
  enterpriseVersion?(name: string): { skillId: string; versionId: string } | undefined;
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
  for (const skill of roots.flatMap(root => scanSkills(root.path, root.enterprise, input.enterpriseVersion))) {
    const existing = byDirectory.get(skill.directory);
    if (existing === undefined) byDirectory.set(skill.directory, skill);
    else existing.paths.push(...skill.paths);
  }
  const skills = [...byDirectory.values()];
  const requested = new Set<string>();

  return {
    explicitRequests(prompt: string): SkillUsageEvidence[] {
      const mentions = new Set([...prompt.matchAll(/(?:^|[^\w])\$([A-Za-z0-9_.-]+)/g)].map(match => match[1]).filter((name): name is string => name !== undefined));
      return [...mentions].flatMap(name => {
        const matches = skills.filter(skill => skill.names.includes(name));
        const match = matches.length === 1 ? matches[0] : undefined;
        if (match === undefined) return [];
        requested.add(match.skillKey);
        return [evidence(match, 'explicit_request', 'explicit')];
      });
    },
    observeCommand(command: string, exitCode: number | null): SkillUsageEvidence[] {
      if (exitCode !== 0) return [];
      const read = /^\s*(?:cat|head|tail|less|bat|sed)\s/u.test(command);
      const execute = /^\s*(?:node|bun|python3?|bash|sh|zsh)\s/u.test(command);
      return skills.flatMap(skill => {
        if (read && skill.paths.some(path => containsPath(command, join(path, 'SKILL.md')))) {
          return [evidence(skill, 'skill_file_read', requested.has(skill.skillKey) ? 'explicit' : 'implicit')];
        }
        if (execute && skill.paths.some(path => containsPath(command, join(path, 'scripts') + sep))) {
          return [evidence(skill, 'skill_resource_run', requested.has(skill.skillKey) ? 'explicit' : 'implicit')];
        }
        return [];
      });
    }
  };
}

function scanSkills(
  root: string,
  enterprise: boolean,
  enterpriseVersion?: (name: string) => { skillId: string; versionId: string } | undefined
): Skill[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      try {
        if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !isValidSkillId(entry.name)) return [];
        const installedPath = join(root, entry.name);
        const directory = realpathSync(installedPath);
        const skillFile = join(directory, 'SKILL.md');
        if (!existsSync(skillFile)) return [];
        const parsed = parseSkillMarkdown(readFileSync(skillFile, 'utf8'));
        if (!parsed.ok) return [];
        const name = parsed.metadata.name;
        const installed = enterprise ? enterpriseVersion?.(name) : undefined;
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
    });
  } catch {
    return [];
  }
}

function validLabel(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 128
    && value.trim() === value && !/[\/\\\r\n]/.test(value);
}

function containsPath(command: string, path: string): boolean {
  const index = command.indexOf(path);
  if (index < 0) return false;
  const before = command[index - 1];
  const after = command[index + path.length];
  return (before === undefined || /[\s'"=]/.test(before))
    && (path.endsWith(sep) || after === undefined || /[\s'";&|>]/.test(after));
}

function evidence(
  skill: Skill,
  kind: SkillUsageEvidence['evidence'],
  invocation: SkillUsageEvidence['invocation']
): SkillUsageEvidence {
  const { skillId, skillName, skillKey, source, versionId } = skill;
  return { skillId, skillName, skillKey, source, ...(versionId === undefined ? {} : { versionId }), evidence: kind, invocation };
}
