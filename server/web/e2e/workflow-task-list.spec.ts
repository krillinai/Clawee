import { expect, test } from "@playwright/test";

test.use({ headless: true });

for (const width of [1440, 390]) {
  test(`内置模板及 Skill 审核共用流程列表 ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let runRequests = 0;
    await page.route("**/api/v1/**", async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      let data: unknown = {};
      if (path === "/api/v1/auth/me") data = { account: { user_id: "admin", email: "admin@test.invalid", name: "管理员", status: "active" }, applications: { admin: true, frontend: true }, admin_permissions: ["console:workflow:template_manage", "console:workflow:instance_read", "console:skill:read"] };
      else if (path === "/api/v1/admin/workflow-templates") data = [{ id: "normal-template", name: "普通流程模板", description: "用于内容生产", status: "enabled", revision: 1, nodes: [{ node_id: "generate", order: 0, type: "agent", title: "生成内容", instruction: "根据主题生成正文", assignee_user_id: "admin" }], created_at: "2026-10-20T00:00:00Z" }];
      else if (path === "/api/v1/admin/workflow-assignees") data = [{ user_id: "admin", name: "管理员", email: "admin@test.invalid" }];
      else if (path === "/api/v1/admin/skill-review-workflow") data = { id: "builtin:skill-review", name: "Skill 审批工作流", read_only: true, trigger: "upload", review_skill: "skill-review", steps: [{ name: "上传", rule: "上传自动触发审核" }, { name: "AI 评估", rule: "通过有效报告后进入人工评分" }] };
      else if (path === "/api/v1/admin/workflow-instances") data = [{ id: "normal-task", template_id: "normal-template", template_revision: 1, status: "running", started_by: "admin", user_names: { admin: "管理员" }, started_at: "2026-10-20T00:00:00Z", nodes: [{ node_id: "agent", order: 0, type: "agent", title: "整理内容", instruction: "整理输入内容" }] }];
      else if (path === "/api/v1/admin/skill-review-workflow/runs") {
        runRequests++;
        data = [{ request_id: "review-running", skill_id: "test-skill", skill_name: "文案审核 Skill", version_id: "v1", version: "1.0", uploaded_by: "writer", workflow_stage: url.searchParams.get("status") === "error" ? "ai_failed" : "ai_running", approved: 0, total: 2, created_at: "2026-10-21T00:00:00Z" }];
      }
      await route.fulfill({ json: { data, meta: { has_next: false, next_cursor: "" } } });
    });
    await page.goto("/admin/workflow-templates");
    const table = page.getByRole("table");
    const builtin = table.getByRole("row", { name: /Skill 审批工作流/ });
    await expect(builtin).toBeVisible();
    const normal = table.getByRole("row", { name: /普通流程模板/ });
    await expect(normal).toBeVisible();
    await normal.getByRole("button", { name: "查看流程" }).click();
    const preview = page.getByRole("dialog");
    await expect(preview.getByRole("heading", { name: "1. 生成内容" })).toBeVisible();
    await expect(preview.getByText("负责人：管理员")).toBeVisible();
    await expect(preview.getByText("根据主题生成正文")).toBeVisible();
    await expect(preview.getByRole("textbox")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workflow-template-preview-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "关闭详情抽屉" }).click();
    await expect(builtin.getByRole("button", { name: /编辑|发起/ })).toHaveCount(0);
    await builtin.getByRole("button", { name: "查看流程" }).click();
    await expect(page.getByText("通过有效报告后进入人工评分")).toBeVisible();
    expect(runRequests).toBe(0);
    await page.getByRole("link", { name: "查看流程任务" }).click();
    await expect(page).toHaveURL(/\/admin\/workflow-instances$/);
    await expect(table.getByRole("row", { name: /文案审核 Skill/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /整理内容/ })).toBeVisible();
    await expect(table.getByRole("row").nth(1)).toContainText("文案审核 Skill");
    await expect(table.getByRole("link", { name: /查看流程任务 文案审核 Skill/ })).toHaveAttribute("href", "/admin/approvals/skill/review-running");
    await page.getByRole("combobox", { name: "状态筛选" }).click();
    await page.getByRole("option", { name: "执行异常" }).click();
    await expect(table.getByRole("row", { name: /评估执行异常/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /整理内容/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workflow-task-list-${width}.png`), fullPage: true });
  });
}
