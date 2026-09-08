import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Edit3, FolderInput, PackageCheck, PackagePlus, Plus, Power, PowerOff, RefreshCw } from "lucide-react";
import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  ConfirmDialog,
  DataTableShell,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  FilterSelect,
  LoadingState,
  ModalShell,
  PageHeader,
  PageShell,
  SuccessAlert,
  TableStateRow
} from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { SkillSourceForm, type SkillSourceFormInput } from "@/components/skill-source-form";
import { SkillSpacesPanel } from "@/components/skill-spaces-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createGitHubSource,
  disableGitHubSource,
  enableGitHubSource,
  getGitHubSourceToken,
  getSkillSourceAvailability,
  listGitHubSources,
  listSkillSpaces,
  listSkills,
  moveSkillsToSpace,
  publishLatestSkillVersions,
  queueGitHubSourceSync,
  updateGitHubSource,
  type GitHubSource,
  uploadSkillVersion
} from "@/lib/skillhub-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";

const skillsKey = ["skills"] as const;
const skillSourcesKey = ["skill-sources"] as const;
const skillSourceAvailabilityKey = ["skill-source-availability"] as const;

export function SkillsPage() {
  const canManage = useAdminPermission(permissions.skillManage);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [publication, setPublication] = useState("all");
  const [spaceFilter, setSpaceFilter] = useState("all");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [version, setVersion] = useState("");
  const [uploadSpaceId, setUploadSpaceId] = useState("");
  const [changelog, setChangelog] = useState("");
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [batchPublishOpen, setBatchPublishOpen] = useState(false);
  const [batchPublishError, setBatchPublishError] = useState<string | null>(null);
  const [batchSpaceOpen, setBatchSpaceOpen] = useState(false);
  const [targetSpaceId, setTargetSpaceId] = useState("");
  const [activeTab, setActiveTab] = useState("skills");
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<GitHubSource | null>(null);
  const [editingToken, setEditingToken] = useState("");
  const [disableTarget, setDisableTarget] = useState<GitHubSource | null>(null);
  const [statusAction, setStatusAction] = useState<"enable" | "disable" | null>(null);
  const [sourceActionError, setSourceActionError] = useState<string | null>(null);

  const skillsQuery = useQuery({ queryKey: skillsKey, queryFn: listSkills });
  const spacesQuery = useQuery({ queryKey: ["skill-spaces"], queryFn: listSkillSpaces });
  const sourceAvailabilityQuery = useQuery({ queryKey: skillSourceAvailabilityKey, queryFn: getSkillSourceAvailability });
  const skillSourceEnabled = sourceAvailabilityQuery.data === true;
  const sourcesQuery = useQuery({ queryKey: skillSourcesKey, queryFn: listGitHubSources, enabled: skillSourceEnabled && activeTab === "sources" });
  const skills = skillsQuery.data ?? [];
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return skills.filter((item) => {
      const matchesPublication =
        publication === "all" ||
        (publication === "published" && item.currentVersionId !== null) ||
        (publication === "unpublished" && item.currentVersionId === null);
      const matchesSpace = spaceFilter === "all" || item.spaceId === spaceFilter;
      const matchesQuery = !normalized || [item.name, item.description, item.createdBy].join(" ").toLowerCase().includes(normalized);
      return matchesPublication && matchesSpace && matchesQuery;
    });
  }, [publication, query, skills, spaceFilter]);
  const selectedSkills = useMemo(
    () => skills.filter((item) => selectedSkillIds.has(item.skillId)),
    [selectedSkillIds, skills]
  );
  const selectedSpaceCount = useMemo(() => new Set(selectedSkills.map((item) => item.spaceId)).size, [selectedSkills]);
  const moveCandidateCount = selectedSkills.filter((item) => item.spaceId !== targetSpaceId).length;
  const targetSpace = (spacesQuery.data ?? []).find((space) => space.spaceId === targetSpaceId);
  const allFilteredSelected = filtered.length > 0 && filtered.every((item) => selectedSkillIds.has(item.skillId));
  const someFilteredSelected = filtered.some((item) => selectedSkillIds.has(item.skillId));

  useEffect(() => {
    const available = new Set(skills.map((item) => item.skillId));
    setSelectedSkillIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [skills]);

  useEffect(() => {
    if (uploadOpen && !uploadSpaceId && spacesQuery.data?.[0]) {
      setUploadSpaceId(spacesQuery.data[0].spaceId);
    }
  }, [spacesQuery.data, uploadOpen, uploadSpaceId]);

  const uploadMutation = useMutation({
    mutationFn: () => uploadSkillVersion({ spaceId: uploadSpaceId, version, changelog, packageFile: packageFile as File }),
    onSuccess: (result) => {
      setUploadOpen(false);
      resetUploadForm();
      setNotice(`Skill“${result.skill.name}”版本 ${result.version.version} 已上传并发布`);
      void queryClient.invalidateQueries({ queryKey: skillsKey });
      void queryClient.invalidateQueries({ queryKey: ["skill", result.skill.skillId] });
    }
  });

  const batchPublishMutation = useMutation({
    mutationFn: () => publishLatestSkillVersions(selectedSkills.map(({ skillId, name }) => ({ skillId, name }))),
    onSuccess: (result) => {
      setBatchPublishOpen(false);
      if (result.published.length > 0) {
        setNotice(`已批量发布 ${result.published.length} 个 Skill 的最新版本`);
      }
      if (result.failed.length > 0) {
        setBatchPublishError(`有 ${result.failed.length} 个 Skill 发布失败：${result.failed.map((item) => `${item.name}（${errorMessage(item.error)}）`).join("、")}`);
      } else {
        setBatchPublishError(null);
      }
      const publishedIds = new Set(result.published.map((item) => item.skill.skillId));
      setSelectedSkillIds((current) => new Set([...current].filter((id) => !publishedIds.has(id))));
      void queryClient.invalidateQueries({ queryKey: skillsKey });
      result.published.forEach((item) => {
        void queryClient.invalidateQueries({ queryKey: ["skill", item.skill.skillId] });
      });
    }
  });

  const batchSpaceMutation = useMutation({
    mutationFn: () => moveSkillsToSpace({ skillIds: selectedSkills.map((item) => item.skillId), targetSpaceId }),
    onSuccess: (result) => {
      setBatchSpaceOpen(false);
      setTargetSpaceId("");
      setNotice(`已将 ${result.movedCount} 个 Skill 调整至“${targetSpace?.name ?? result.targetSpaceId}”${result.unchangedCount > 0 ? `，${result.unchangedCount} 个无需调整` : ""}`);
      const movedSkillIds = selectedSkills.map((item) => item.skillId);
      setSelectedSkillIds(new Set());
      void queryClient.invalidateQueries({ queryKey: skillsKey });
      void queryClient.invalidateQueries({ queryKey: ["skill-spaces"] });
      movedSkillIds.forEach((skillId) => {
        void queryClient.invalidateQueries({ queryKey: ["skill", skillId] });
      });
    }
  });

  const sourceMutation = useMutation({
    mutationFn: ({ sourceId, input }: { sourceId?: string; input: SkillSourceFormInput }) => (
      sourceId ? updateGitHubSource(sourceId, input) : createGitHubSource(input)
    ),
    onSuccess: (source) => {
      setSourceFormOpen(false);
      setEditingSource(null);
      setEditingToken("");
      setNotice(`GitHub 来源 ${source.repositoryOwner}/${source.repositoryName} 已保存`);
      void queryClient.invalidateQueries({ queryKey: skillSourcesKey });
      void queryClient.invalidateQueries({ queryKey: ["skill-source", source.sourceId] });
    }
  });

  const sourceTokenMutation = useMutation({
    mutationFn: async (source: GitHubSource) => ({ source, token: await getGitHubSourceToken(source.sourceId) }),
    onSuccess: ({ source, token }) => {
      setEditingSource(source);
      setEditingToken(token);
      setSourceFormOpen(true);
    },
    onError: (error) => {
      setSourceActionError(`读取访问 Token 失败：${errorMessage(error)}`);
    }
  });

  const syncMutation = useMutation({
    mutationFn: queueGitHubSourceSync,
    onSuccess: (result, sourceId) => {
      setSourceActionError(null);
      setNotice(`已排队，同步任务 ${result.runId} 正在等待执行`);
      void queryClient.invalidateQueries({ queryKey: skillSourcesKey });
      void queryClient.invalidateQueries({ queryKey: ["skill-source", sourceId] });
      void queryClient.invalidateQueries({ queryKey: ["skill-source-sync-runs", sourceId] });
    },
    onError: (error) => {
      setSourceActionError(`同步失败：${errorMessage(error)}`);
    }
  });

  const statusMutation = useMutation({
    mutationFn: ({ sourceId, enabled }: { sourceId: string; enabled: boolean }) => (
      enabled ? enableGitHubSource(sourceId) : disableGitHubSource(sourceId)
    ),
    onSuccess: (source) => {
      setDisableTarget(null);
      setStatusAction(null);
      setSourceActionError(null);
      setNotice(`GitHub 来源 ${source.repositoryOwner}/${source.repositoryName} 已${source.status === "active" ? "启用" : "停用"}`);
      void queryClient.invalidateQueries({ queryKey: skillSourcesKey });
      void queryClient.invalidateQueries({ queryKey: ["skill-source", source.sourceId] });
    },
    onError: (error, { enabled }) => {
      setSourceActionError(`${enabled ? "启用" : "停用"}失败：${errorMessage(error)}`);
    }
  });

  function resetUploadForm() {
    setVersion("");
    setUploadSpaceId("");
    setChangelog("");
    setPackageFile(null);
    uploadMutation.reset();
  }

  function openUpload() {
    resetUploadForm();
    setNotice(null);
    setUploadSpaceId(spacesQuery.data?.[0]?.spaceId ?? "");
    setUploadOpen(true);
  }

  function closeUpload() {
    if (uploadMutation.isPending) return;
    setUploadOpen(false);
    resetUploadForm();
  }

  function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploadMutation.isPending || !uploadSpaceId || !version || !packageFile) return;
    uploadMutation.mutate();
  }

  function selectPackage(event: ChangeEvent<HTMLInputElement>) {
    setPackageFile(event.target.files?.[0] ?? null);
  }

  function openSourceForm(source?: GitHubSource) {
    sourceMutation.reset();
    sourceTokenMutation.reset();
    setSourceActionError(null);
    if (source) {
      sourceTokenMutation.mutate(source);
      return;
    }
    setEditingSource(null);
    setEditingToken("");
    setSourceFormOpen(true);
  }

  function closeSourceForm() {
    if (sourceMutation.isPending) return;
    setSourceFormOpen(false);
    setEditingSource(null);
    setEditingToken("");
    sourceMutation.reset();
  }

  function submitSource(input: SkillSourceFormInput) {
    sourceMutation.mutate({ sourceId: editingSource?.sourceId, input });
  }

  function confirmDisableSource() {
    if (disableTarget) startStatusMutation(disableTarget, false);
  }

  function openDisableConfirmation(source: GitHubSource) {
    statusMutation.reset();
    setStatusAction(null);
    setSourceActionError(null);
    setDisableTarget(source);
  }

  function startSyncMutation(source: GitHubSource) {
    syncMutation.reset();
    setSourceActionError(null);
    syncMutation.mutate(source.sourceId);
  }

  function startStatusMutation(source: GitHubSource, enabled: boolean) {
    statusMutation.reset();
    setStatusAction(enabled ? "enable" : "disable");
    setSourceActionError(null);
    statusMutation.mutate({ sourceId: source.sourceId, enabled });
  }

  function closeDisableConfirmation() {
    if (statusMutation.isPending) return;
    statusMutation.reset();
    setStatusAction(null);
    setDisableTarget(null);
  }

  function toggleSkill(skillId: string, checked: boolean) {
    setSelectedSkillIds((current) => {
      const next = new Set(current);
      if (checked) next.add(skillId);
      else next.delete(skillId);
      return next;
    });
  }

  function toggleFilteredSkills(checked: boolean) {
    setSelectedSkillIds((current) => {
      const next = new Set(current);
      filtered.forEach((item) => {
        if (checked) next.add(item.skillId);
        else next.delete(item.skillId);
      });
      return next;
    });
  }

  function openBatchPublish() {
    if (selectedSkills.length === 0) return;
    batchPublishMutation.reset();
    setBatchPublishError(null);
    setNotice(null);
    setBatchPublishOpen(true);
  }

  function closeBatchPublish() {
    if (batchPublishMutation.isPending) return;
    setBatchPublishOpen(false);
    batchPublishMutation.reset();
  }

  function openBatchSpace() {
    if (selectedSkills.length === 0) return;
    batchSpaceMutation.reset();
    setBatchPublishError(null);
    setNotice(null);
    const spaces = spacesQuery.data ?? [];
    const initialTarget = spaces.find((space) => selectedSkills.some((skill) => skill.spaceId !== space.spaceId)) ?? spaces[0];
    setTargetSpaceId(initialTarget?.spaceId ?? "");
    setBatchSpaceOpen(true);
  }

  function closeBatchSpace() {
    if (batchSpaceMutation.isPending) return;
    setBatchSpaceOpen(false);
    setTargetSpaceId("");
    batchSpaceMutation.reset();
  }

  function submitBatchSpace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (batchSpaceMutation.isPending || !targetSpaceId || moveCandidateCount === 0) return;
    batchSpaceMutation.mutate();
  }

  return (
    <PageShell>
      <PageHeader
        title="技能中心"
        actions={canManage && activeTab === "skills" ? (
          <>
            {selectedSkills.length > 0 ? (
              <>
                <Button disabled={spacesQuery.isLoading} onClick={openBatchSpace} variant="outline">
                  <FolderInput data-icon="inline-start" aria-hidden="true" />
                  调整空间（{selectedSkills.length}）
                </Button>
                <Button onClick={openBatchPublish} variant="outline">
                  <PackageCheck data-icon="inline-start" aria-hidden="true" />
                  批量发布（{selectedSkills.length}）
                </Button>
              </>
            ) : null}
            <Button onClick={openUpload} variant="primary">
              <PackagePlus data-icon="inline-start" aria-hidden="true" />
              上传版本
            </Button>
          </>
        ) : undefined}
      >
        集中校验、发布和回滚企业 Skill 包。技能中心只管理可安装版本，不处理用户本地安装目录、文件冲突或安装回滚。
      </PageHeader>

      {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}
      {batchPublishError ? <ErrorAlert>{batchPublishError}</ErrorAlert> : null}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="h-auto justify-start">
          <TabsTrigger value="skills">Skill 列表</TabsTrigger>
          <TabsTrigger value="spaces">技能空间</TabsTrigger>
          {skillSourceEnabled ? <TabsTrigger value="sources">GitHub 来源</TabsTrigger> : null}
        </TabsList>
        <TabsContent className="mt-6" value="skills">
          <section aria-label="Skill 列表" className="grid gap-4">
            <FilterRow compact>
              <FilterSearchField
                aria-label="搜索 Skill"
                placeholder="搜索名称 / 说明 / 创建人"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <FilterSelect ariaLabel="筛选发布状态" value={publication} onChange={setPublication}>
                <option value="all">全部状态</option>
                <option value="published">已发布</option>
                <option value="unpublished">未发布</option>
              </FilterSelect>
              <FilterSelect ariaLabel="筛选技能空间" value={spaceFilter} onChange={setSpaceFilter}>
                <option value="all">全部空间</option>
                {(spacesQuery.data ?? []).map((space) => <option key={space.spaceId} value={space.spaceId}>{space.name}</option>)}
              </FilterSelect>
            </FilterRow>

            <DataTableShell dense minWidth={canManage ? 960 : 920}>
              <TableHeader>
                <TableRow>
                  {canManage ? (
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="选择当前可见的 Skill"
                        checked={allFilteredSelected || (someFilteredSelected ? "indeterminate" : false)}
                        disabled={filtered.length === 0}
                        onCheckedChange={(checked) => toggleFilteredSkills(checked === true)}
                      />
                    </TableHead>
                  ) : null}
                  <TableHead>名称</TableHead>
                  <TableHead>所属空间</TableHead>
                  <TableHead>说明</TableHead>
                  <TableHead>发布状态</TableHead>
                  <TableHead>当前版本 ID</TableHead>
                  <TableHead>创建人</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skillsQuery.isLoading ? <TableStateRow colSpan={canManage ? 9 : 8}><LoadingState label="正在加载 Skill" /></TableStateRow> : null}
                {skillsQuery.isError ? (
                  <TableStateRow colSpan={canManage ? 9 : 8} tone="danger"><ErrorAlert>Skill 加载失败：{errorMessage(skillsQuery.error)}。请稍后重试。</ErrorAlert></TableStateRow>
                ) : null}
                {!skillsQuery.isLoading && !skillsQuery.isError && filtered.length === 0 ? (
                  <TableStateRow colSpan={canManage ? 9 : 8}>
                    <EmptyState
                      title={skills.length === 0 ? "暂无 Skill" : "暂无匹配的 Skill"}
                      description={skills.length === 0 ? "上传 ZIP 包后即可创建首个 Skill 版本。" : "请调整搜索词或发布状态筛选。"}
                    />
                  </TableStateRow>
                ) : null}
                {!skillsQuery.isLoading && !skillsQuery.isError ? filtered.map((item) => (
                  <TableRow data-state={selectedSkillIds.has(item.skillId) ? "selected" : undefined} key={item.skillId}>
                    {canManage ? (
                      <TableCell>
                        <Checkbox
                          aria-label={`选择 ${item.name}`}
                          checked={selectedSkillIds.has(item.skillId)}
                          onCheckedChange={(checked) => toggleSkill(item.skillId, checked === true)}
                        />
                      </TableCell>
                    ) : null}
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell><Badge variant="outline">{item.spaceName}</Badge></TableCell>
                    <TableCell className="max-w-80 text-muted-foreground"><span className="block truncate" title={item.description}>{item.description}</span></TableCell>
                    <TableCell><PublicationBadge published={item.currentVersionId !== null} /></TableCell>
                    <TableCell className="max-w-56 font-mono text-xs"><span className="block truncate" title={item.currentVersionId ?? undefined}>{item.currentVersionId ?? "-"}</span></TableCell>
                    <TableCell className="font-mono text-xs">{item.createdBy}</TableCell>
                    <TableCell className="font-mono text-xs">{formatDateTime(item.updatedAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="secondary">
                        <Link aria-label={`查看 ${item.name} 详情`} to={`/admin/skills/detail?skill_id=${encodeURIComponent(item.skillId)}`}>查看详情</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                )) : null}
              </TableBody>
            </DataTableShell>
          </section>
        </TabsContent>
        <TabsContent className="mt-6" value="spaces"><SkillSpacesPanel canManage={canManage} /></TabsContent>
        {skillSourceEnabled ? <TabsContent className="mt-6" value="sources">
          <SkillSourcesTable
            canManage={canManage}
            error={sourcesQuery.isError ? errorMessage(sourcesQuery.error) : null}
            actionError={sourceActionError}
            loading={sourcesQuery.isLoading}
            onCreate={() => openSourceForm()}
            onDisable={openDisableConfirmation}
            onEdit={openSourceForm}
            onEnable={(source) => startStatusMutation(source, true)}
            onSync={startSyncMutation}
            sources={sourcesQuery.data ?? []}
            editPending={sourceTokenMutation.isPending}
            statusPending={statusMutation.isPending || syncMutation.isPending}
            syncPending={syncMutation.isPending || statusMutation.isPending}
          />
        </TabsContent> : null}
      </Tabs>

      <ModalShell
        contentClassName="max-w-[560px]"
        contextLabel="技能中心"
        open={uploadOpen}
        onClose={closeUpload}
        title="上传 Skill 版本"
        subtitle="ZIP 可直接包含 SKILL.md，也可将全部内容放在单一顶层目录中；上传成功后将自动发布该版本，并替换当前发布版本。"
      >
        <form onSubmit={submitUpload}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="skill-upload-space">技能空间</FieldLabel>
              <FilterSelect ariaLabel="技能空间" value={uploadSpaceId} onChange={setUploadSpaceId}>
                {(spacesQuery.data ?? []).map((space) => <option key={space.spaceId} value={space.spaceId}>{space.name}</option>)}
              </FilterSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-version">版本号</FieldLabel>
              <Input id="skill-version" aria-label="版本号" maxLength={64} required value={version} onChange={(event) => setVersion(event.target.value)} />
              <FieldDescription>必填，支持字母、数字、点、下划线和连字符</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-changelog">更新说明</FieldLabel>
              <Textarea id="skill-changelog" aria-label="更新说明" maxLength={2000} value={changelog} onChange={(event) => setChangelog(event.target.value)} />
              <FieldDescription>可选，最多 2000 字</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-package">Skill ZIP 包</FieldLabel>
              <Input id="skill-package" aria-label="Skill ZIP 包" accept=".zip,application/zip" required type="file" onChange={selectPackage} />
              <FieldDescription>原始文件最大 50 MiB</FieldDescription>
            </Field>
            {uploadMutation.isError ? <ErrorAlert>上传失败：{errorMessage(uploadMutation.error)}。请检查版本号和 ZIP 包后重试。</ErrorAlert> : null}
            <Field className="flex-wrap justify-end" orientation="horizontal">
              <Button disabled={uploadMutation.isPending} onClick={closeUpload} type="button" variant="outline">取消</Button>
              <Button disabled={uploadMutation.isPending || !uploadSpaceId || !version || !packageFile} type="submit" variant="primary">
                {uploadMutation.isPending ? "上传中..." : "确认上传"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </ModalShell>

      <ModalShell
        contentClassName="max-w-[520px]"
        contextLabel="技能中心"
        open={batchSpaceOpen}
        onClose={closeBatchSpace}
        title="批量调整技能空间"
        subtitle="调整后，Skill 将立即按照目标空间的成员权限控制访问。"
      >
        <form onSubmit={submitBatchSpace}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="batch-skill-space">目标技能空间</FieldLabel>
              <Select value={targetSpaceId} onValueChange={setTargetSpaceId}>
                <SelectTrigger aria-label="目标技能空间" id="batch-skill-space"><SelectValue placeholder="选择目标技能空间" /></SelectTrigger>
                <SelectContent><SelectGroup>{(spacesQuery.data ?? []).map((space) => <SelectItem key={space.spaceId} value={space.spaceId}>{space.name}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
              <FieldDescription>
                已选择 {selectedSkills.length} 个 Skill，来自 {selectedSpaceCount} 个技能空间；实际调整 {moveCandidateCount} 个。
              </FieldDescription>
            </Field>
            {batchSpaceMutation.isError ? <ErrorAlert>调整失败：{errorMessage(batchSpaceMutation.error)}。本次未调整任何 Skill。</ErrorAlert> : null}
            <Field className="flex-wrap justify-end" orientation="horizontal">
              <Button disabled={batchSpaceMutation.isPending} onClick={closeBatchSpace} type="button" variant="outline">取消</Button>
              <Button disabled={batchSpaceMutation.isPending || !targetSpaceId || moveCandidateCount === 0} type="submit" variant="primary">
                {batchSpaceMutation.isPending ? "调整中..." : `确认调整 ${moveCandidateCount} 个`}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </ModalShell>

      <ModalShell
        contentClassName="max-w-[620px]"
        contextLabel="技能中心"
        open={sourceFormOpen}
        onClose={closeSourceForm}
        title={editingSource ? "编辑 GitHub 来源" : "新增 GitHub 来源"}
      >
        <SkillSourceForm
          onCancel={closeSourceForm}
          onSubmit={submitSource}
          pending={sourceMutation.isPending}
          source={editingSource ?? undefined}
          spaces={spacesQuery.data ?? []}
          initialToken={editingToken}
        />
        {sourceMutation.isError ? <ErrorAlert>保存失败：{errorMessage(sourceMutation.error)}</ErrorAlert> : null}
      </ModalShell>
      <ConfirmDialog
        confirmLabel={batchPublishMutation.isPending ? "发布中..." : `确认发布 ${selectedSkills.length} 个`}
        description={selectedSkills.length > 0 ? `将所选 ${selectedSkills.length} 个 Skill 的最新上传版本设为当前版本。已是最新版本的 Skill 不会产生额外变更。` : ""}
        error={batchPublishMutation.isError ? `批量发布失败：${errorMessage(batchPublishMutation.error)}` : undefined}
        onClose={closeBatchPublish}
        onConfirm={() => batchPublishMutation.mutate()}
        open={batchPublishOpen}
        pending={batchPublishMutation.isPending}
        title="批量发布 Skill"
      />
      <ConfirmDialog
        confirmLabel={statusMutation.isPending ? "停用中..." : "确认停用"}
        description={disableTarget ? `停用后不会再按调度同步 ${disableTarget.repositoryOwner}/${disableTarget.repositoryName}，仍可稍后重新启用。` : ""}
        error={statusAction === "disable" && statusMutation.isError ? `停用失败：${errorMessage(statusMutation.error)}` : undefined}
        onClose={closeDisableConfirmation}
        onConfirm={confirmDisableSource}
        open={Boolean(disableTarget)}
        pending={statusMutation.isPending}
        title="停用 GitHub 来源"
        variant="destructive"
      />

    </PageShell>
  );
}

function PublicationBadge({ published }: { published: boolean }) {
  return <Badge variant={published ? "success" : "muted"}>{published ? "已发布" : "未发布"}</Badge>;
}

function SkillSourcesTable({
  actionError,
  canManage,
  error,
  editPending,
  loading,
  onCreate,
  onDisable,
  onEdit,
  onEnable,
  onSync,
  sources,
  statusPending,
  syncPending
}: {
  actionError: string | null;
  canManage: boolean;
  error: string | null;
  editPending: boolean;
  loading: boolean;
  onCreate: () => void;
  onDisable: (source: GitHubSource) => void;
  onEdit: (source: GitHubSource) => void;
  onEnable: (source: GitHubSource) => void;
  onSync: (source: GitHubSource) => void;
  sources: Awaited<ReturnType<typeof listGitHubSources>>;
  statusPending: boolean;
  syncPending: boolean;
}) {
  return (
    <section aria-label="GitHub 来源" className="grid gap-5">
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={onCreate} variant="primary"><Plus data-icon="inline-start" aria-hidden="true" />新增来源</Button>
        </div>
      ) : null}
      {actionError ? <ErrorAlert>{actionError}</ErrorAlert> : null}
      <DataTableShell dense minWidth={1280}>
        <TableHeader>
          <TableRow>
            <TableHead>仓库</TableHead>
            <TableHead>分支</TableHead>
            <TableHead>扫描根</TableHead>
            <TableHead>调度</TableHead>
            <TableHead>自动发布</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>最近同步</TableHead>
            <TableHead>Commit</TableHead>
            <TableHead>结果</TableHead>
            <TableHead>发现数</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? <TableStateRow colSpan={11}><LoadingState label="正在加载 GitHub 来源" /></TableStateRow> : null}
          {error ? <TableStateRow colSpan={11} tone="danger"><ErrorAlert>GitHub 来源加载失败：{error}</ErrorAlert></TableStateRow> : null}
          {!loading && !error && sources.length === 0 ? <TableStateRow colSpan={11}><EmptyState title="暂无 GitHub 来源" /></TableStateRow> : null}
          {!loading && !error ? sources.map(({ source, latestRun, discoveredCount }) => {
            const commit = source.lastSyncedCommitSha ?? latestRun?.targetCommitSha;
            const sourceName = `${source.repositoryOwner}/${source.repositoryName}`;
            const isEnabled = source.status === "active";
            return <TableRow key={source.sourceId}>
              <TableCell className="font-medium">{sourceName}</TableCell>
              <TableCell>{source.branch || "默认"}</TableCell>
              <TableCell className="max-w-40"><span className="block truncate" title={source.scanRoot}>{source.scanRoot}</span></TableCell>
              <TableCell>{scheduleLabel(source.schedule)}</TableCell>
              <TableCell><Badge variant={source.autoPublish ? "success" : "muted"}>{source.autoPublish ? "自动发布" : "手动发布"}</Badge></TableCell>
              <TableCell><Badge variant={isEnabled ? "success" : "muted"}>{isEnabled ? "启用" : "已停用"}</Badge></TableCell>
              <TableCell className="font-mono text-xs">{formatDateTime(source.lastSuccessAt ?? source.lastAttemptAt)}</TableCell>
              <TableCell className="font-mono text-xs">
                {commit ? <a aria-label={`查看 Commit ${commit.slice(0, 8)}`} className="text-primary hover:underline" href={`https://github.com/${encodeURIComponent(source.repositoryOwner)}/${encodeURIComponent(source.repositoryName)}/commit/${encodeURIComponent(commit)}`} rel="noreferrer" target="_blank" title={commit}>{commit.slice(0, 8)}</a> : "-"}
              </TableCell>
              <TableCell><Badge variant={runVariant(latestRun?.status)}>{runLabel(latestRun?.status)}</Badge></TableCell>
              <TableCell className="font-mono text-xs">{discoveredCount}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button asChild aria-label={`查看 ${sourceName} 来源详情`} size="sm" variant="secondary"><Link to={`/admin/skills/source-detail?source_id=${encodeURIComponent(source.sourceId)}`}>详情</Link></Button>
                {canManage ? <>
                  <Button aria-label={`编辑 ${sourceName}`} disabled={editPending} onClick={() => onEdit(source)} size="sm" variant="secondary"><Edit3 data-icon="inline-start" aria-hidden="true" />编辑</Button>
                  <Button aria-label={`立即同步 ${sourceName}`} disabled={syncPending} onClick={() => onSync(source)} size="sm" variant="secondary"><RefreshCw data-icon="inline-start" aria-hidden="true" />同步</Button>
                  {isEnabled ? <Button aria-label={`禁用 ${sourceName}`} disabled={statusPending} onClick={() => onDisable(source)} size="sm" variant="secondary"><PowerOff data-icon="inline-start" aria-hidden="true" />停用</Button> : <Button aria-label={`启用 ${sourceName}`} disabled={statusPending} onClick={() => onEnable(source)} size="sm" variant="secondary"><Power data-icon="inline-start" aria-hidden="true" />启用</Button>}
                </> : null}</div>
              </TableCell>
            </TableRow>;
          }) : null}
        </TableBody>
      </DataTableShell>
    </section>
  );
}

function scheduleLabel(schedule: string) {
  return schedule === "hourly" ? "每小时" : schedule === "daily" ? "每日" : "手动";
}

function runLabel(status?: string) {
  return status === "success" ? "成功" : status === "running" ? "进行中" : status === "queued" ? "已排队" : status === "failed" ? "失败" : "-";
}

function runVariant(status?: string) {
  return status === "success" ? "success" : status === "failed" ? "destructive" : "muted";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
