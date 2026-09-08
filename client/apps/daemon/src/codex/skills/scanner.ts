import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedCodexHome } from '../home.js';
import type { CodexSkillResponse, SkillScanResult } from './types.js';
import { isValidSkillId, parseSkillMarkdown } from './validator.js';

const SYSTEM_SKILLS_DIRECTORY = '.system';

export function skillsPathForCodexHome(codexHome: string): string {
  return join(codexHome, 'skills');
}

export function scanCodexSkills(input: { codexHome: ResolvedCodexHome }): SkillScanResult {
  const skillsPath = skillsPathForCodexHome(input.codexHome.path);
  const diagnostics: string[] = [];
  const userSkills = readSkillDirectories({
    codexHome: input.codexHome,
    skillsPath,
    scanPath: skillsPath,
    diagnostics,
    excludedDirectoryNames: new Set([SYSTEM_SKILLS_DIRECTORY])
  });
  const systemSkills = readSkillDirectories({
    codexHome: input.codexHome,
    skillsPath,
    scanPath: join(skillsPath, SYSTEM_SKILLS_DIRECTORY),
    diagnostics
  });
  const skills = mergeSkillsById(userSkills, systemSkills, diagnostics);

  return {
    codexHome: input.codexHome.path,
    codexHomeMode: input.codexHome.mode,
    skillsPath,
    skillsWritable: true,
    requiresWriteConfirmation: input.codexHome.mode === 'global',
    skills: skills.sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics
  };
}

function readSkillDirectories(input: {
  codexHome: ResolvedCodexHome;
  skillsPath: string;
  scanPath: string;
  diagnostics: string[];
  excludedDirectoryNames?: ReadonlySet<string>;
}): CodexSkillResponse[] {
  if (!existsSync(input.scanPath)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(input.scanPath, { withFileTypes: true });
  } catch (error) {
    input.diagnostics.push(
      `Failed to scan skills directory ${input.scanPath}: ${formatError(error)}`
    );
    return [];
  }

  return entries
    .filter((entry) => (
      entry.isDirectory()
      && input.excludedDirectoryNames?.has(entry.name) !== true
    ))
    .flatMap((entry) => {
      const skill = readSkillDirectory(
        input.codexHome,
        input.skillsPath,
        input.scanPath,
        entry.name,
        input.diagnostics
      );
      return skill === undefined ? [] : [skill];
    });
}

function readSkillDirectory(
  codexHome: ResolvedCodexHome,
  skillsPath: string,
  scanPath: string,
  id: string,
  diagnostics: string[]
): CodexSkillResponse | undefined {
  if (!isValidSkillId(id)) {
    diagnostics.push(`Ignoring invalid skill directory name: ${id}`);
    return undefined;
  }

  const skillPath = join(scanPath, id);
  const skillFilePath = join(skillPath, 'SKILL.md');
  let updatedAt: string | undefined;
  try {
    updatedAt = statSync(skillPath).mtime.toISOString();
  } catch (error) {
    diagnostics.push(`Failed to stat skill ${id}: ${formatError(error)}`);
  }

  let content: string;
  try {
    content = readFileSync(skillFilePath, 'utf8');
  } catch (error) {
    return invalidSkill(codexHome, skillsPath, skillPath, skillFilePath, id, [
      `Failed to read SKILL.md: ${formatError(error)}`
    ], updatedAt);
  }

  const parsed = parseSkillMarkdown(content);
  if (!parsed.ok) {
    return invalidSkill(codexHome, skillsPath, skillPath, skillFilePath, id, parsed.diagnostics, updatedAt);
  }

  return {
    id,
    name: parsed.metadata.name,
    description: parsed.metadata.description,
    status: 'valid',
    diagnostics: [],
    codexHome: codexHome.path,
    codexHomeMode: codexHome.mode,
    skillsPath,
    skillPath,
    skillFilePath,
    updatedAt
  };
}

function mergeSkillsById(
  userSkills: CodexSkillResponse[],
  systemSkills: CodexSkillResponse[],
  diagnostics: string[]
): CodexSkillResponse[] {
  const skills = [...userSkills];
  const userSkillIds = new Set(userSkills.map(skill => skill.id));
  for (const systemSkill of systemSkills) {
    if (userSkillIds.has(systemSkill.id)) {
      diagnostics.push(
        `Ignoring bundled system skill ${systemSkill.id} because a user skill with the same id exists`
      );
      continue;
    }
    skills.push(systemSkill);
  }
  return skills;
}

function invalidSkill(
  codexHome: ResolvedCodexHome,
  skillsPath: string,
  skillPath: string,
  skillFilePath: string,
  id: string,
  skillDiagnostics: string[],
  updatedAt?: string
): CodexSkillResponse {
  return {
    id,
    status: 'invalid',
    diagnostics: skillDiagnostics,
    codexHome: codexHome.path,
    codexHomeMode: codexHome.mode,
    skillsPath,
    skillPath,
    skillFilePath,
    updatedAt
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
