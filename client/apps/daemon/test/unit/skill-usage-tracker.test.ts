import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillUsageTracker } from '../../src/enterprise/skill-usage-tracker.js';
import { computeEnterpriseSkillContentDigest } from '../../src/enterprise/skill-content-digest-2026-07-30.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clawee-skill-usage-'));
  roots.push(root);
  const codexHome = join(root, 'codex-home');
  const cwd = join(root, 'project', 'src');
  const skillPath = join(codexHome, 'skills', 'reports');
  const projectSkill = join(root, 'project', '.agents', 'skills', 'review');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(skillPath, 'scripts'), { recursive: true });
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(join(skillPath, 'SKILL.md'), '---\nname: reports\ndescription: reports\n---\n');
  writeFileSync(join(skillPath, 'scripts', 'build.js'), '');
  writeFileSync(join(projectSkill, 'SKILL.md'), '---\nname: review\ndescription: review\n---\n');
  return { root, codexHome, cwd, skillPath, projectSkill };
}

describe('skill usage tracker', () => {
  it('recognizes installed explicit requests but not plain mentions', async () => {
    const { root, codexHome, cwd } = fixture();
    const tracker = await createSkillUsageTracker({ codexHome, cwd, homeDir: root });
    expect(tracker.explicitRequests('请使用 $reports 和 $review，reports 也可以')).toEqual([
      expect.objectContaining({ skillId: 'reports', evidence: 'explicit_request', invocation: 'explicit' }),
      expect.objectContaining({ skillId: 'review', evidence: 'explicit_request', invocation: 'explicit' })
    ]);
    expect(tracker.explicitRequests('reports 很有用，$unknown 也试试')).toEqual([]);
  });

  it('records successful reads and script runs without leaking the command', async () => {
    const { root, codexHome, cwd, skillPath } = fixture();
    const tracker = await createSkillUsageTracker({ codexHome, cwd, homeDir: root });
    const skillFile = join(skillPath, 'SKILL.md');
    expect(tracker.observeCommand(`cat '${skillFile}'`, 0)).toEqual([
      expect.objectContaining({ skillId: 'reports', evidence: 'skill_file_read', invocation: 'implicit' })
    ]);
    expect(tracker.observeCommand(`node ${join(skillPath, 'scripts', 'build.js')}`, 0)).toEqual([
      expect.objectContaining({ skillId: 'reports', evidence: 'skill_resource_run', invocation: 'implicit' })
    ]);
    expect(tracker.observeCommand(`echo 'cat ${skillFile}'`, 0)).toEqual([]);
    expect(tracker.observeCommand(`ls ${skillPath}`, 0)).toEqual([]);
    expect(tracker.observeCommand(`cat ${skillFile}`, 1)).toEqual([]);
    expect(tracker.observeCommand(`cat ${skillFile}`, null)).toEqual([]);
    expect(tracker.observeCommand(`cat ${skillFile} || true`, 0)).toEqual([]);
    expect(tracker.observeCommand(`node ${join(skillPath, 'scripts', 'build.js')} ; true`, 0)).toEqual([]);
    expect(tracker.observeCommand(`cat /dev/null # ${skillFile}`, 0)).toEqual([]);
    expect(tracker.observeCommand(`cat --help ${skillFile}`, 0)).toEqual([]);
    expect(tracker.observeCommand(`sed '${skillFile}'`, 0)).toEqual([]);
    expect(tracker.observeCommand(`node -e "console.log('${join(skillPath, 'scripts', 'build.js')}')"`, 0)).toEqual([]);
    expect(tracker.observeCommand(`node --check ${join(skillPath, 'scripts', 'build.js')}`, 0)).toEqual([]);
    expect(tracker.observeCommand(`node /tmp/other.js ${join(skillPath, 'scripts', 'build.js')}`, 0)).toEqual([]);
    expect(tracker.observeCommand(`node ${join(skillPath, 'scripts')}/../SKILL.md`, 0)).toEqual([]);
    expect(tracker.observeCommand(`sed -n '1,5p' '${skillFile}'`, 0)).toEqual([
      expect.objectContaining({ evidence: 'skill_file_read' })
    ]);
  });

  it('classifies observed use after an explicit request and skips ambiguous names', async () => {
    const { root, codexHome, cwd, skillPath } = fixture();
    const tracker = await createSkillUsageTracker({ codexHome, cwd, homeDir: root });
    expect(tracker.explicitRequests('$reports')).toHaveLength(1);
    expect(tracker.observeCommand(`cat ${join(skillPath, 'SKILL.md')}`, 0)).toEqual([
      expect.objectContaining({ evidence: 'skill_file_read', invocation: 'explicit' })
    ]);
    const duplicate = join(cwd, '..', '.agents', 'skills', 'reports');
    mkdirSync(duplicate, { recursive: true });
    writeFileSync(join(duplicate, 'SKILL.md'), '---\nname: reports\ndescription: duplicate\n---\n');
    expect((await createSkillUsageTracker({ codexHome, cwd, homeDir: root })).explicitRequests('$reports')).toEqual([]);
  });

  it('includes user-level Agent skills', async () => {
    const { root, codexHome, cwd } = fixture();
    const globalSkill = join(root, '.agents', 'skills', 'global-review');
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(join(globalSkill, 'SKILL.md'), '---\nname: global-review\ndescription: review\n---\n');
    const tracker = await createSkillUsageTracker({ codexHome, cwd, homeDir: root });
    expect(tracker.explicitRequests('$global-review')).toEqual([
      expect.objectContaining({ skillId: 'global-review', source: 'local' })
    ]);
  });

  it('reports a request once when directory and metadata names are both used', async () => {
    const { root, codexHome, cwd, projectSkill } = fixture();
    writeFileSync(join(projectSkill, 'SKILL.md'), '---\nname: project-review\ndescription: review\n---\n');
    const tracker = await createSkillUsageTracker({ codexHome, cwd, homeDir: root });
    expect(tracker.explicitRequests('$review $project-review')).toHaveLength(1);
  });

  it('keeps healthy skills when a neighboring link is broken and associates enterprise versions', async () => {
    const { root, codexHome, cwd } = fixture();
    symlinkSync(join(root, 'missing'), join(codexHome, 'skills', 'broken'));
    const tracker = await createSkillUsageTracker({
      codexHome, cwd, homeDir: root,
      enterpriseVersion: async name => name === 'reports' ? { skillId: 'skill_1', versionId: 'version_1' } : undefined
    });
    expect(tracker.explicitRequests('$reports')).toEqual([
      expect.objectContaining({ skillId: 'skill_1', skillKey: 'skill_1', source: 'enterprise', versionId: 'version_1' })
    ]);
  });

  it('keeps mismatched enterprise content as local evidence', async () => {
    const { root, codexHome, cwd, skillPath } = fixture();
    const installedDigest = await computeEnterpriseSkillContentDigest(skillPath);
    writeFileSync(join(skillPath, 'scripts', 'build.js'), 'changed');
    const tracker = await createSkillUsageTracker({
      codexHome, cwd, homeDir: root,
      enterpriseVersion: async (name, directory) => name === 'reports' &&
        await computeEnterpriseSkillContentDigest(directory) === installedDigest
        ? { skillId: 'enterprise-1', versionId: 'version-1' } : undefined
    });
    expect(tracker.explicitRequests('$reports')).toEqual([
      expect.objectContaining({ source: 'local', skillId: 'reports' })
    ]);
  });
});
