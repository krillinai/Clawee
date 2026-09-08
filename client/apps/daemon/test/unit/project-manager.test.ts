import type Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectManager } from '../../src/projects/manager.js';
import { ProjectManagerError } from '../../src/projects/types.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';

let tempDir = '';
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('project manager', () => {
  it('ensures one default project inside the managed Clawee directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-default-project-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'Clawee');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    let nextId = 0;
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => `project_default_${++nextId}`
    });

    const first = manager.ensureDefaultProject();
    const repeated = manager.ensureDefaultProject();

    expect(first).toMatchObject({
      id: 'project_default_1',
      name: '默认项目',
      cwd: join(managedProjectRoot, 'Default Project'),
      directoryState: 'available'
    });
    expect(repeated).toEqual(first);
    expect(existsSync(join(managedProjectRoot, 'Default Project'))).toBe(true);
    expect(manager.listProjects('all')).toEqual([first]);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM projects').get()
    ).toEqual({ count: 1 });
  });

  it('creates named projects inside the managed Clawee directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-managed-project-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'Clawee');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => 'project_managed'
    });

    const created = manager.createManagedProject({ name: ' 产品官网 ' });

    expect(created).toMatchObject({
      id: 'project_managed',
      name: '产品官网',
      cwd: join(managedProjectRoot, '产品官网'),
      directoryState: 'available'
    });
    expect(existsSync(join(managedProjectRoot, '产品官网'))).toBe(true);
  });

  it('creates named projects inside a selected parent directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-managed-project-'));
    const selectedParent = join(tempDir, 'selected');
    mkdirSync(selectedParent);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => 'project_selected'
    });

    const created = manager.createManagedProject({
      name: '客户官网',
      parentCwd: selectedParent
    });

    expect(created).toMatchObject({
      id: 'project_selected',
      name: '客户官网',
      cwd: join(realpathSync(selectedParent), '客户官网'),
      directoryState: 'available'
    });
    expect(existsSync(join(selectedParent, '客户官网'))).toBe(true);
  });

  it('removes a newly created empty directory when registration fails', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-managed-project-'));
    const projectDir = join(tempDir, 'Documents', 'Clawee', '未注册项目');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => ''
    });

    expect(() => manager.createManagedProject({ name: '未注册项目' }))
      .toThrow('Unable to allocate a unique project id');
    expect(existsSync(projectDir)).toBe(false);
  });

  it('rejects invalid or duplicate managed project names', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-managed-project-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'Clawee');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({ db, managedProjectRoot });

    for (const name of ['', '   ', '.', '..', 'nested/project', 'nested\\project']) {
      expect(() => manager.createManagedProject({ name })).toThrowError(
        expect.objectContaining({ code: 'PROJECT_NAME_INVALID' })
      );
    }

    manager.createManagedProject({ name: '重复项目' });
    expect(() => manager.createManagedProject({ name: '重复项目' })).toThrowError(
      expect.objectContaining({ code: 'PROJECT_DIRECTORY_CONFLICT' })
    );
  });

  it('persists projects and preserves a missing migrated directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-project-'));
    const projectDir = join(tempDir, 'workspace');
    mkdirSync(projectDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => 'project_generated'
    });

    const created = manager.createProject({
      cwd: projectDir,
      name: 'Workspace'
    });
    const missing = manager.createMigratedProject({
      preferredId: 'legacy_missing',
      cwd: join(tempDir, 'missing'),
      name: 'Missing'
    });

    expect(created).toMatchObject({
      id: 'project_generated',
      cwd: projectDir,
      canonicalCwd: realpathSync(projectDir),
      directoryState: 'available',
      profile: 'default',
      sandbox: 'follow-global',
      status: 'active'
    });
    expect(missing).toMatchObject({
      id: 'legacy_missing',
      canonicalCwd: null,
      directoryState: 'missing'
    });

    db.close();
    db = undefined;
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const reopened = createProjectManager({ db, homeDir: tempDir });
    expect(reopened.getProject(created.id)).toMatchObject({
      id: created.id,
      name: 'Workspace',
      directoryState: 'available'
    });
    expect(reopened.getProject(missing.id)).toMatchObject({
      id: missing.id,
      directoryState: 'missing'
    });
  });

  it('finds exact project name matches within the requested status', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-project-name-'));
    const firstDir = join(tempDir, 'first');
    const secondDir = join(tempDir, 'second');
    mkdirSync(firstDir);
    mkdirSync(secondDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    let nextId = 0;
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => `project_name_${++nextId}`
    });
    const first = manager.createProject({ cwd: firstDir, name: '同名项目' });
    const second = manager.createProject({ cwd: secondDir, name: '同名项目' });
    manager.archiveProject(second.id);

    expect(manager.findProjectsByName('同名项目', 'active').map(project => project.id))
      .toEqual([first.id]);
    expect(manager.findProjectsByName('同名项目', 'archived').map(project => project.id))
      .toEqual([second.id]);
    expect(manager.findProjectsByName('同名项目', 'all')).toHaveLength(2);
    expect(manager.findProjectsByName('同名')).toEqual([]);
  });

  it('persists a custom order for active projects', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-project-order-'));
    const projectDirs = ['one', 'two', 'three'].map(name => {
      const directory = join(tempDir, name);
      mkdirSync(directory);
      return directory;
    });
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    let nextId = 0;
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => `project_${++nextId}`
    });

    const created = projectDirs.map(cwd => manager.createProject({ cwd }));
    expect(manager.listProjects().map(project => project.id)).toEqual([
      created[2]!.id,
      created[1]!.id,
      created[0]!.id
    ]);

    const projectIds = [created[0]!.id, created[2]!.id, created[1]!.id];
    expect(manager.reorderProjects({ projectIds }).map(project => project.id))
      .toEqual(projectIds);
    expect(() => manager.reorderProjects({
      projectIds: [created[0]!.id, created[1]!.id]
    })).toThrowError(expect.objectContaining({ code: 'PROJECT_ORDER_CONFLICT' }));

    db.close();
    db = undefined;
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const reopened = createProjectManager({ db, homeDir: tempDir });
    expect(reopened.listProjects().map(project => project.id)).toEqual(projectIds);
  });

  it('rejects duplicate active canonical directories and detects a removed directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-project-'));
    const projectDir = join(tempDir, 'workspace');
    mkdirSync(projectDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    let nextId = 0;
    const manager = createProjectManager({
      db,
      idFactory: () => `project_${++nextId}`
    });

    const created = manager.createProject({ cwd: projectDir });
    let duplicateError: unknown;
    try {
      manager.createProject({ cwd: projectDir });
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toBeInstanceOf(ProjectManagerError);
    expect((duplicateError as ProjectManagerError).code).toBe('PROJECT_DIRECTORY_CONFLICT');

    rmSync(projectDir, { recursive: true });
    expect(manager.getProject(created.id)?.directoryState).toBe('missing');
  });

  it('returns SQLite UTC timestamps as timezone-qualified ISO values', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-project-timestamp-'));
    const projectDir = join(tempDir, 'workspace');
    mkdirSync(projectDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      idFactory: () => 'project_timestamp'
    });
    const project = manager.createProject({ cwd: projectDir });

    db.prepare(`
      UPDATE projects
      SET created_at = ?, updated_at = ?, archived_at = ?
      WHERE id = ?
    `).run(
      '2026-07-21 07:00:00',
      '2026-07-21 07:00:30',
      '2026-07-21 07:01:00',
      project.id
    );

    expect(manager.getProject(project.id)).toMatchObject({
      createdAt: '2026-07-21T07:00:00.000Z',
      updatedAt: '2026-07-21T07:00:30.000Z',
      archivedAt: '2026-07-21T07:01:00.000Z'
    });
  });
});
