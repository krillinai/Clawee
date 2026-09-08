import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ConfirmDialog,
  DataTableShell,
  DetailDrawer,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  FilterSelect,
  JsonTabs,
  LoadingState,
  ModalShell,
  PageHeader,
  ResourceItem,
  ResourceList,
  TableStateRow
} from "@/components/governance-ui";
import { TableBody } from "@/components/ui/table";
import { Button } from "@/components/ui/button";

describe("governance ui components", () => {
  it("renders shared error, empty, loading, and table states", () => {
    render(
      <div>
        <ErrorAlert>加载失败</ErrorAlert>
        <EmptyState title="暂无数据" description="没有匹配记录。" />
        <LoadingState label="加载中" />
        <DataTableShell fixedLayout minWidth={320}>
          <TableBody>
            <TableStateRow colSpan={2}>无记录</TableStateRow>
          </TableBody>
        </DataTableShell>
      </div>
    );

    expect(screen.getByText("加载失败")).toBeInTheDocument();
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
    expect(screen.getByText("加载中")).toBeInTheDocument();
    expect(screen.getByText("无记录")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveClass("table-fixed");
  });

  it("renders shared filter controls with compact desktop widths", () => {
    render(
      <FilterRow>
        <FilterSearchField aria-label="search records" placeholder="搜索" />
        <FilterSelect ariaLabel="status" value="all" onChange={vi.fn()}>
          <option value="all">全部状态</option>
        </FilterSelect>
      </FilterRow>
    );

    expect(screen.getByLabelText("search records").parentElement).toHaveClass("sm:w-80");
    expect(screen.getByLabelText("status")).toHaveClass("sm:w-40");
  });

  it("uses dialog and sheet compositions for modal surfaces", () => {
    const { unmount } = render(
      <ModalShell open title="编辑配置" subtitle="保存前请确认字段。" onClose={vi.fn()}>
        <Button>内部操作</Button>
      </ModalShell>
    );

    expect(screen.getByRole("dialog", { name: "编辑配置" })).toBeInTheDocument();
    unmount();

    render(
      <DetailDrawer open title="详情" subtitle="审计上下文" contextLabel="追踪详情" onClose={vi.fn()}>
        <span>trace_1</span>
      </DetailDrawer>
    );

    expect(screen.getByRole("dialog", { name: "详情" })).toBeInTheDocument();
    expect(screen.getByText("追踪详情")).not.toHaveClass("font-mono", "uppercase");
    expect(screen.getByText("trace_1")).toBeInTheDocument();
  });

  it("renders page headers without decorative context labels", () => {
    render(<PageHeader title="账号管理">管理账号状态和后台角色。</PageHeader>);

    const heading = screen.getByRole("heading", { name: "账号管理" });
    expect(heading).toHaveClass("text-2xl");
    expect(heading.closest("header")).not.toHaveClass("border-b");
    expect(screen.getByText("管理账号状态和后台角色。")).toBeInTheDocument();
  });

  it("renders plain resource lists with separators instead of nested cards", () => {
    render(
      <ResourceList variant="plain">
        <ResourceItem title="审批待处理" variant="plain" />
        <ResourceItem title="同步失败" variant="plain" />
      </ResourceList>
    );

    const firstItem = screen.getByText("审批待处理").closest('[data-slot="card"]');
    const secondItem = screen.getByText("同步失败").closest('[data-slot="card"]');
    expect(firstItem?.parentElement).toHaveClass("gap-0");
    expect(firstItem).toHaveClass("rounded-none", "border-x-0", "border-b-0", "bg-transparent", "first:border-t-0");
    expect(secondItem).toHaveClass("rounded-none", "border-x-0", "border-b-0", "bg-transparent");
  });

  it("notifies when modal and drawer visible close buttons are clicked", () => {
    const onModalClose = vi.fn();
    const onDrawerClose = vi.fn();
    const { unmount } = render(
      <ModalShell open title="编辑配置" subtitle="保存前请确认字段。" onClose={onModalClose}>
        <span>modal body</span>
      </ModalShell>
    );

    fireEvent.click(within(screen.getByRole("dialog", { name: "编辑配置" })).getByRole("button", { name: "关闭" }));
    expect(onModalClose).toHaveBeenCalledTimes(1);

    unmount();
    render(
      <DetailDrawer open title="详情" subtitle="审计上下文" contextLabel="追踪详情" onClose={onDrawerClose}>
        <span>drawer body</span>
      </DetailDrawer>
    );

    fireEvent.click(within(screen.getByRole("dialog", { name: "详情" })).getByRole("button", { name: "关闭详情抽屉" }));
    expect(onDrawerClose).toHaveBeenCalledTimes(1);
  });

  it("confirms destructive actions explicitly", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="删除上游服务"
        description="该操作会移除服务。"
        confirmLabel="删除"
        onClose={vi.fn()}
        onConfirm={onConfirm}
        variant="destructive"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders JSON tabs with copy action", () => {
    render(<JsonTabs tabs={[{ id: "request", label: "Request", value: { ok: true } }]} />);
    expect(screen.getByRole("tab", { name: "Request" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request" })).toBeNull();
    expect(within(screen.getByRole("tabpanel")).getByText(/"ok": true/)).toBeInTheDocument();
  });

  it("switches JSON tabs without duplicate button controls", async () => {
    render(
      <JsonTabs
        tabs={[
          { id: "request", label: "Request", value: { ok: true } },
          { id: "response", label: "Response", value: { status: "done" } }
        ]}
      />
    );

    expect(screen.getByRole("tab", { name: "Request" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Response" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Response" })).toBeNull();

    const responseTab = screen.getByRole("tab", { name: "Response" });
    fireEvent.pointerDown(responseTab);
    fireEvent.mouseDown(responseTab);
    fireEvent.mouseUp(responseTab);
    fireEvent.click(responseTab);
    await waitFor(() => {
      expect(within(screen.getByRole("tabpanel")).getByText(/"status": "done"/)).toBeInTheDocument();
    });
  });
});
