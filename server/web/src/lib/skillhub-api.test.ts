import { afterEach, describe, expect, it, vi } from "vitest";

import {
	bindGitHubSourceItem,
	createGitHubSource,
	disableGitHubSource,
	enableGitHubSource,
	getGitHubSource,
	getGitHubSourceToken,
	getSkillSourceAvailability,
	getPublishedSkillPackageURL,
	getPublishedSkillVersionFile,
	getSkillVersionFile,
	getSkillVersionPackageURL,
	githubCommitURL,
	listGitHubSources,
		listGitHubSourceSyncRuns,
		listSkillSpaceCandidates,
		listSkillSpaceMembers,
		listSkillSpaces,
	listPublishedSkillVersionFiles,
	listSkills,
	listSkillVersionFiles,
	moveSkillsToSpace,
	publishLatestSkillVersions,
	queueGitHubSourceSync,
	queueGitHubSourceLocalScan,
	removeGitHubSourceToken,
	SkillHubAPIError,
	setCurrentSkillVersion,
	unbindGitHubSourceItem,
	updateGitHubSource,
	uploadAppSkillVersion,
	uploadSkillVersion
} from "./skillhub-api";

describe("skillhub api", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps GitHub source availability from admin status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { skill_source_enabled: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSkillSourceAvailability()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/status", expect.objectContaining({ method: "GET" }));
  });

  it("maps admin skill list response fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{
      skill_id: "skill-1",
      name: "code-review",
      description: "企业代码审查规范",
      current_version_id: "version-1",
      created_by: "usr_admin",
      created_at: "2026-07-27T08:00:00Z",
      updated_at: "2026-07-27T09:00:00Z"
    }] }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(listSkills()).resolves.toMatchObject([{ skillId: "skill-1", currentVersionId: "version-1" }]);
    expect(fetch).toHaveBeenCalledWith("/api/v1/admin/skills", expect.objectContaining({ method: "GET" }));
  });

  it("uploads multipart data without setting a JSON content type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(mutationResponse()), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    })));

    await uploadSkillVersion({
			spaceId: "skillspace_default",
      version: "1.2.0",
      changelog: "修复说明",
      packageFile: new File(["zip"], "skill.zip", { type: "application/zip" })
    });

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
		expect((init.body as FormData).get("space_id")).toBe("skillspace_default");
    expect(init.headers).toEqual({ Accept: "application/json" });
  });

  it("uploads user skill versions through the app endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(mutationResponse()), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    })));

    const file = new File(["zip"], "skill.zip", { type: "application/zip" });
    await uploadAppSkillVersion({
      spaceId: "skillspace_product",
      version: "2.0.0",
      changelog: "用户上传",
      packageFile: file
    });

    expect(fetch).toHaveBeenCalledWith("/api/v1/app/skills/versions", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: expect.any(FormData)
    }));
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((init.body as FormData).get("space_id")).toBe("skillspace_product");
    expect((init.body as FormData).get("package")).toBe(file);
  });

  it("sets the current version with the stable request shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(mutationResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    await setCurrentSkillVersion("skill-1", "version-1");

    expect(fetch).toHaveBeenCalledWith("/api/v1/admin/skills/current-version", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ skill_id: "skill-1", version_id: "version-1" })
    }));
  });

  it("moves selected skills to a target space with one atomic request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      target_space_id: "skillspace_product",
      moved_count: 1,
      unchanged_count: 1
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(moveSkillsToSpace({ skillIds: ["skill-1", "skill-2"], targetSpaceId: "skillspace_product" })).resolves.toEqual({
      targetSpaceId: "skillspace_product",
      movedCount: 1,
      unchangedCount: 1
    });
    expect(fetch).toHaveBeenCalledWith("/api/v1/admin/skills/space", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ skill_ids: ["skill-1", "skill-2"], target_space_id: "skillspace_product" })
    }));
  });

  it("publishes the latest version of every selected skill and reports per-skill failures", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === "GET" && url.includes("skill_id=skill-1")) {
        return jsonResponse({ skill: mutationResponse().skill, versions: [
          { ...mutationResponse().version, version_id: "version-old", created_at: "2026-07-27T08:00:00Z" },
          { ...mutationResponse().version, version_id: "version-new", created_at: "2026-07-27T10:00:00Z" }
        ] });
      }
      if (init.method === "GET") {
        return new Response(JSON.stringify({ error: "Skill 不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
      return jsonResponse({
        ...mutationResponse(),
        skill: { ...mutationResponse().skill, current_version_id: "version-new" },
        version: { ...mutationResponse().version, version_id: "version-new" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishLatestSkillVersions([
      { skillId: "skill-1", name: "code-review" },
      { skillId: "skill-missing", name: "missing-skill" }
    ]);

    expect(result.published).toHaveLength(1);
    expect(result.published[0].version.versionId).toBe("version-new");
    expect(result.failed).toMatchObject([{ skillId: "skill-missing", name: "missing-skill", error: { message: "Skill 不存在" } }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/skills/current-version", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ skill_id: "skill-1", version_id: "version-new" })
    }));
  });

  it("loads version files and a selected file with encoded identifiers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ path: "docs/安装.md", size: 24 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: "docs/安装.md", size: 24, content: "安装说明" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSkillVersionFiles("skill/1", "version 1")).resolves.toEqual({
      items: [{ path: "docs/安装.md", size: 24 }]
    });
    await expect(getSkillVersionFile("skill/1", "version 1", "docs/安装.md")).resolves.toEqual({
      path: "docs/安装.md",
      size: 24,
      content: "安装说明"
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/skills/version-files?skill_id=skill%2F1&version_id=version%201",
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/skills/version-file?skill_id=skill%2F1&version_id=version%201&path=docs%2F%E5%AE%89%E8%A3%85.md",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("loads only published version files through the user API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ path: "docs/安装.md", size: 24 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: "docs/安装.md", size: 24, content: "安装说明" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await listPublishedSkillVersionFiles("skill/1", "version 1");
    await getPublishedSkillVersionFile("skill/1", "version 1", "docs/安装.md");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/app/skills/version-files?skill_id=skill%2F1&version_id=version%201",
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/app/skills/version-file?skill_id=skill%2F1&version_id=version%201&path=docs%2F%E5%AE%89%E8%A3%85.md",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("builds the package URL for a specific version", () => {
    expect(getSkillVersionPackageURL("skill/1", "version 1")).toBe(
      "/api/v1/admin/skills/version-package?skill_id=skill%2F1&version_id=version%201"
    );
  });

  it("locks the published package URL to the displayed version", () => {
    expect(getPublishedSkillPackageURL("skill/1", "version 1")).toBe(
      "/api/v1/app/skills/package?skill_id=skill%2F1&version_id=version%201"
    );
  });

  it("preserves the response status and error code for version content failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "file_not_previewable",
      error: "该文件不支持在线预览"
    }), {
      status: 422,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(getSkillVersionFile("skill-1", "version-1", "assets/logo.png")).rejects.toMatchObject({
      name: "SkillHubAPIError",
      code: "file_not_previewable",
      message: "该文件不支持在线预览",
      status: 422
    } satisfies Partial<SkillHubAPIError>);
  });

	it("maps github source detail, runs, and full version evidence", async () => {
		const source = sourceResponse();
		const run = sourceRunResponse();
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ items: [{ source, latest_run: run, discovered_count: 86 }] }))
			.mockResolvedValueOnce(jsonResponse({ source, manual_clone: {
					working_directory: "/var/lib/claw-mcp/skill-sources/source-1",
					repository_directory: "/var/lib/claw-mcp/skill-sources/source-1/repository",
					command: "git clone --branch 'main' 'https://github.com/acme/skills.git' 'repository'",
					command_groups: [
						{ title: "首次同步：Clone", commands: ["git clone --branch 'main'"] },
						{ title: "后续同步：Fetch", commands: ["git fetch origin 'main'"] },
						{ title: "Skill 发现阶段", commands: ["git ls-files --stage -z"] }
					]
			}, items: [{
				source_item_id: "item-1", source_id: "source-1", skill_path: "skills/code-review", discovered_name: "code-review",
				skill_id: "skill-1", status: "active", last_seen_commit_sha: "a".repeat(40), last_content_sha256: "b".repeat(64),
				last_version_id: "version-1", last_error_summary: "", missing_since: null, created_at: source.created_at, updated_at: source.updated_at
			}] }))
			.mockResolvedValueOnce(jsonResponse({ items: [run] }))
			.mockResolvedValueOnce(jsonResponse({ skill: mutationResponse().skill, versions: [{
				...mutationResponse().version,
				source: { source_id: "source-1", repository_owner: "acme", repository_name: "skills", path: "skills/code-review", commit_sha: "a".repeat(40), content_sha256: "b".repeat(64) }
			}] }));
		vi.stubGlobal("fetch", fetchMock);

		const sources = await listGitHubSources();
		expect(sources).toMatchObject([{ source: { sourceId: "source-1", hasToken: true }, latestRun: { runId: "run-1" }, discoveredCount: 86 }]);
		expect(sources[0].source).not.toHaveProperty("token");
		await expect(getGitHubSource("source/1")).resolves.toMatchObject({
			source: { sourceId: "source-1" },
			items: [{ sourceItemId: "item-1", skillId: "skill-1" }],
				manualClone: {
					workingDirectory: "/var/lib/claw-mcp/skill-sources/source-1",
					repositoryDirectory: "/var/lib/claw-mcp/skill-sources/source-1/repository",
					commandGroups: expect.arrayContaining([
						expect.objectContaining({ title: "首次同步：Clone" }),
						expect.objectContaining({ title: "后续同步：Fetch" }),
						expect.objectContaining({ title: "Skill 发现阶段" })
					])
				}
		});
			await expect(listGitHubSourceSyncRuns("source/1")).resolves.toMatchObject([{ runId: "run-1", targetCommitSha: "a".repeat(40) }]);
		const detail = await import("./skillhub-api").then(({ getSkill }) => getSkill("skill-1"));
		expect(detail.versions[0].source).toEqual({
			sourceId: "source-1", repositoryOwner: "acme", repositoryName: "skills", path: "skills/code-review",
			commitSha: "a".repeat(40), contentSha256: "b".repeat(64)
		});
		expect(githubCommitURL(detail.versions[0].source!)).toBe(`https://github.com/acme/skills/commit/${"a".repeat(40)}`);
		expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/admin/skill-sources", expect.objectContaining({ method: "GET" }));
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/skill-sources/detail?source_id=source%2F1", expect.objectContaining({ method: "GET" }));
			expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/admin/skill-sources/sync-runs?source_id=source%2F1", expect.objectContaining({ method: "GET" }));
		});

		it("loads a GitHub source token only from the edit endpoint", async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: "github_pat_saved" }));
			vi.stubGlobal("fetch", fetchMock);

			await expect(getGitHubSourceToken("source/1")).resolves.toBe("github_pat_saved");
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/v1/admin/skill-sources/token?source_id=source%2F1",
				expect.objectContaining({ method: "GET" })
			);
		});

	it("uses stable github source methods, paths, and snake case bodies", async () => {
		const fetchMock = vi.fn().mockImplementation(() => jsonResponse(sourceResponse()));
		vi.stubGlobal("fetch", fetchMock);
			const input = {
				spaceId: "skillspace_default",
				repositoryOwner: "acme", repositoryName: "skills", branch: "main", scanRoot: ".", excludePaths: ["archive"],
			token: "secret", autoPublish: true, schedule: "hourly" as const
		};
		await createGitHubSource(input);
		await updateGitHubSource("source-1", { ...input, token: undefined });
		await disableGitHubSource("source-1");
		await enableGitHubSource("source-1");
		await removeGitHubSourceToken("source-1");
		await bindGitHubSourceItem("item-1", "skill-1");
		await unbindGitHubSourceItem("item-1");
		fetchMock.mockResolvedValueOnce(jsonResponse({ run_id: "run-1" }));
		await expect(queueGitHubSourceSync("source-1")).resolves.toEqual({ runId: "run-1" });
		fetchMock.mockResolvedValueOnce(jsonResponse({ run_id: "run-local" }));
		await expect(queueGitHubSourceLocalScan("source-1")).resolves.toEqual({ runId: "run-local" });

			expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/admin/skill-sources", expect.objectContaining({ method: "POST", body: JSON.stringify({
				space_id: "skillspace_default", repository_owner: "acme", repository_name: "skills", branch: "main", scan_root: ".", exclude_paths: ["archive"], token: "secret", auto_publish: true, schedule: "hourly"
			}) }));
			expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/skill-sources", expect.objectContaining({ method: "PUT", body: JSON.stringify({
				source_id: "source-1", space_id: "skillspace_default", repository_owner: "acme", repository_name: "skills", branch: "main", scan_root: ".", exclude_paths: ["archive"], auto_publish: true, schedule: "hourly"
			}) }));
		expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/admin/skill-sources/disable", expect.objectContaining({ method: "POST", body: JSON.stringify({ source_id: "source-1" }) }));
		expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/admin/skill-sources/enable", expect.objectContaining({ method: "POST", body: JSON.stringify({ source_id: "source-1" }) }));
		expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/v1/admin/skill-sources/token/remove", expect.objectContaining({ method: "POST", body: JSON.stringify({ source_id: "source-1" }) }));
		expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/v1/admin/skill-sources/items/bind", expect.objectContaining({ method: "POST", body: JSON.stringify({ source_item_id: "item-1", skill_id: "skill-1" }) }));
		expect(fetchMock).toHaveBeenNthCalledWith(7, "/api/v1/admin/skill-sources/items/unbind", expect.objectContaining({ method: "POST", body: JSON.stringify({ source_item_id: "item-1" }) }));
		expect(fetchMock).toHaveBeenNthCalledWith(8, "/api/v1/admin/skill-sources/sync", expect.objectContaining({ method: "POST", body: JSON.stringify({ source_id: "source-1" }) }));
		expect(fetchMock).toHaveBeenNthCalledWith(9, "/api/v1/admin/skill-sources/scan-local", expect.objectContaining({ method: "POST", body: JSON.stringify({ source_id: "source-1" }) }));
		});

		it("maps skill spaces from the admin endpoint", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ items: [{
				space_id: "skillspace_default", name: "默认技能空间", description: "", member_count: 3,
				skill_count: 2, published_count: 1, created_by: "system", updated_by: "system",
				created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z"
			}] })));

			await expect(listSkillSpaces()).resolves.toMatchObject([{
				spaceId: "skillspace_default", name: "默认技能空间", memberCount: 3, skillCount: 2, publishedCount: 1
			}]);
			expect(fetch).toHaveBeenCalledWith("/api/v1/admin/skill-spaces", expect.objectContaining({ method: "GET" }));
		});

		it("passes trimmed queries when listing skill space members and candidates", async () => {
			const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ items: [] }));
			vi.stubGlobal("fetch", fetchMock);

			await listSkillSpaceMembers("space/1", " 张三 ");
			await listSkillSpaceCandidates("space/1", " user@example.com ");

			expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/admin/skill-spaces/account-grants?space_id=space%2F1&query=%E5%BC%A0%E4%B8%89", expect.objectContaining({ method: "GET" }));
			expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/skill-spaces/member-candidates?space_id=space%2F1&query=user%40example.com", expect.objectContaining({ method: "GET" }));
		});
});

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function sourceResponse() {
		return {
			source_id: "source-1", space_id: "skillspace_default", provider: "github", repository_owner: "acme", repository_name: "skills", branch: "main", scan_root: ".",
		exclude_paths: ["archive"], has_token: true, auto_publish: false, schedule: "hourly", status: "active",
		last_attempt_at: "2026-08-03T08:00:00Z", last_success_at: "2026-08-03T08:01:00Z", last_synced_commit_sha: "a".repeat(40),
		last_error_summary: "", created_by: "管理员", created_at: "2026-08-03T07:00:00Z", updated_at: "2026-08-03T08:01:00Z"
	};
}

function sourceRunResponse() {
	return {
		run_id: "run-1", source_id: "source-1", trigger: "manual", repository_mode: "remote", status: "success", requested_by: "管理员",
		before_commit_sha: null, target_commit_sha: "a".repeat(40), discovered_count: 1, created_version_count: 1, published_count: 0,
		conflict_count: 0, failed_count: 0, error_summary: "", started_at: "2026-08-03T08:00:00Z", finished_at: "2026-08-03T08:01:00Z", created_at: "2026-08-03T08:00:00Z"
	};
}

function mutationResponse() {
  return {
    skill: {
      skill_id: "skill-1",
			space_id: "skillspace_default",
			space_name: "默认技能空间",
      name: "code-review",
      description: "企业代码审查规范",
      current_version_id: "version-1",
      created_by: "usr_admin",
      created_at: "2026-07-27T08:00:00Z",
      updated_at: "2026-07-27T09:00:00Z"
    },
    version: {
      version_id: "version-1",
      skill_id: "skill-1",
      version: "1.2.0",
      description: "企业代码审查规范",
      changelog: "修复说明",
      package_sha256: "a".repeat(64),
      source: null,
      created_at: "2026-07-27T08:30:00Z"
    }
  };
}
