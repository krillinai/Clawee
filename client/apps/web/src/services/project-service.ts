import type {
  AssignThreadProjectRequest,
  CreateManagedProjectRequest,
  CreateProjectRequest,
  MigrateLocalStorageProjectsV1Request,
  MigrateLocalStorageProjectsV1Response,
  ProjectDirectorySelectionPurpose,
  ProjectListResponse,
  ProjectResponse,
  ProjectStatus,
  ReorderProjectsRequest,
  ReplaceProjectDirectoryRequest,
  SelectProjectDirectoryResponse,
  ThreadListResponse,
  ThreadResponse,
  UpdateProjectRequest
} from '@clawee/protocol';
import type { RuntimeClient } from '../runtime/client.js';

export function createProjectService(client: RuntimeClient) {
  return {
    listProjects(status: ProjectStatus | 'all' = 'active'): Promise<ProjectListResponse> {
      return client.get(`/projects?status=${status}`);
    },
    async selectProjectDirectory(
      purpose: ProjectDirectorySelectionPurpose = 'add'
    ): Promise<string | null> {
      const response = await client.post<SelectProjectDirectoryResponse>(
        '/projects/directory-selection',
        { purpose }
      );
      return response.path;
    },
    ensureDefaultProject(): Promise<{ project: ProjectResponse }> {
      return client.post('/projects/default');
    },
    createProject(input: CreateProjectRequest): Promise<{ project: ProjectResponse }> {
      return client.post('/projects', input);
    },
    createManagedProject(
      input: CreateManagedProjectRequest
    ): Promise<{ project: ProjectResponse }> {
      return client.post('/projects/managed', input);
    },
    reorderProjects(input: ReorderProjectsRequest): Promise<ProjectListResponse> {
      return client.post('/projects/reorder', input);
    },
    updateProject(
      projectId: string,
      input: UpdateProjectRequest
    ): Promise<{ project: ProjectResponse }> {
      return client.patch(`/projects/${encodeURIComponent(projectId)}`, input);
    },
    archiveProject(projectId: string): Promise<{ project: ProjectResponse }> {
      return client.post(`/projects/${encodeURIComponent(projectId)}/archive`);
    },
    restoreProject(projectId: string): Promise<{ project: ProjectResponse }> {
      return client.post(`/projects/${encodeURIComponent(projectId)}/restore`);
    },
    replaceProjectDirectory(
      projectId: string,
      input: ReplaceProjectDirectoryRequest
    ): Promise<{ project: ProjectResponse }> {
      return client.post(
        `/projects/${encodeURIComponent(projectId)}/replace-directory`,
        input
      );
    },
    migrateLocalStorageV1(
      input: MigrateLocalStorageProjectsV1Request
    ): Promise<MigrateLocalStorageProjectsV1Response> {
      return client.post('/projects/migrations/local-storage-v1', input);
    },
    listUnassignedThreads(): Promise<ThreadListResponse> {
      return client.get(
        '/threads?status=all&purpose=conversation&assignment=unassigned&limit=100'
      );
    },
    assignThreadProject(
      threadId: string,
      input: AssignThreadProjectRequest
    ): Promise<{ thread: ThreadResponse }> {
      return client.post(
        `/threads/${encodeURIComponent(threadId)}/assign-project`,
        input
      );
    }
  };
}
