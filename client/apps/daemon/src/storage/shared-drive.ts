import type Database from 'better-sqlite3';
import type { SharedDriveState } from '@clawee/protocol';

export function parseSharedDriveState(value?: string | null): SharedDriveState {
  return value ? JSON.parse(value) as SharedDriveState : { uploads: [], downloads: [] };
}

export function createSharedDriveRepository(db: Database.Database): {
  read(runId: string): SharedDriveState;
  merge(runId: string, change: (state: SharedDriveState) => void): SharedDriveState;
} {
  const select = db.prepare<[string], { shared_drive_state_json: string | null }>('SELECT shared_drive_state_json FROM runs WHERE id=?');
  const update = db.prepare('UPDATE runs SET shared_drive_state_json=? WHERE id=?');
  function read(runId: string): SharedDriveState {
    const row = select.get(runId);
    if (!row) throw new Error('运行不存在');
    return parseSharedDriveState(row.shared_drive_state_json);
  }
  const merge = db.transaction((runId: string, change: (state: SharedDriveState) => void) => {
    const state = read(runId);
    change(state);
    update.run(JSON.stringify(state), runId);
    return state;
  });
  return { read, merge };
}

export function sharedDriveDelivery(state: SharedDriveState = { uploads: [], downloads: [] }) {
  return {
    delivery_status: state.uploads.length === 0 ? 'none' as const
      : state.uploads.every(item => item.status === 'uploaded') ? 'complete' as const : 'incomplete' as const,
    files: [...new Map(state.uploads.flatMap(item => item.artifact ? [[
      JSON.stringify([item.artifact.space_id, item.artifact.file_id, item.artifact.revision, item.artifact.sha256]), item.artifact
    ] as const] : [])).values()],
    delivery_errors: state.uploads.flatMap(item => item.status === 'uploaded' ? [] : [item.error ?? {
      file_name: item.path.split('/').pop() ?? '文件', code: 'TRANSFER_INTERRUPTED', message: '传输中断，尚未完成'
    }])
  };
}
