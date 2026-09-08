import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanCodexSkills } from '../../src/codex/skills/scanner.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('codex skills scanner', () => {
  it('returns an empty list when skills directory does not exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-skills-scan-'));
    const codexHome = join(tempDir, 'codex-home');

    expect(scanCodexSkills({
      codexHome: { path: codexHome, mode: 'isolated', source: 'isolated', writable: true }
    })).toMatchObject({
      codexHome,
      codexHomeMode: 'isolated',
      skillsPath: join(codexHome, 'skills'),
      skillsWritable: true,
      requiresWriteConfirmation: false,
      skills: [],
      diagnostics: []
    });
  });

  it('scans valid and invalid skills without crashing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-skills-scan-'));
    const codexHome = join(tempDir, 'codex-home');
    const validDir = join(codexHome, 'skills', 'valid-skill');
    const invalidDir = join(codexHome, 'skills', 'invalid-skill');
    mkdirSync(validDir, { recursive: true });
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(validDir, 'SKILL.md'), [
      '---',
      'name: valid-skill',
      'description: "A valid skill"',
      '---',
      ''
    ].join('\n'));
    writeFileSync(join(invalidDir, 'SKILL.md'), '# missing frontmatter');

    const result = scanCodexSkills({
      codexHome: { path: codexHome, mode: 'global', source: 'default', writable: false }
    });

    expect(result.skillsWritable).toBe(true);
    expect(result.requiresWriteConfirmation).toBe(true);
    expect(result.skills).toEqual([
      expect.objectContaining({
        id: 'invalid-skill',
        status: 'invalid',
        diagnostics: [expect.stringContaining('frontmatter')]
      }),
      expect.objectContaining({
        id: 'valid-skill',
        name: 'valid-skill',
        description: 'A valid skill',
        status: 'valid',
        diagnostics: []
      })
    ]);
  });

  it('scans bundled system skills and prefers a user skill with the same id', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-skills-scan-'));
    const codexHome = join(tempDir, 'codex-home');
    const skillsPath = join(codexHome, 'skills');
    writeSkill(join(skillsPath, 'custom-skill'), 'custom-skill', 'User skill');
    writeSkill(join(skillsPath, 'imagegen'), 'imagegen', 'User override');
    writeSkill(
      join(skillsPath, '.system', 'imagegen'),
      'imagegen',
      'Bundled system skill'
    );
    writeSkill(
      join(skillsPath, '.system', 'openai-docs'),
      'openai-docs',
      'Bundled documentation skill'
    );

    const result = scanCodexSkills({
      codexHome: { path: codexHome, mode: 'isolated', source: 'isolated', writable: true }
    });

    expect(result.skills.map(skill => ({
      id: skill.id,
      description: skill.description,
      skillPath: skill.skillPath
    }))).toEqual([
      {
        id: 'custom-skill',
        description: 'User skill',
        skillPath: join(skillsPath, 'custom-skill')
      },
      {
        id: 'imagegen',
        description: 'User override',
        skillPath: join(skillsPath, 'imagegen')
      },
      {
        id: 'openai-docs',
        description: 'Bundled documentation skill',
        skillPath: join(skillsPath, '.system', 'openai-docs')
      }
    ]);
    expect(result.skills.some(skill => skill.id === '.system')).toBe(false);
    expect(result.diagnostics).toContain(
      'Ignoring bundled system skill imagegen because a user skill with the same id exists'
    );
  });
});

function writeSkill(path: string, name: string, description: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: "${description}"`,
    '---',
    ''
  ].join('\n'));
}
