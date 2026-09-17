import type { SkillMarketViewProps } from './SkillMarketView.js';
import { SkillMarketView } from './SkillMarketView.js';
import {
  EnterpriseSkillHubView,
  type EnterpriseSkillHubViewProps
} from './EnterpriseSkillHubView-2026-07-30.js';
import {
  ChevronDown,
  Plus,
  Search,
  Upload,
  WandSparkles
} from 'lucide-react';
import { useState } from 'react';
import './skill-market.css';

export type PluginSource = 'public' | 'enterprise';

export type PluginsPageProps = SkillMarketViewProps & {
  source?: PluginSource;
  onSourceChange(source: PluginSource): void;
  enterprise: EnterpriseSkillHubViewProps;
};

export default function PluginsPage(props: PluginsPageProps) {
  const source = props.source ?? 'enterprise';
  const [marketQuery, setMarketQuery] = useState('');
  const [enterpriseQuery, setEnterpriseQuery] = useState('');
  const [enterpriseAddMenuOpen, setEnterpriseAddMenuOpen] = useState(false);
  return (
    <section className="plugins-page" aria-label="插件">
      <header className="plugins-source-header">
        <div className="plugins-source-tabs" role="tablist" aria-label="Skill 来源">
          <button
            aria-controls="plugins-source-enterprise"
            aria-selected={source === 'enterprise'}
            id="plugins-source-enterprise-tab"
            onClick={() => props.onSourceChange('enterprise')}
            role="tab"
            tabIndex={source === 'enterprise' ? 0 : -1}
            type="button"
          >
            企业Skills
          </button>
          <button
            aria-controls="plugins-source-public"
            aria-selected={source === 'public'}
            id="plugins-source-public-tab"
            onClick={() => props.onSourceChange('public')}
            role="tab"
            tabIndex={source === 'public' ? 0 : -1}
            type="button"
          >
            Skill市场
          </button>
        </div>
        <div className="plugins-source-actions">
          {source === 'public' ? (
            <label className="skill-market-search">
              <Search size={17} aria-hidden="true" />
              <input
                aria-label="搜索 Skill"
                onChange={(event) => setMarketQuery(event.target.value)}
                placeholder="搜索技能"
                type="search"
                value={marketQuery}
              />
            </label>
          ) : (
            <>
              <label className="skill-market-search">
                <Search size={17} aria-hidden="true" />
                <input
                  aria-label="搜索企业 Skill"
                  onChange={(event) => setEnterpriseQuery(event.target.value)}
                  placeholder="搜索技能"
                  type="search"
                  value={enterpriseQuery}
                />
              </label>
              <div className="skill-market-add">
                <button
                  aria-expanded={enterpriseAddMenuOpen}
                  aria-haspopup="menu"
                  className="skill-market-add__trigger"
                  onClick={() => setEnterpriseAddMenuOpen(open => !open)}
                  type="button"
                >
                  <Plus size={15} />
                  <span>添加技能</span>
                  <ChevronDown size={13} />
                </button>
                {enterpriseAddMenuOpen ? (
                  <div className="skill-market-add__menu" role="menu">
                    <button
                      disabled={props.enterprise.onCreateSkill === undefined}
                      onClick={() => {
                        setEnterpriseAddMenuOpen(false);
                        props.enterprise.onCreateSkill?.();
                      }}
                      role="menuitem"
                    >
                      <WandSparkles size={16} />
                      <span>
                        <strong>创建技能</strong>
                        <small>通过对话生成新的技能</small>
                      </span>
                    </button>
                    {props.enterprise.onUploadSkill ? (
                      <button
                        onClick={() => {
                          setEnterpriseAddMenuOpen(false);
                          props.enterprise.onUploadSkill?.();
                        }}
                        role="menuitem"
                      >
                        <Upload size={16} />
                        <span>
                          <strong>上传技能</strong>
                          <small>选择包含 SKILL.md 的文件夹</small>
                        </span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </header>
      <div
        aria-labelledby={`plugins-source-${source}-tab`}
        className="plugins-source-content"
        id={`plugins-source-${source}`}
        role="tabpanel"
      >
        {source === 'public' ? (
          <SkillMarketView
            connected={props.connected}
            currentProjectId={props.currentProjectId}
            installRecords={props.installRecords}
            loadError={props.loadError}
            loading={props.loading}
            onSearchChange={setMarketQuery}
            operation={props.operation}
            projects={props.projects}
            search={marketQuery}
            skills={props.skills}
            useError={props.useError}
            onInstall={props.onInstall}
            onUpdate={props.onUpdate}
            onUse={props.onUse}
          />
        ) : (
          <EnterpriseSkillHubView
            {...props.enterprise}
            addMenuOpen={enterpriseAddMenuOpen}
            onAddMenuOpenChange={setEnterpriseAddMenuOpen}
            onSearchChange={setEnterpriseQuery}
            search={enterpriseQuery}
          />
        )}
      </div>
    </section>
  );
}
