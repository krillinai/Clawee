import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackagePlus } from "lucide-react";
import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { DataTableShell, EmptyState, ErrorAlert, FilterSelect, LoadingState, ModalShell, PageHeader, PageShell, SuccessAlert, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  getPublishedSkill,
  getPublishedSkillPackageURL,
  getPublishedSkillVersionFile,
  listAuthorizedSkillSpaces,
  listPublishedSkills,
  listPublishedSkillVersionFiles,
  uploadAppSkillVersion
} from "@/lib/skillhub-api";

import { SkillDetailView, type SkillDetailData } from "./skill-detail";

export function AppSkillsPage() {
  const [searchParams] = useSearchParams();
  const skillId = searchParams.get("skill_id") ?? "";
  return skillId ? <PublishedSkillDetail skillId={skillId} /> : <PublishedSkillList />;
}

function PublishedSkillList() {
  const queryClient = useQueryClient();
  const [spaceId, setSpaceId] = useState("all");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadSpaceId, setUploadSpaceId] = useState("");
  const [version, setVersion] = useState("");
  const [changelog, setChangelog] = useState("");
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["app-skills"], queryFn: listPublishedSkills });
  const spacesQuery = useQuery({ queryKey: ["app-skill-spaces"], queryFn: listAuthorizedSkillSpaces });
  const writableSpaces = useMemo(
    () => (spacesQuery.data ?? []).filter((space) => space.actions.includes("write")),
    [spacesQuery.data]
  );
  const allItems = query.data ?? [];
  const items = spaceId === "all" ? allItems : allItems.filter((item) => item.spaceId === spaceId);

  useEffect(() => {
    if (uploadOpen && !uploadSpaceId && writableSpaces[0]) {
      setUploadSpaceId(writableSpaces[0].spaceId);
    }
  }, [uploadOpen, uploadSpaceId, writableSpaces]);

  const uploadMutation = useMutation({
    mutationFn: () => uploadAppSkillVersion({ spaceId: uploadSpaceId, version, changelog, packageFile: packageFile as File }),
    onSuccess: (result) => {
      setUploadOpen(false);
      resetUploadForm();
      setNotice(`Skill“${result.skill.name}”版本 ${result.version.version} 已上传并发布`);
      void queryClient.invalidateQueries({ queryKey: ["app-skills"] });
      void queryClient.invalidateQueries({ queryKey: ["app-skill-spaces"] });
    }
  });

  function resetUploadForm() {
    setUploadSpaceId("");
    setVersion("");
    setChangelog("");
    setPackageFile(null);
    uploadMutation.reset();
  }

  function openUpload() {
    resetUploadForm();
    setNotice(null);
    setUploadSpaceId(writableSpaces[0]?.spaceId ?? "");
    setUploadOpen(true);
  }

  function closeUpload() {
    if (uploadMutation.isPending) return;
    setUploadOpen(false);
    resetUploadForm();
  }

  function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploadMutation.isPending || !uploadSpaceId || !version.trim() || !packageFile) return;
    uploadMutation.mutate();
  }

  function selectPackage(event: ChangeEvent<HTMLInputElement>) {
    setPackageFile(event.target.files?.[0] ?? null);
  }

  return (
    <PageShell>
      <PageHeader
        title="技能中心"
        actions={<Button disabled={spacesQuery.isLoading || writableSpaces.length === 0} onClick={openUpload} title={writableSpaces.length === 0 ? "暂无可上传的技能空间" : undefined} variant="primary"><PackagePlus aria-hidden="true" data-icon="inline-start" />上传 Skill</Button>}
      />
      {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}
      <div className="mb-3 max-w-64"><FilterSelect ariaLabel="筛选技能空间" value={spaceId} onChange={setSpaceId}><option value="all">全部空间</option>{(spacesQuery.data ?? []).map((space) => <option key={space.spaceId} value={space.spaceId}>{space.name}</option>)}</FilterSelect></div>
      <DataTableShell dense minWidth={800}>
        <TableHeader><TableRow><TableHead>技能</TableHead><TableHead>空间</TableHead><TableHead>版本</TableHead><TableHead>说明</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {query.isLoading ? <TableStateRow colSpan={5}><LoadingState label="正在加载技能" /></TableStateRow> : null}
          {query.isError ? <TableStateRow colSpan={5} tone="danger"><ErrorAlert>技能加载失败</ErrorAlert></TableStateRow> : null}
          {!query.isLoading && !query.isError && items.length === 0 ? <TableStateRow colSpan={5}><EmptyState title="暂无已发布技能" description="当前账户没有可用的已发布技能。" /></TableStateRow> : null}
          {items.map((item) => <TableRow key={item.skillId}><TableCell className="font-medium">{item.name}</TableCell><TableCell><Badge variant="outline">{item.spaceName}</Badge></TableCell><TableCell><Badge variant="secondary">v{item.version}</Badge></TableCell><TableCell className="max-w-96 text-muted-foreground"><span className="block truncate">{item.description}</span></TableCell><TableCell className="text-right"><Button asChild size="sm" variant="secondary"><Link to={`/app/skills/detail?skill_id=${encodeURIComponent(item.skillId)}`}>查看</Link></Button></TableCell></TableRow>)}
        </TableBody>
      </DataTableShell>
      <ModalShell
        contentClassName="max-w-[560px]"
        contextLabel="技能中心"
        open={uploadOpen}
        onClose={closeUpload}
        title="上传 Skill"
        subtitle="ZIP 可直接包含 SKILL.md，也可将全部内容放在单一顶层目录中；上传成功后将自动发布该版本，并替换当前发布版本。"
      >
        <form onSubmit={submitUpload}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="app-skill-upload-space">技能空间</FieldLabel>
              <FilterSelect ariaLabel="技能空间" value={uploadSpaceId} onChange={setUploadSpaceId}>
                {writableSpaces.map((space) => <option key={space.spaceId} value={space.spaceId}>{space.name}</option>)}
              </FilterSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="app-skill-version">版本号</FieldLabel>
              <Input id="app-skill-version" aria-label="版本号" maxLength={64} required value={version} onChange={(event) => setVersion(event.target.value)} />
              <FieldDescription>必填，支持字母、数字、点、下划线和连字符</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="app-skill-changelog">更新说明</FieldLabel>
              <Textarea id="app-skill-changelog" aria-label="更新说明" maxLength={2000} value={changelog} onChange={(event) => setChangelog(event.target.value)} />
              <FieldDescription>可选，最多 2000 字</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="app-skill-package">Skill ZIP 包</FieldLabel>
              <Input id="app-skill-package" aria-label="Skill ZIP 包" accept=".zip,application/zip" required type="file" onChange={selectPackage} />
              <FieldDescription>原始文件最大 50 MiB</FieldDescription>
            </Field>
            {uploadMutation.isError ? <ErrorAlert>上传失败：{errorMessage(uploadMutation.error)}</ErrorAlert> : null}
            <Field className="flex-wrap justify-end" orientation="horizontal">
              <Button disabled={uploadMutation.isPending} onClick={closeUpload} type="button" variant="outline">取消</Button>
              <Button disabled={uploadMutation.isPending || !uploadSpaceId || !version.trim() || !packageFile} type="submit" variant="primary">
                {uploadMutation.isPending ? "上传中..." : "确认上传"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </ModalShell>
    </PageShell>
  );
}

function PublishedSkillDetail({ skillId }: { skillId: string }) {
  const query = useQuery({ queryKey: ["app-skill", skillId], queryFn: () => getPublishedSkill(skillId) });
  if (query.isLoading) return <PageShell><LoadingState label="正在加载技能" /></PageShell>;
  if (query.isError || !query.data) return <PageShell><ErrorAlert>技能不存在或尚未发布</ErrorAlert></PageShell>;
  const item = query.data;
  const detail: SkillDetailData = {
    skill: {
      skillId: item.skillId,
      name: item.name,
      description: item.description,
      currentVersionId: item.versionId,
      updatedAt: item.updatedAt
    },
    versions: [{
      versionId: item.versionId,
      skillId: item.skillId,
      version: item.version,
      description: item.description,
      changelog: item.changelog ?? "",
      packageSha256: item.packageSha256,
      source: null,
      createdAt: item.updatedAt
    }]
  };
  return <SkillDetailView
    backHref="/app/skills"
    backLabel="返回技能中心"
    breadcrumbLabel="技能中心"
    detail={detail}
    getPackageURL={getPublishedSkillPackageURL}
    loadFile={getPublishedSkillVersionFile}
    loadFiles={listPublishedSkillVersionFiles}
    queryScope="app-skill"
  />;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
