export type InternalRunStatus =
  | 'created'
  | 'queued'
  | 'spawning'
  | 'running'
  | 'canceling'
  | 'finalizing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'orphaned';
