import { adminApi } from "./api";

export type StorageProvider = "local" | "aliyun_oss";
export type CredentialMode = "ecs_ram_role" | "access_key";

export type StorageProfile = {
  profileId: string;
  name: string;
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  objectPrefix: string;
  credentialMode: CredentialMode | "";
  credentialsConfigured: boolean;
  accessKeyIdHint: string;
  status: "enabled" | "retired";
  health: "available" | "unavailable" | "unknown";
  fileCount: number;
  sizeBytes: number;
};

export type StorageState = {
  activeProfileId: string;
  revision: number;
  profiles: StorageProfile[];
};

export type OSSProfileInput = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  objectPrefix: string;
  credentialMode: CredentialMode;
  credentialAction: "keep" | "replace";
  accessKeyId?: string;
  accessKeySecret?: string;
};

export type StorageMigration = {
  migrationId: string;
  sourceProfileId: string;
  targetProfileId: string;
  status: "pending" | "running" | "completed" | "completed_with_failures" | "completed_with_cleanup_pending" | "cancelled";
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  cleanupPendingCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  failedItems: StorageMigrationFailure[];
};

export type StorageMigrationFailure = {
  fileId: string;
  attemptCount: number;
  errorCode: string;
  errorMessage: string;
};

type ProfileResponse = {
  profile_id: string;
  name: string;
  provider: StorageProvider;
  endpoint?: string;
  region?: string;
  bucket?: string;
  object_prefix?: string;
  credential_mode?: CredentialMode;
  credentials_configured: boolean;
  access_key_id_hint?: string;
  status: "enabled" | "retired";
  health: "available" | "unavailable" | "unknown";
  file_count: number;
  size_bytes: number;
};

type StateResponse = {
  active_profile_id: string;
  revision: number;
  profiles: ProfileResponse[];
};

type MigrationResponse = {
  migration_id: string;
  source_profile_id: string;
  target_profile_id: string;
  status: StorageMigration["status"];
  total_count: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  cleanup_pending_count: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  failed_items?: Array<{
    file_id: string;
    attempt_count: number;
    error_code: string;
    error_message: string;
  }>;
};

const basePath = "/shared-file-storage";

export async function getStorageState(): Promise<StorageState> {
  const response = await adminApi.get<StateResponse>(basePath);
  return {
    activeProfileId: response.active_profile_id,
    revision: response.revision,
    profiles: response.profiles.map(mapProfile)
  };
}

export function testOSSProfile(input: OSSProfileInput) {
  return adminApi.post<{ result: "success"; tested_at: string }>(`${basePath}/oss/test`, profileBody(input));
}

export async function createOSSProfile(input: OSSProfileInput) {
  return mapProfile(await adminApi.post<ProfileResponse>(`${basePath}/oss-profiles`, profileBody(input)));
}

export async function updateOSSProfile(profileId: string, input: OSSProfileInput) {
  return mapProfile(await adminApi.patch<ProfileResponse>(
    `${basePath}/oss-profiles/${encodeURIComponent(profileId)}`,
    profileBody(input)
  ));
}

export function probeStorageProfile(profileId: string) {
  return adminApi.post<{ result: "success"; tested_at: string }>(
    `${basePath}/profiles/${encodeURIComponent(profileId)}/probe`,
    {}
  );
}

export function retireStorageProfile(profileId: string) {
  return adminApi.post<void>(`${basePath}/profiles/${encodeURIComponent(profileId)}/retire`, {});
}

export function activateStorageProfile(profileId: string, expectedRevision: number) {
  return adminApi.post<{ active_profile_id: string; revision: number }>(`${basePath}/activate`, {
    profile_id: profileId,
    expected_revision: expectedRevision
  });
}

export async function createStorageMigration(sourceProfileId: string, targetProfileId: string) {
  return mapMigration(await adminApi.post<MigrationResponse>(`${basePath}/migrations`, {
    source_profile_id: sourceProfileId,
    target_profile_id: targetProfileId
  }));
}

export async function getStorageMigration(migrationId: string) {
  return mapMigration(await adminApi.get<MigrationResponse>(
    `${basePath}/migrations/${encodeURIComponent(migrationId)}`
  ));
}

export function retryStorageMigration(migrationId: string) {
  return adminApi.post<void>(`${basePath}/migrations/${encodeURIComponent(migrationId)}/retry-failed`, {});
}

export function cancelStorageMigration(migrationId: string) {
  return adminApi.post<void>(`${basePath}/migrations/${encodeURIComponent(migrationId)}/cancel`, {});
}

function profileBody(input: OSSProfileInput) {
  return {
    name: input.name,
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    object_prefix: input.objectPrefix,
    credential_mode: input.credentialMode,
    credential_action: input.credentialAction,
    access_key_id: input.accessKeyId,
    access_key_secret: input.accessKeySecret
  };
}

function mapProfile(item: ProfileResponse): StorageProfile {
  return {
    profileId: item.profile_id,
    name: item.name,
    provider: item.provider,
    endpoint: item.endpoint ?? "",
    region: item.region ?? "",
    bucket: item.bucket ?? "",
    objectPrefix: item.object_prefix ?? "",
    credentialMode: item.credential_mode ?? "",
    credentialsConfigured: item.credentials_configured,
    accessKeyIdHint: item.access_key_id_hint ?? "",
    status: item.status,
    health: item.health,
    fileCount: item.file_count,
    sizeBytes: item.size_bytes
  };
}

function mapMigration(item: MigrationResponse): StorageMigration {
  return {
    migrationId: item.migration_id,
    sourceProfileId: item.source_profile_id,
    targetProfileId: item.target_profile_id,
    status: item.status,
    totalCount: item.total_count,
    successCount: item.success_count,
    failedCount: item.failed_count,
    skippedCount: item.skipped_count,
    cleanupPendingCount: item.cleanup_pending_count,
    createdAt: item.created_at,
    startedAt: item.started_at,
    finishedAt: item.finished_at,
    failedItems: (item.failed_items ?? []).map((failed) => ({
      fileId: failed.file_id,
      attemptCount: failed.attempt_count,
      errorCode: failed.error_code,
      errorMessage: failed.error_message
    }))
  };
}
