import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Database, Pencil, Plus, RefreshCw, RotateCcw, TestTube2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { useAdminPermission } from "@/components/admin-permissions";
import {
  DataTableShell,
  EmptyState,
  ErrorAlert,
  ModalShell,
  PageHeader,
  PageShell,
  SuccessAlert,
  TableStateRow
} from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";
import {
  activateStorageProfile,
  cancelStorageMigration,
  createOSSProfile,
  createStorageMigration,
  getStorageMigration,
  getStorageState,
  probeStorageProfile,
  retireStorageProfile,
  retryStorageMigration,
  testOSSProfile,
  updateOSSProfile,
  type CredentialMode,
  type OSSProfileInput,
  type StorageMigration,
  type StorageProfile
} from "@/lib/shared-file-storage-api";

type ProfileForm = OSSProfileInput & { profileId: string; mode: "create" | "edit"; locationLocked: boolean };

const emptyForm: ProfileForm = {
  profileId: "",
  mode: "create",
  locationLocked: false,
  name: "",
  endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
  region: "cn-hangzhou",
  bucket: "",
  objectPrefix: "clawee/shared-files",
  credentialMode: "ecs_ram_role",
  credentialAction: "replace",
  accessKeyId: "",
  accessKeySecret: ""
};

export function SharedFileStoragePage() {
  const canManage = useAdminPermission(permissions.sharedFilesStorageManage);
  const canMigrate = useAdminPermission(permissions.sharedFilesStorageMigrate);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [tested, setTested] = useState(false);
  const [activateTarget, setActivateTarget] = useState<StorageProfile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [migrationId, setMigrationId] = useState(() => sessionStorage.getItem("shared-file-storage-migration") ?? "");
  const [sourceProfileId, setSourceProfileId] = useState("");
  const [targetProfileId, setTargetProfileId] = useState("");

  const stateQuery = useQuery({ queryKey: ["shared-file-storage"], queryFn: getStorageState });
  const migrationQuery = useQuery({
    queryKey: ["shared-file-storage-migration", migrationId],
    queryFn: () => getStorageMigration(migrationId),
    enabled: Boolean(migrationId) && canMigrate,
    refetchInterval: (query) => shouldPollMigration(query.state.data?.status) ? 1500 : false
  });
  const state = stateQuery.data;
  const profiles = state?.profiles ?? [];
  const active = profiles.find((profile) => profile.profileId === state?.activeProfileId);
  const enabledProfiles = profiles.filter((profile) => profile.status === "enabled");

  useEffect(() => {
    if (!sourceProfileId && active) setSourceProfileId(active.profileId);
    if (!targetProfileId) {
      const alternate = enabledProfiles.find((profile) => profile.profileId !== active?.profileId);
      if (alternate) setTargetProfileId(alternate.profileId);
    }
  }, [active, enabledProfiles, sourceProfileId, targetProfileId]);

  const testMutation = useMutation({
    mutationFn: (value: ProfileForm) => value.mode === "edit" && value.credentialAction === "keep"
      ? probeStorageProfile(value.profileId)
      : testOSSProfile(value),
    onSuccess: () => {
      setTested(true);
      setNotice("OSS 读写与删除测试通过");
    }
  });
  const saveMutation = useMutation({
    mutationFn: (value: ProfileForm) => value.mode === "create"
      ? createOSSProfile(value)
      : updateOSSProfile(value.profileId, value),
    onSuccess: (profile) => {
      setForm(null);
      setTested(false);
      setNotice(`存储配置“${profile.name}”已保存`);
      void queryClient.invalidateQueries({ queryKey: ["shared-file-storage"] });
    }
  });
  const probeMutation = useMutation({
    mutationFn: probeStorageProfile,
    onSuccess: () => {
      setNotice("存储连通性检查通过");
      void queryClient.invalidateQueries({ queryKey: ["shared-file-storage"] });
    }
  });
  const activateMutation = useMutation({
    mutationFn: (profileId: string) => activateStorageProfile(profileId, state?.revision ?? 0),
    onSuccess: () => {
      setActivateTarget(null);
      setNotice("当前写入存储已切换");
      void queryClient.invalidateQueries({ queryKey: ["shared-file-storage"] });
    }
  });
  const retireMutation = useMutation({
    mutationFn: retireStorageProfile,
    onSuccess: () => {
      setNotice("OSS Profile 已退役");
      void queryClient.invalidateQueries({ queryKey: ["shared-file-storage"] });
    }
  });
  const createMigrationMutation = useMutation({
    mutationFn: () => createStorageMigration(sourceProfileId, targetProfileId),
    onSuccess: (migration) => {
      setMigrationId(migration.migrationId);
      sessionStorage.setItem("shared-file-storage-migration", migration.migrationId);
      setNotice("存量迁移任务已提交");
      void queryClient.invalidateQueries({ queryKey: ["shared-file-storage-migration", migration.migrationId] });
    }
  });
  const cancelMigrationMutation = useMutation({
    mutationFn: () => cancelStorageMigration(migrationId),
    onSuccess: () => void migrationQuery.refetch()
  });
  const retryMigrationMutation = useMutation({
    mutationFn: () => retryStorageMigration(migrationId),
    onSuccess: () => void migrationQuery.refetch()
  });

  const operationError = [
    testMutation.error,
    saveMutation.error,
    probeMutation.error,
    activateMutation.error,
    retireMutation.error,
    createMigrationMutation.error,
    cancelMigrationMutation.error,
    retryMigrationMutation.error
  ].find(Boolean);

  function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !tested || saveMutation.isPending) return;
    saveMutation.mutate(form);
  }

  function openEdit(profile: StorageProfile) {
    setTested(false);
    setNotice(null);
    setForm({
      profileId: profile.profileId,
      mode: "edit",
      locationLocked: profile.fileCount > 0,
      name: profile.name,
      endpoint: profile.endpoint,
      region: profile.region,
      bucket: profile.bucket,
      objectPrefix: profile.objectPrefix,
      credentialMode: profile.credentialMode || "ecs_ram_role",
      credentialAction: "keep",
      accessKeyId: "",
      accessKeySecret: ""
    });
  }

  function updateForm(patch: Partial<ProfileForm>) {
    setForm((current) => current ? { ...current, ...patch } : current);
    setTested(false);
  }

  return (
    <PageShell>
      <PageHeader
        title="网盘存储配置"
        actions={<>
          <Button asChild variant="outline"><Link to="/admin/shared-files"><ArrowLeft data-icon="inline-start" />返回网盘</Link></Button>
          {canManage ? <Button onClick={() => { setForm({ ...emptyForm }); setTested(false); }}><Plus data-icon="inline-start" />新建 OSS Profile</Button> : null}
        </>}
      >
        管理后续文件写入位置与存量迁移。
      </PageHeader>

      {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}
      {operationError ? <ErrorAlert>{operationError.message}</ErrorAlert> : null}

      <section className="mb-8 border-b pb-6">
        <h2 className="mb-4 text-base font-semibold">当前激活存储</h2>
        {stateQuery.isLoading ? <div className="text-sm text-muted-foreground">正在加载存储状态...</div> : null}
        {stateQuery.isError ? <ErrorAlert>{stateQuery.error.message}</ErrorAlert> : null}
        {active ? (
          <div className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <StorageFact label="名称" value={active.name} />
            <StorageFact label="类型" value={providerLabel(active.provider)} />
            <StorageFact label="健康状态" value={<HealthBadge health={active.health} />} />
            <StorageFact label="文件数" value={active.fileCount.toLocaleString()} />
            <StorageFact label="容量" value={formatBytes(active.sizeBytes)} />
          </div>
        ) : null}
      </section>

      <section className="mb-8">
        <h2 className="mb-4 text-base font-semibold">存储 Profile</h2>
        <DataTableShell minWidth={960}>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead><TableHead>类型</TableHead><TableHead>位置</TableHead><TableHead>凭据</TableHead>
              <TableHead>健康</TableHead><TableHead>文件</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stateQuery.isLoading ? <TableStateRow colSpan={7}>正在加载 Profile...</TableStateRow> : null}
            {!stateQuery.isLoading && profiles.length === 0 ? <TableRow><TableCell colSpan={7}><EmptyState title="暂无存储配置" /></TableCell></TableRow> : null}
            {profiles.map((profile) => (
              <TableRow key={profile.profileId}>
                <TableCell><div className="font-medium">{profile.name}</div>{profile.profileId === state?.activeProfileId ? <Badge className="mt-1" variant="accent">当前写入</Badge> : null}</TableCell>
                <TableCell>{providerLabel(profile.provider)}</TableCell>
                <TableCell className="max-w-72 text-xs">{profile.provider === "local" ? <div>服务器部署目录</div> : <>
                  <div className="truncate">Bucket: {profile.bucket}</div>
                  <div className="truncate text-muted-foreground">Region: {profile.region}</div>
                  <div className="truncate text-muted-foreground">Endpoint: {profile.endpoint}</div>
                  <div className="truncate text-muted-foreground">Prefix: {profile.objectPrefix}</div>
                </>}</TableCell>
                <TableCell className="text-xs">{profile.provider === "local" ? "-" : credentialLabel(profile)}</TableCell>
                <TableCell><HealthBadge health={profile.health} /></TableCell>
                <TableCell className="font-mono text-xs">{profile.fileCount} / {formatBytes(profile.sizeBytes)}</TableCell>
                <TableCell><div className="flex justify-end gap-2">
                  {canManage ? <Button aria-label={`检查${profile.name}连通性`} size="icon" title="检查连通性" variant="outline" onClick={() => probeMutation.mutate(profile.profileId)}><TestTube2 /></Button> : null}
                  {canManage && profile.provider === "aliyun_oss" ? <Button aria-label={`编辑${profile.name}`} size="icon" title="编辑" variant="outline" onClick={() => openEdit(profile)}><Pencil /></Button> : null}
                  {canManage && profile.profileId !== state?.activeProfileId && profile.status === "enabled" ? <Button size="sm" variant="secondary" disabled={profile.health !== "available"} onClick={() => setActivateTarget(profile)}>激活</Button> : null}
                  {canManage && profile.provider === "aliyun_oss" && profile.profileId !== state?.activeProfileId && profile.status === "enabled" ? <Button size="sm" variant="outline" onClick={() => retireMutation.mutate(profile.profileId)}>退役</Button> : null}
                </div></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTableShell>
      </section>

      {canMigrate ? (
        <MigrationSection
          profiles={enabledProfiles}
          sourceProfileId={sourceProfileId}
          targetProfileId={targetProfileId}
          migration={migrationQuery.data}
          loading={createMigrationMutation.isPending}
          onSourceChange={setSourceProfileId}
          onTargetChange={setTargetProfileId}
          onCreate={() => createMigrationMutation.mutate()}
          onCancel={() => cancelMigrationMutation.mutate()}
          onRetry={() => retryMigrationMutation.mutate()}
        />
      ) : null}

      <ModalShell open={Boolean(form)} title={form?.mode === "create" ? "新建 OSS Profile" : "编辑 OSS Profile"} subtitle="保存前会由服务端重新执行上传、读回和删除测试。" onClose={() => !saveMutation.isPending && setForm(null)}>
        <form className="flex flex-col gap-4" onSubmit={submitProfile}>
          <FieldGroup>
            <Field><FieldLabel htmlFor="storage-name">名称</FieldLabel><Input id="storage-name" required maxLength={100} value={form?.name ?? ""} onChange={(event) => updateForm({ name: event.target.value })} /></Field>
            <Field><FieldLabel htmlFor="storage-endpoint">Endpoint</FieldLabel><Input id="storage-endpoint" required readOnly={form?.locationLocked} value={form?.endpoint ?? ""} onChange={(event) => updateForm({ endpoint: event.target.value })} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="storage-region">Region</FieldLabel><Input id="storage-region" required readOnly={form?.locationLocked} value={form?.region ?? ""} onChange={(event) => updateForm({ region: event.target.value })} /></Field>
              <Field><FieldLabel htmlFor="storage-bucket">Bucket</FieldLabel><Input id="storage-bucket" required readOnly={form?.locationLocked} value={form?.bucket ?? ""} onChange={(event) => updateForm({ bucket: event.target.value })} /></Field>
            </div>
            <Field><FieldLabel htmlFor="storage-prefix">对象前缀</FieldLabel><Input id="storage-prefix" required readOnly={form?.locationLocked} value={form?.objectPrefix ?? ""} onChange={(event) => updateForm({ objectPrefix: event.target.value })} />{form?.locationLocked ? <FieldDescription>该 Profile 已有文件引用；如需修改位置，请创建新 Profile 后迁移。</FieldDescription> : null}</Field>
            <Field><FieldLabel htmlFor="credential-mode">凭据方式</FieldLabel><NativeSelect id="credential-mode" value={form?.credentialMode ?? "ecs_ram_role"} onChange={(event) => updateForm({ credentialMode: event.target.value as CredentialMode, credentialAction: event.target.value === "access_key" ? "replace" : "keep" })}><option value="ecs_ram_role">ECS RAM Role</option><option value="access_key">AccessKey</option></NativeSelect></Field>
            {form?.credentialMode === "access_key" ? <>
              {form.mode === "edit" ? <Field><FieldLabel htmlFor="credential-action">凭据操作</FieldLabel><NativeSelect id="credential-action" value={form.credentialAction} onChange={(event) => updateForm({ credentialAction: event.target.value as "keep" | "replace" })}><option value="keep">保留现有凭据</option><option value="replace">轮换凭据</option></NativeSelect></Field> : null}
              {form.credentialAction === "replace" ? <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="access-key-id">AccessKey ID</FieldLabel><Input autoComplete="off" id="access-key-id" required type="password" value={form.accessKeyId ?? ""} onChange={(event) => updateForm({ accessKeyId: event.target.value })} /></Field><Field><FieldLabel htmlFor="access-key-secret">AccessKey Secret</FieldLabel><Input autoComplete="new-password" id="access-key-secret" required type="password" value={form.accessKeySecret ?? ""} onChange={(event) => updateForm({ accessKeySecret: event.target.value })} /></Field></div> : null}
            </> : null}
          </FieldGroup>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={!form || testMutation.isPending} onClick={() => form && testMutation.mutate(form)}><TestTube2 data-icon="inline-start" />测试连接</Button>
            <Button type="submit" disabled={!tested || saveMutation.isPending}>保存</Button>
          </div>
        </form>
      </ModalShell>

      <ModalShell open={Boolean(activateTarget)} title="确认激活存储" subtitle="仅影响后续上传和替换，不自动迁移已有文件。" onClose={() => !activateMutation.isPending && setActivateTarget(null)}>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setActivateTarget(null)}>取消</Button><Button disabled={activateMutation.isPending} onClick={() => activateTarget && activateMutation.mutate(activateTarget.profileId)}>确认激活</Button></div>
      </ModalShell>
    </PageShell>
  );
}

function MigrationSection(props: {
  profiles: StorageProfile[];
  sourceProfileId: string;
  targetProfileId: string;
  migration?: StorageMigration;
  loading: boolean;
  onSourceChange(value: string): void;
  onTargetChange(value: string): void;
  onCreate(): void;
  onCancel(): void;
  onRetry(): void;
}) {
  const progress = props.migration?.totalCount
    ? Math.round(((props.migration.successCount + props.migration.failedCount + props.migration.skippedCount) / props.migration.totalCount) * 100)
    : 0;
  return <section className="border-t pt-6">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">存量迁移</h2>{props.migration ? <Badge variant={isMigrationOpen(props.migration.status) ? "warning" : "secondary"}>{migrationStatus(props.migration.status)}</Badge> : null}</div>
    <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
      <NativeSelect aria-label="源存储" value={props.sourceProfileId} onChange={(event) => props.onSourceChange(event.target.value)}>{props.profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name}</option>)}</NativeSelect>
      <NativeSelect aria-label="目标存储" value={props.targetProfileId} onChange={(event) => props.onTargetChange(event.target.value)}>{props.profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name}</option>)}</NativeSelect>
      <Button disabled={props.loading || !props.sourceProfileId || !props.targetProfileId || props.sourceProfileId === props.targetProfileId || isMigrationOpen(props.migration?.status)} onClick={props.onCreate}><Database data-icon="inline-start" />开始迁移</Button>
    </div>
    {props.migration ? <div className="mt-5 border-l-2 border-primary/35 pl-4">
      <div className="mb-2 flex items-center justify-between text-sm"><span className="font-mono text-xs">{props.migration.migrationId}</span><span>{progress}%</span></div>
      <div className="mb-4 h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
      <div className="grid gap-3 text-sm sm:grid-cols-5"><StorageFact label="成功" value={props.migration.successCount} /><StorageFact label="失败" value={props.migration.failedCount} /><StorageFact label="跳过" value={props.migration.skippedCount} /><StorageFact label="待清理" value={props.migration.cleanupPendingCount} /><StorageFact label="开始时间" value={formatDateTime(props.migration.startedAt ?? props.migration.createdAt)} /></div>
      {props.migration.failedItems.length > 0 ? <div className="mt-4 border-t pt-3">
        <div className="mb-2 text-xs font-medium text-muted-foreground">失败明细</div>
        <div className="space-y-2">{props.migration.failedItems.map((failed) => <div className="grid gap-1 text-xs sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" key={failed.fileId}><span className="truncate font-mono">{failed.fileId}</span><span>已尝试 {failed.attemptCount} 次</span><span className="text-muted-foreground">{failed.errorMessage || failed.errorCode}</span></div>)}</div>
      </div> : null}
      <div className="mt-4 flex justify-end gap-2">{isMigrationOpen(props.migration.status) ? <Button variant="outline" onClick={props.onCancel}>取消</Button> : null}{props.migration.failedCount > 0 ? <Button variant="outline" onClick={props.onRetry}><RotateCcw data-icon="inline-start" />重试失败项</Button> : null}<Button variant="ghost" onClick={() => location.reload()}><RefreshCw data-icon="inline-start" />刷新</Button></div>
    </div> : null}
  </section>;
}

function StorageFact({ label, value }: { label: string; value: ReactNode }) {
  return <div><div className="mb-1 text-xs text-muted-foreground">{label}</div><div className="min-h-5 font-medium">{value}</div></div>;
}

function HealthBadge({ health }: { health: StorageProfile["health"] }) {
  const labels = { available: "可用", unavailable: "不可用", unknown: "未知" };
  return <Badge variant={health === "available" ? "success" : health === "unavailable" ? "danger" : "muted"}>{labels[health]}</Badge>;
}

function providerLabel(provider: StorageProfile["provider"]) {
  return provider === "local" ? "服务器本地存储" : "阿里云 OSS";
}

function credentialLabel(profile: StorageProfile) {
  if (profile.credentialMode === "ecs_ram_role") return "ECS RAM Role";
  return profile.credentialsConfigured ? `AccessKey ····${profile.accessKeyIdHint}` : "未配置";
}

function isMigrationOpen(status?: StorageMigration["status"]) {
  return status === "pending" || status === "running";
}

function shouldPollMigration(status?: StorageMigration["status"]) {
  return isMigrationOpen(status) || status === "completed_with_cleanup_pending";
}

function migrationStatus(status: StorageMigration["status"]) {
  const labels: Record<StorageMigration["status"], string> = {
    pending: "等待中", running: "迁移中", completed: "已完成", completed_with_failures: "完成但有失败",
    completed_with_cleanup_pending: "完成，等待清理", cancelled: "已取消"
  };
  return labels[status];
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let index = -1;
  do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}
