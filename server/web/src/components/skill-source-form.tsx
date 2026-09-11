import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { GitHubSource, SkillSpace } from "@/lib/skillhub-api";

export type SkillSourceFormInput = {
  spaceId: string;
  repositoryOwner: string;
  repositoryName: string;
  branch: string;
  scanRoot: string;
  excludePaths: string[];
  token?: string;
  autoPublish: boolean;
  schedule: string;
};

function parseGitHubRepositoryURL(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;

    const match = url.pathname.replace(/\/$/, "").match(/^\/([^/]+)\/([^/]+)$/);
    if (!match) return null;

    const repositoryName = match[2].replace(/\.git$/, "");
    if (!repositoryName) return null;
    return { repositoryOwner: match[1], repositoryName };
  } catch {
    return null;
  }
}

export function SkillSourceForm({
  source,
  spaces = [],
  initialToken = "",
  onSubmit,
  onCancel,
  pending = false
}: {
  source?: GitHubSource;
  spaces?: SkillSpace[];
  initialToken?: string;
  onSubmit: (input: SkillSourceFormInput) => void;
  onCancel: () => void;
  pending?: boolean;
}) {
  const isEditing = Boolean(source);
  const [spaceId, setSpaceId] = useState(source?.spaceId ?? spaces[0]?.spaceId ?? "skillspace_default");
  const [repositoryURL, setRepositoryURL] = useState(source ? `https://github.com/${source.repositoryOwner}/${source.repositoryName}` : "");
  const [branch, setBranch] = useState(source?.branch ?? "");
  const [scanRoot, setScanRoot] = useState(source?.scanRoot ?? ".");
  const [excludePrefixes, setExcludePrefixes] = useState(source?.excludePaths.join("\n") ?? "");
  const [token, setToken] = useState(initialToken);
  const [autoPublish, setAutoPublish] = useState(source?.autoPublish ?? false);
  const [schedule, setSchedule] = useState(source?.schedule ?? "manual");
  const repository = parseGitHubRepositoryURL(repositoryURL);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !repository || !spaceId) return;
    onSubmit({
      spaceId,
      repositoryOwner: repository.repositoryOwner,
      repositoryName: repository.repositoryName,
      branch: branch.trim(),
      scanRoot: scanRoot.trim(),
      excludePaths: excludePrefixes.split("\n").map((item) => item.trim()).filter(Boolean),
      ...(token.trim() ? { token: token.trim() } : {}),
      autoPublish,
      schedule
    });
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="source-skill-space">技能空间</FieldLabel>
          <Select disabled={isEditing} value={spaceId} onValueChange={setSpaceId}>
            <SelectTrigger aria-label="技能空间" id="source-skill-space"><SelectValue placeholder="选择技能空间" /></SelectTrigger>
            <SelectContent><SelectGroup>{spaces.map((space) => <SelectItem key={space.spaceId} value={space.spaceId}>{space.name}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          <FieldDescription>来源创建后不能修改所属空间。</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="source-repository-url">GitHub 仓库地址</FieldLabel>
          <Input
            aria-invalid={repositoryURL.trim() !== "" && !repository}
            disabled={isEditing}
            id="source-repository-url"
            placeholder="https://github.com/acme/skills"
            required
            type="url"
            value={repositoryURL}
            onChange={(event) => setRepositoryURL(event.target.value)}
          />
          {!isEditing ? <FieldDescription>填写完整的 GitHub 仓库地址，例如 https://github.com/acme/skills。</FieldDescription> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="source-branch">分支</FieldLabel>
          <Input id="source-branch" value={branch} onChange={(event) => setBranch(event.target.value)} />
          <FieldDescription>可选；留空时由服务端使用默认分支。</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="source-scan-root">扫描根目录</FieldLabel>
          <Input id="source-scan-root" required value={scanRoot} onChange={(event) => setScanRoot(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="source-exclude-prefixes">排除前缀</FieldLabel>
          <Textarea id="source-exclude-prefixes" value={excludePrefixes} onChange={(event) => setExcludePrefixes(event.target.value)} />
          <FieldDescription>每行一个相对路径前缀。</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="source-token">访问 Token</FieldLabel>
          <Input autoComplete="new-password" id="source-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} />
          <FieldDescription>
            {isEditing ? "留空将保留现有 Token。" : "可选，用于访问私有 GitHub 仓库。"}{" "}
            <a href="https://github.com/settings/personal-access-tokens/new" rel="noreferrer" target="_blank">前往 GitHub 创建 Token</a>，并授予目标仓库 Contents 只读权限。
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="source-schedule">同步调度</FieldLabel>
          <Select value={schedule} onValueChange={setSchedule}>
            <SelectTrigger aria-label="同步调度" id="source-schedule"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="manual">手动</SelectItem>
                <SelectItem value="hourly">每小时</SelectItem>
                <SelectItem value="daily">每日</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field orientation="horizontal">
          <Checkbox checked={autoPublish} id="source-auto-publish" onCheckedChange={(checked) => setAutoPublish(checked === true)} />
          <div className="grid gap-1.5 leading-none">
            <FieldLabel htmlFor="source-auto-publish">自动发布发现的版本</FieldLabel>
            <FieldDescription>同步成功后自动将新发现版本设为当前版本。</FieldDescription>
          </div>
        </Field>
        <Field className="flex-wrap justify-end" orientation="horizontal">
          <Button disabled={pending} onClick={onCancel} type="button" variant="outline">取消</Button>
          <Button disabled={pending || !repository || !spaceId} type="submit" variant="primary">
            {pending ? "保存中..." : isEditing ? "保存来源" : "创建来源"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
