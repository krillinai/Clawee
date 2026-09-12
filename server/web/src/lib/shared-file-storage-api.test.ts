import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateStorageProfile,
  createOSSProfile,
  createStorageMigration,
  getStorageMigration,
  getStorageState,
  testOSSProfile
} from "./shared-file-storage-api";

describe("shared file storage api", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps profiles and uses credential action semantics", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: stateResponse() }))
      .mockResolvedValueOnce(jsonResponse({ data: { result: "success", tested_at: "2026-09-12T00:00:00Z" } }))
      .mockResolvedValueOnce(jsonResponse({ data: stateResponse().profiles[1] }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { active_profile_id: "storage_profile_1", revision: 2 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getStorageState()).resolves.toMatchObject({
      activeProfileId: "shared_files_local_default",
      profiles: [{ provider: "local" }, { profileId: "storage_profile_1", accessKeyIdHint: "1234" }]
    });
    const input = {
      name: "生产 OSS",
      endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
      region: "cn-hangzhou",
      bucket: "clawee-prod",
      objectPrefix: "clawee/shared-files",
      credentialMode: "access_key" as const,
      credentialAction: "replace" as const,
      accessKeyId: "LTAI1234",
      accessKeySecret: "secret"
    };
    await testOSSProfile(input);
    await createOSSProfile(input);
    await activateStorageProfile("storage_profile_1", 1);

		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/shared-file-storage/oss/test", expect.objectContaining({ method: "POST" }));
		const testBody = JSON.parse(fetchMock.mock.calls[1][1].body as string) as Record<string, unknown>;
		expect(testBody).toMatchObject({ credential_action: "replace", access_key_id: "LTAI1234", access_key_secret: "secret" });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/admin/shared-file-storage/activate", expect.objectContaining({
      body: JSON.stringify({ profile_id: "storage_profile_1", expected_revision: 1 })
    }));
  });

  it("uses the migration contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: migrationResponse() }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createStorageMigration("local", "oss")).resolves.toMatchObject({
      migrationId: "migration_1",
      sourceProfileId: "local",
      targetProfileId: "oss"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/shared-file-storage/migrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ source_profile_id: "local", target_profile_id: "oss" })
    }));
  });

  it("maps redacted migration failures", async () => {
    const response = migrationResponse();
    response.status = "completed_with_failures";
    response.failed_count = 1;
    response.failed_items = [{
      file_id: "file_1",
      attempt_count: 3,
      error_code: "storage_unavailable",
      error_message: "存储暂时不可用"
    }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: response })));
    await expect(getStorageMigration("migration_1")).resolves.toMatchObject({
      failedItems: [{ fileId: "file_1", attemptCount: 3, errorCode: "storage_unavailable", errorMessage: "存储暂时不可用" }]
    });
  });
});

function stateResponse() {
  return {
    active_profile_id: "shared_files_local_default",
    revision: 1,
    profiles: [
      { profile_id: "shared_files_local_default", name: "服务器本地存储", provider: "local", credentials_configured: false, status: "enabled", health: "available", file_count: 2, size_bytes: 10 },
      { profile_id: "storage_profile_1", name: "生产 OSS", provider: "aliyun_oss", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou", bucket: "clawee-prod", object_prefix: "clawee/shared-files", credential_mode: "access_key", credentials_configured: true, access_key_id_hint: "1234", status: "enabled", health: "available", file_count: 0, size_bytes: 0 }
    ]
  };
}

function migrationResponse() {
  return {
    migration_id: "migration_1",
    source_profile_id: "local",
    target_profile_id: "oss",
    status: "pending",
    total_count: 2,
    success_count: 0,
    failed_count: 0,
    skipped_count: 0,
    cleanup_pending_count: 0,
    created_at: "2026-09-12T00:00:00Z",
    failed_items: [] as Array<{ file_id: string; attempt_count: number; error_code: string; error_message: string }>
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
