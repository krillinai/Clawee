import { expect, test } from "@playwright/test";

test.use({ headless: true });

for (const width of [1440, 390]) {
  test(`审批管理筛选、详情和终止 ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    let terminated = false;
    const item = () => ({ kind: "workflow_instance", id: "approval-instance", type: "workflow", title: "企业技能上线核对", channel: "workflow", status: terminated ? "terminated" : "pending", business_status: terminated ? "terminated" : "running", initiated_by: "writer", initiated_name: "陈明", created_at: "2026-10-10T00:00:00Z", current_approvers: terminated ? [] : ["reviewer"], current_approver_names: terminated ? [] : ["张晓"], progress_completed: 0, progress_total: 1, can_process: false, materials_available: true, template_id: "template", task_id: "task-review", current_node: "确认上线材料" });
    const instance = () => ({ id: "approval-instance", template_id: "template", template_revision: 1, status: terminated ? "terminated" : "running", started_by: "writer", started_at: "2026-10-10T00:00:00Z", current_node_id: "review", user_names: { writer: "陈明", reviewer: "张晓" }, nodes: [{ node_id: "review", order: 0, title: "确认上线材料", type: "approval", instruction: "核对版本、材料和审批意见", resolved_user_ids: ["reviewer"] }], tasks: [{ task_id: "task-review", node_id: "review", status: terminated ? "cancelled" : "pending", assignee_user_ids: ["reviewer"], input: { text: "企业技能上线审批材料" } }] });
    await page.route("**/api/v1/**", async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      let data: unknown = {};
      if (path === "/api/v1/auth/me") data = { account: { user_id: "admin", email: "admin@test.invalid", name: "审批管理员", status: "active" }, applications: { admin: true, frontend: true }, admin_permissions: ["console:workflow:instance_read", "console:workflow:instance_terminate"] };
      else if (path === "/api/v1/admin/approvals") data = [item()];
      else if (path === "/api/v1/admin/approvals/summary") data = { total: 1, pending: terminated ? 0 : 1, running: 0, abnormal: 0 };
      else if (path === "/api/v1/admin/approvals/workflow_instance/approval-instance") data = { item: item(), workflow: instance(), actions: { terminate: !terminated } };
      else if (path === "/api/v1/admin/workflow-instances/approval-instance/terminate") {
        expect(route.request().postDataJSON()).toEqual({ reason: "上线材料已撤回" });
        terminated = true;
        data = instance();
      }
      await route.fulfill({ json: { data, meta: { has_next: false, next_cursor: "" } } });
    });
    await page.goto("/admin/approvals");
    await expect(page.getByRole("heading", { name: "审批管理" })).toBeVisible();
    await page.getByLabel("关键词").fill("技能上线");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page).toHaveURL(/q=/);
    await page.screenshot({ path: testInfo.outputPath(`admin-approvals-list-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "查看企业技能上线核对详情" }).click();
    await expect(page.getByRole("heading", { name: "审批详情" })).toBeVisible();
    await page.getByRole("link", { name: "打开详情页" }).click();
    await expect(page).toHaveURL(/\/admin\/approvals\/workflow_instance\/approval-instance/);
    await expect(page.getByRole("heading", { name: "企业技能上线核对" })).toBeVisible();
    await page.getByRole("button", { name: "展开节点“确认上线材料”的内容" }).click();
    await expect(page.getByText("企业技能上线审批材料")).toBeVisible();
    await expect(page.getByRole("link", { name: "处理审批" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`admin-approvals-detail-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "终止工作流" }).click();
    await expect(page.getByRole("button", { name: "确认终止", exact: true })).toBeDisabled();
    await page.getByLabel("终止原因（必填）").fill("上线材料已撤回");
    await page.getByRole("button", { name: "确认终止", exact: true }).click();
    await expect(page.getByText("操作已完成。")).toBeVisible();
    await expect(page.getByRole("button", { name: "终止工作流" })).toHaveCount(0);
    await page.getByRole("link", { name: "返回审批管理" }).click();
    await expect(page.getByLabel("关键词")).toHaveValue("技能上线");
  });
}
