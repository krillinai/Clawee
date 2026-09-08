import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Link2, Search, Terminal, Unlink } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useAdminPermission } from "@/components/admin-permissions";
import { CopyButton } from "@/components/copy-button";
import { ConfirmDialog, DataTableShell, EmptyState, ErrorAlert, LoadingState, ModalShell, PageHeader, PageShell, SuccessAlert, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  bindGitHubSourceItem,
  getGitHubSource,
  listGitHubSourceSyncRuns,
  listSkills,
  queueGitHubSourceLocalScan,
  unbindGitHubSourceItem,
  type ManualCloneInstructions,
  type SkillSourceItem,
  type SkillSourceSyncRun
} from "@/lib/skillhub-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";

type BindTarget = { sourceItemId: string; skillId: string };

export function SkillSourceDetailPage() {
  const canManage = useAdminPermission(permissions.skillManage);
  const [searchParams] = useSearchParams();
  const sourceId = searchParams.get("source_id") ?? "";
  const queryClient = useQueryClient();
  const [unbindTarget, setUnbindTarget] = useState<SkillSourceItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sourceQuery = useQuery({
    queryKey: ["skill-source", sourceId],
    queryFn: () => getGitHubSource(sourceId),
    enabled: Boolean(sourceId)
  });
  const runsQuery = useQuery({
    queryKey: ["skill-source-sync-runs", sourceId],
    queryFn: () => listGitHubSourceSyncRuns(sourceId),
    enabled: Boolean(sourceId)
  });
  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: listSkills,
    enabled: Boolean(sourceId && sourceQuery.data?.items.some((item) => item.status === "name_conflict"))
  });

  function refresh(skillId?: string | null) {
    void queryClient.invalidateQueries({ queryKey: ["skill-source", sourceId] });
    void queryClient.invalidateQueries({ queryKey: ["skill-source-sync-runs", sourceId] });
    void queryClient.invalidateQueries({ queryKey: ["skills"] });
    if (skillId) void queryClient.invalidateQueries({ queryKey: ["skill", skillId] });
  }

  const bindMutation = useMutation({
    mutationFn: ({ sourceItemId, skillId }: BindTarget) => bindGitHubSourceItem(sourceItemId, skillId),
    onSuccess: (_, target) => {
      setNotice("来源项已绑定到现有 Skill，后续同步将写入该 Skill。");
      refresh(target.skillId);
    }
  });
  const unbindMutation = useMutation({
    mutationFn: (item: SkillSourceItem) => unbindGitHubSourceItem(item.sourceItemId),
    onSuccess: (_, item) => {
      setNotice("来源项已解绑，历史版本和当前发布保持不变。");
      setUnbindTarget(null);
      refresh(item.skillId);
    }
  });
  const localScanMutation = useMutation({
    mutationFn: () => queueGitHubSourceLocalScan(sourceId),
    onSuccess: ({ runId }) => {
      setNotice(`本地仓库扫描任务已进入队列，运行 ID：${runId}。`);
      refresh();
    }
  });

  if (!sourceId) return <PageShell><ErrorAlert>缺少来源 ID。请返回技能中心后重新选择 GitHub 来源。</ErrorAlert></PageShell>;
  if (sourceQuery.isLoading) return <PageShell><LoadingState label="正在加载 GitHub 来源详情" /></PageShell>;
  if (sourceQuery.isError || !sourceQuery.data) return <PageShell><ErrorAlert>来源详情加载失败：{errorMessage(sourceQuery.error)}。</ErrorAlert></PageShell>;

  const { source, items, manualClone } = sourceQuery.data;
  const skills = skillsQuery.data ?? [];
  const sourceName = `${source.repositoryOwner}/${source.repositoryName}`;

  return (
    <>
      <PageShell>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem><BreadcrumbLink asChild><Link to="/admin/skills">技能中心</Link></BreadcrumbLink></BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage>{sourceName}</BreadcrumbPage></BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <PageHeader title={sourceName} titleAccessory={<SourceStatusBadge status={source.status} />}>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <MetaItem label="分支" value={source.branch || "默认分支"} />
            <MetaItem label="扫描根目录" value={source.scanRoot} mono />
            <MetaItem label="访问 Token" value={source.hasToken ? "Token 已设置" : "未设置"} />
            <MetaItem label="同步调度" value={scheduleLabel(source.schedule)} />
            <MetaItem label="最近尝试" value={formatDateTime(source.lastAttemptAt)} mono />
            <MetaItem label="最近成功" value={formatDateTime(source.lastSuccessAt)} mono />
          </dl>
        </PageHeader>

        {source.lastErrorSummary ? <ErrorAlert>最近错误：{source.lastErrorSummary}</ErrorAlert> : null}

        {manualClone ? <ManualCloneRecovery
          canManage={canManage}
          error={localScanMutation.isError ? `本地仓库扫描提交失败：${errorMessage(localScanMutation.error)}。` : undefined}
          hasToken={source.hasToken}
          instructions={manualClone}
          onContinue={(completed) => localScanMutation.mutate(undefined, { onSuccess: completed })}
          pending={localScanMutation.isPending}
        /> : null}

        {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}
        {bindMutation.isError ? <ErrorAlert>绑定失败：{errorMessage(bindMutation.error)}。</ErrorAlert> : null}

        <section className="grid gap-3" aria-labelledby="source-items-title">
          <div>
            <h2 className="text-base font-semibold" id="source-items-title">来源项</h2>
            <p className="mt-1 text-xs text-muted-foreground">绑定仅影响后续同步，历史版本和当前发布不会被修改。</p>
          </div>
          <DataTableShell dense minWidth={1320}>
            <TableHeader><TableRow><TableHead>路径</TableHead><TableHead>发现名称</TableHead><TableHead>状态</TableHead><TableHead>绑定 Skill</TableHead><TableHead>最近 Commit</TableHead><TableHead>版本</TableHead><TableHead>错误</TableHead><TableHead>缺失时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {items.length === 0 ? <TableStateRow colSpan={9}><EmptyState title="暂无来源项" description="来源同步完成后会显示发现的 Skill。" /></TableStateRow> : null}
              {items.map((item) => <SourceItemRow key={item.sourceItemId} canManage={canManage} candidates={skills.filter((skill) => skill.name === item.discoveredName)} item={item} onBind={(target) => bindMutation.mutate(target)} onUnbind={setUnbindTarget} pending={bindMutation.isPending || unbindMutation.isPending} />)}
            </TableBody>
          </DataTableShell>
        </section>

        <section className="grid gap-3" aria-labelledby="source-runs-title">
          <div>
            <h2 className="text-base font-semibold" id="source-runs-title">同步运行记录</h2>
            <p className="mt-1 text-xs text-muted-foreground">保留每次同步使用的 Commit 和处理结果。</p>
          </div>
          <DataTableShell dense minWidth={1640}>
            <TableHeader><TableRow><TableHead>触发方式</TableHead><TableHead>仓库模式</TableHead><TableHead>状态</TableHead><TableHead>前序 Commit</TableHead><TableHead>目标 Commit</TableHead><TableHead>发现</TableHead><TableHead>新版本</TableHead><TableHead>已发布</TableHead><TableHead>冲突</TableHead><TableHead>失败</TableHead><TableHead>错误</TableHead><TableHead>开始时间</TableHead><TableHead>结束时间</TableHead></TableRow></TableHeader>
            <TableBody>
              {runsQuery.isLoading ? <TableStateRow colSpan={13}><LoadingState label="正在加载同步运行记录" /></TableStateRow> : null}
              {runsQuery.isError ? <TableStateRow colSpan={13} tone="danger"><ErrorAlert>同步运行记录加载失败：{errorMessage(runsQuery.error)}。</ErrorAlert></TableStateRow> : null}
              {!runsQuery.isLoading && !runsQuery.isError && (runsQuery.data ?? []).length === 0 ? <TableStateRow colSpan={13}><EmptyState title="暂无同步运行记录" /></TableStateRow> : null}
              {(runsQuery.data ?? []).map((run) => <SyncRunRow key={run.runId} run={run} />)}
            </TableBody>
          </DataTableShell>
        </section>

        <Button asChild className="justify-self-start" variant="ghost"><Link to="/admin/skills"><ArrowLeft data-icon="inline-start" aria-hidden="true" />返回技能中心</Link></Button>
      </PageShell>

      <ConfirmDialog
        open={Boolean(unbindTarget)}
        onClose={() => { if (!unbindMutation.isPending) setUnbindTarget(null); }}
        onConfirm={() => unbindTarget && unbindMutation.mutate(unbindTarget)}
        title="解除 Skill 绑定"
        description={unbindTarget ? `确认解除“${unbindTarget.discoveredName}”与当前 Skill 的绑定？这不会修改历史版本或当前发布。` : ""}
        confirmLabel={unbindMutation.isPending ? "解绑中..." : "确认解绑"}
        pending={unbindMutation.isPending}
        variant="destructive"
        error={unbindMutation.isError ? `解绑失败：${errorMessage(unbindMutation.error)}。` : undefined}
      />
    </>
  );
}

function ManualCloneRecovery({ canManage, error, hasToken, instructions, onContinue, pending }: { canManage: boolean; error?: string; hasToken: boolean; instructions: ManualCloneInstructions; onContinue: (completed: () => void) => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <section className="border-b border-border pb-5">
      <Button onClick={() => setOpen(true)} variant="outline">
        <Terminal data-icon="inline-start" aria-hidden="true" />
        手动操作命令
      </Button>
    </section>
    <ModalShell
      contentClassName="max-w-[860px]"
      onClose={() => setOpen(false)}
      open={open}
      subtitle="以下命令按服务端自动同步的实际 Git 调用顺序生成，可在运行服务的服务器终端中用于逐步排查。"
      title="手动操作命令"
    >
      <div className="grid gap-3 text-sm">
        <CopyableCommand label="操作路径" value={instructions.workingDirectory} />
        <CopyableCommand label="目标目录" value={instructions.repositoryDirectory} />
      </div>
      {instructions.commandGroups.map((group) => <section className="grid gap-3" key={group.title}>
        <div>
          <h3 className="text-sm font-semibold">{group.title}</h3>
          {group.title === "首次同步：Clone" ? <p className="mt-1 text-xs text-muted-foreground">仅在目标目录不存在时执行。若存在失败残留，请确认内容后先将其移走。</p> : null}
        </div>
        <div className="grid gap-2">
          {group.commands.map((command, index) => <CopyableCommand key={command} label={`步骤 ${index + 1}`} value={command} />)}
        </div>
      </section>)}
      {hasToken ? <p className="text-xs text-muted-foreground">该来源使用访问 Token。命令不包含已保存 Token，请在服务器终端使用具备目标仓库 Contents 读取权限的凭据完成认证。</p> : null}
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={() => setOpen(false)} variant="outline">关闭</Button>
        {canManage ? <Button disabled={pending} onClick={() => onContinue(() => setOpen(false))}>
          <Search data-icon="inline-start" aria-hidden="true" />
          {pending ? "提交中..." : "使用本地仓库继续扫描"}
        </Button> : null}
      </div>
    </ModalShell>
  </>;
}

function CopyableCommand({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1.5">
    <span className="text-xs text-muted-foreground">{label}</span>
    <div className="flex min-w-0 items-start gap-2">
      <code className="min-w-0 flex-1 break-all border border-border bg-muted/40 px-3 py-2 font-mono text-xs leading-5">{value}</code>
      <CopyButton aria-label={`复制${label}`} label="复制" size="sm" value={value} variant="outline" />
    </div>
  </div>;
}

function SourceItemRow({ canManage, candidates, item, onBind, onUnbind, pending }: { canManage: boolean; candidates: { skillId: string; name: string }[]; item: SkillSourceItem; onBind: (target: BindTarget) => void; onUnbind: (item: SkillSourceItem) => void; pending: boolean }) {
  return <TableRow>
    <TableCell className="max-w-64 font-mono text-xs"><span className="block truncate" title={item.skillPath}>{item.skillPath}</span></TableCell>
    <TableCell className="font-medium">{item.discoveredName}</TableCell>
    <TableCell><SourceItemStatusBadge status={item.status} /></TableCell>
    <TableCell>{item.skillId ? <Link className="text-primary hover:underline" to={`/admin/skills/detail?skill_id=${encodeURIComponent(item.skillId)}`}>{item.skillId}</Link> : "-"}</TableCell>
    <TableCell><ShortHash value={item.lastSeenCommitSha} /></TableCell>
    <TableCell className="font-mono text-xs">{item.lastVersionId ?? "-"}</TableCell>
    <TableCell className="max-w-56 text-muted-foreground"><span className="block truncate" title={item.lastErrorSummary || undefined}>{item.lastErrorSummary || "-"}</span></TableCell>
    <TableCell className="font-mono text-xs">{formatDateTime(item.missingSince)}</TableCell>
    <TableCell className="text-right">
      {canManage && item.status === "name_conflict" ? <div className="flex justify-end gap-1">{candidates.map((skill) => <Button aria-label={`绑定到现有 Skill ${skill.name}`} disabled={pending} key={skill.skillId} onClick={() => onBind({ sourceItemId: item.sourceItemId, skillId: skill.skillId })} size="sm" variant="secondary"><Link2 data-icon="inline-start" aria-hidden="true" />绑定到现有 Skill</Button>)}</div> : null}
      {canManage && item.skillId ? <Button aria-label={`解绑 ${item.discoveredName}`} disabled={pending} onClick={() => onUnbind(item)} size="sm" variant="outline"><Unlink data-icon="inline-start" aria-hidden="true" />解绑</Button> : null}
    </TableCell>
  </TableRow>;
}

function SyncRunRow({ run }: { run: SkillSourceSyncRun }) {
  return <TableRow>
    <TableCell>{run.trigger}</TableCell><TableCell>{run.repositoryMode === "local" ? "本地" : "远程"}</TableCell><TableCell><RunStatusBadge status={run.status} /></TableCell><TableCell><ShortHash value={run.beforeCommitSha} /></TableCell><TableCell><ShortHash value={run.targetCommitSha} /></TableCell><TableCell>{run.discoveredCount}</TableCell><TableCell>{run.createdVersionCount}</TableCell><TableCell>{run.publishedCount}</TableCell><TableCell>{run.conflictCount}</TableCell><TableCell>{run.failedCount}</TableCell><TableCell className="max-w-56 text-muted-foreground"><span className="block truncate" title={run.errorSummary || undefined}>{run.errorSummary || "-"}</span></TableCell><TableCell className="font-mono text-xs">{formatDateTime(run.startedAt)}</TableCell><TableCell className="font-mono text-xs">{formatDateTime(run.finishedAt)}</TableCell>
  </TableRow>;
}

function MetaItem({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return <div className="grid gap-1"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={mono ? "min-w-0 break-all font-mono text-xs" : "min-w-0 break-words"}>{value}</dd></div>;
}

function ShortHash({ value }: { value: string | null }) {
  return value ? <span className="font-mono text-xs" title={value}>{value.slice(0, 8)}</span> : <>-</>;
}

function SourceStatusBadge({ status }: { status: string }) {
  return <Badge variant={status === "active" ? "success" : status === "disabled" ? "muted" : "destructive"}>{status === "active" ? "启用" : status === "disabled" ? "已停用" : status}</Badge>;
}

function SourceItemStatusBadge({ status }: { status: string }) {
  const label = status === "active" ? "正常" : status === "name_conflict" ? "名称冲突" : status === "name_changed" ? "名称已变更" : status === "invalid" ? "无效" : status === "missing" ? "缺失" : status;
  return <Badge variant={status === "active" ? "success" : status === "name_conflict" || status === "name_changed" ? "secondary" : "destructive"}>{label}</Badge>;
}

function RunStatusBadge({ status }: { status: string }) {
  const label = status === "success" ? "成功" : status === "running" ? "进行中" : status === "queued" ? "已排队" : status === "failed" ? "失败" : status;
  return <Badge variant={status === "success" ? "success" : status === "failed" ? "destructive" : "muted"}>{label}</Badge>;
}

function scheduleLabel(schedule: string) {
  return schedule === "hourly" ? "每小时" : schedule === "daily" ? "每日" : "手动";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
