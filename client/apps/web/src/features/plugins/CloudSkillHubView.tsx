import type {
  EnterpriseCloudSkillListResponse,
  EnterpriseCloudSkillResponse
} from '@clawee/protocol';
import { AlertCircle, Info, LoaderCircle, Play, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  SkillUseProjectDialog,
  type SkillMarketProjectOption
} from './SkillUseProjectDialog.js';
import './skill-market.css';

export type CloudSkillHubViewProps = {
  data?: EnterpriseCloudSkillListResponse;
  loading: boolean;
  loadError?: string;
  search?: string;
  onSearchChange?(value: string): void;
  projects: readonly SkillMarketProjectOption[];
  currentProjectId: string;
  useError?: { skillId: string; error: string };
  onUse(skill: EnterpriseCloudSkillResponse, projectId: string): void;
};

export function CloudSkillHubView(props: CloudSkillHubViewProps) {
  const [activeSkill, setActiveSkill] = useState<EnterpriseCloudSkillResponse>();
  const [pendingUseSkill, setPendingUseSkill] = useState<EnterpriseCloudSkillResponse>();
  const query = props.search ?? '';
  const skills = props.data?.skills ?? [];
  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return skills;
    return skills.filter(skill => [skill.skillId, skill.name, skill.description ?? '', skill.version ?? '']
      .some(value => value.toLocaleLowerCase().includes(normalized)));
  }, [query, skills]);

  return (
    <section className="enterprise-skill-hub" aria-label="云 Skills">
      {props.loadError !== undefined ? <p className="enterprise-skill-error" role="alert"><AlertCircle size={17} aria-hidden="true" /><span>{props.loadError}</span></p> : null}
      {props.data ? <p className="enterprise-skill-banner" role="status">服务端 Agent：{props.data.agentName}（{props.data.agentEmail}）</p> : null}
      {props.loading && props.data === undefined ? <div className="enterprise-skill-empty" role="status"><LoaderCircle className="enterprise-skill-spinner" size={22} aria-hidden="true" /><span>正在加载云 Skill</span></div> : null}
      {!props.loading && props.data !== undefined && filteredSkills.length === 0 ? <div className="enterprise-skill-empty" role="status"><span>{skills.length === 0 ? '暂无可用云 Skill' : '没有符合当前搜索的 Skill'}</span></div> : null}
      {filteredSkills.length > 0 ? <div className="enterprise-skill-list">
        {filteredSkills.map(skill => <CloudSkillRow key={skill.skillId} skill={skill} useError={props.useError?.skillId === skill.skillId ? props.useError.error : undefined} onOpen={() => setActiveSkill(skill)} onUse={() => setPendingUseSkill(skill)} />)}
      </div> : null}

      {activeSkill ? <CloudSkillInfo skill={activeSkill} agentName={props.data?.agentName ?? ''} onClose={() => setActiveSkill(undefined)} /> : null}
      {pendingUseSkill ? <SkillUseProjectDialog
        currentProjectId={props.currentProjectId}
        onClose={() => setPendingUseSkill(undefined)}
        onConfirm={projectId => {
          const skill = pendingUseSkill;
          setPendingUseSkill(undefined);
          props.onUse(skill, projectId);
        }}
        projects={props.projects}
        skillTitle={pendingUseSkill.name}
      /> : null}
    </section>
  );
}

function CloudSkillRow(props: {
  skill: EnterpriseCloudSkillResponse;
  useError?: string;
  onOpen(): void;
  onUse(): void;
}) {
  return <article className="enterprise-skill-row skill-market-card cloud-skill-card" data-testid={`cloud-skill-${props.skill.skillId}`}>
    <button aria-label={`查看 ${props.skill.name} 详情`} className="enterprise-skill-row-open skill-market-card__open cloud-skill-card__open" onClick={props.onOpen} type="button">
      <div className="skill-market-card__body">
        <div className="skill-market-card__identity">
          <span className="skill-market-avatar skill-market-avatar--small cloud-skill-card__avatar" aria-hidden="true"><Info size={17} /></span>
          <span className="skill-market-card__identity-copy">
            <strong className="skill-market-card__title">{props.skill.name}</strong>
            <span className="skill-market-card__author">云 Skill</span>
          </span>
        </div>
        <span className="skill-market-card__tagline" title={props.skill.description || '暂无说明'}>
          {props.skill.description || '暂无说明'}
        </span>
        <span className="skill-market-card__tags">
          <span>{props.skill.version ? `v${props.skill.version}` : '已发布'}</span>
        </span>
      </div>
    </button>
    <div className="enterprise-skill-actions skill-market-card__action-row">
      <button className="enterprise-skill-action enterprise-skill-action--use skill-market-action-button skill-market-action-button--use" onClick={props.onUse} type="button"><Play size={14} aria-hidden="true" />使用</button>
    </div>
    {props.useError ? <p className="enterprise-skill-row-error">使用失败：{props.useError}</p> : null}
  </article>;
}

function CloudSkillInfo(props: { skill: EnterpriseCloudSkillResponse; agentName: string; onClose(): void }) {
  return <div className="skill-market-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose(); }}>
    <section aria-modal="true" aria-labelledby="cloud-skill-info-title" className="enterprise-skill-detail" role="dialog">
      <header><div><span>云 Skill</span><h2 id="cloud-skill-info-title">{props.skill.name}</h2></div><button aria-label="关闭 Skill 信息" className="enterprise-skill-icon-button" onClick={props.onClose} type="button"><X size={17} aria-hidden="true" /></button></header>
      <div className="enterprise-skill-detail-body"><section><h3>技能说明</h3><p>{props.skill.description || '暂无说明'}</p></section><dl><div><dt>服务端 Agent</dt><dd>{props.agentName}</dd></div><div><dt>版本</dt><dd>{props.skill.version || '已发布'}</dd></div><div><dt>更新时间</dt><dd>{props.skill.updatedAt ? new Date(props.skill.updatedAt).toLocaleString() : '-'}</dd></div></dl></div>
      <footer><span>云 Skill 仅支持信息展示和使用。</span><button className="enterprise-skill-action" onClick={props.onClose} type="button">关闭</button></footer>
    </section>
  </div>;
}

export default CloudSkillHubView;
