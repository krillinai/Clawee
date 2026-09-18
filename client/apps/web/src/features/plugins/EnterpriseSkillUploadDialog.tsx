import { ENTERPRISE_SKILL_PACKAGE_MAX_BYTES, type EnterpriseSkillResponse, type EnterpriseSkillSpaceListResponse } from '@clawee/protocol';
import { FileArchive, LoaderCircle, RefreshCw, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function EnterpriseSkillUploadDialog(props: {
  target?: EnterpriseSkillResponse;
  onLoadSpaces(): Promise<EnterpriseSkillSpaceListResponse>;
  onUpload(input: { skillId?: string; spaceId: string; version: string; changelog: string; file: File }): Promise<void>;
  onClose(): void;
}) {
  const [spaces, setSpaces] = useState<EnterpriseSkillSpaceListResponse['spaces']>([]);
  const [spaceId, setSpaceId] = useState(props.target?.spaceId ?? '');
  const [version, setVersion] = useState(props.target ? '' : '1.0.0');
  const [changelog, setChangelog] = useState('');
  const [file, setFile] = useState<File>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    mountedRef.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        propsRef.current.onClose();
      }
      if (event.key !== 'Tab') return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
      const first = elements?.[0];
      const last = elements?.[elements.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      mountedRef.current = false;
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void propsRef.current.onLoadSpaces().then(response => {
      if (cancelled) return;
      const writable = response.spaces.filter(space => space.actions.includes('write'));
      setSpaces(writable);
      setSpaceId(current => {
        const target = propsRef.current.target;
        if (target) return writable.some(space => space.spaceId === target.spaceId) ? target.spaceId ?? '' : '';
        return writable.some(space => space.spaceId === current) ? current : writable[0]?.spaceId ?? '';
      });
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '技能空间加载失败');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function submit() {
    if (busyRef.current || loading || !file || !spaces.some(space => space.spaceId === spaceId)) return;
    if (!/\.zip$/i.test(file.name) || file.size === 0) {
      setError('请选择非空的 ZIP 技能包');
      return;
    }
    if (file.size > ENTERPRISE_SKILL_PACKAGE_MAX_BYTES) {
      setError('技能包不能超过 50 MB');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version.trim())) {
      setError('版本号须为 1-64 位字母、数字、点、下划线或短横线，并以字母或数字开头');
      return;
    }
    if (Array.from(changelog).length > 2000) {
      setError('更新说明不能超过 2000 字');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await propsRef.current.onUpload({ ...(propsRef.current.target ? { skillId: propsRef.current.target.skillId } : {}), spaceId, version: version.trim(), changelog, file });
      if (mountedRef.current) propsRef.current.onClose();
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : '企业 Skill 上传失败');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  return createPortal(
    <div className="skill-market-modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !busyRef.current) props.onClose();
    }}>
      <section className="skill-market-use-dialog enterprise-skill-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="enterprise-skill-upload-title" tabIndex={-1} ref={dialogRef}>
        <header className="skill-market-use-dialog__header">
          <h2 id="enterprise-skill-upload-title">{props.target ? '替换上传 Skill' : '上传企业 Skill'}</h2>
          <button type="button" className="skill-market-icon-button" title="关闭" aria-label="关闭企业 Skill 上传" disabled={busy} onClick={props.onClose}><X size={17} /></button>
        </header>
        <form className="enterprise-skill-upload-form" noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div className="enterprise-skill-upload-fields">
          {props.target ? <div className="enterprise-skill-upload-target"><span>当前 Skill</span><strong title={props.target.name}>{props.target.name}</strong></div> : null}
          <div className="enterprise-skill-upload-space">
          <label>技能空间
            <select value={spaceId} disabled={loading || busy || spaces.length === 0 || props.target !== undefined} onChange={event => setSpaceId(event.target.value)}>
              {props.target && !spaceId && spaces.length > 0 ? <option value="">当前技能空间不可写</option> : null}
              {spaces.length === 0 ? <option value="">{loading ? '加载中' : '没有可写的技能空间'}</option> : spaces.map(space => <option key={space.spaceId} value={space.spaceId}>{space.name}</option>)}
            </select>
          </label>
          <button type="button" className="skill-market-icon-button" title="刷新空间" aria-label="刷新空间" disabled={loading || busy} onClick={() => setReloadKey(key => key + 1)}><RefreshCw size={16} className={loading ? 'enterprise-skill-spinner' : undefined} /></button>
          </div>
          <label>版本号<input value={version} maxLength={64} required disabled={busy} onChange={event => setVersion(event.target.value)} /></label>
          <label className="enterprise-skill-upload-package">
            <span>ZIP 技能包</span>
            <span className="enterprise-skill-upload-file"><FileArchive size={24} aria-hidden="true" /><span><strong>{file?.name ?? '选择 ZIP 技能包'}</strong><small>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : 'SKILL.md · 最大 50 MB'}</small></span><Upload size={17} aria-hidden="true" /></span>
            <input aria-label="ZIP 技能包" type="file" accept=".zip,application/zip" required disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setError(undefined); }} />
          </label>
          <label>更新说明<textarea value={changelog} rows={3} disabled={busy} onChange={event => setChangelog(event.target.value)} /></label>
          {error ? <p className="skill-market-inline-error" role="alert">{error}</p> : null}
          </div>
          <footer className="skill-market-use-dialog__footer">
            <button type="button" className="skill-market-use-dialog__cancel" disabled={busy} onClick={props.onClose}>取消</button>
            <button type="submit" className="skill-market-action-button" disabled={loading || busy || !spaceId || !file || !version.trim()}>{busy ? <LoaderCircle size={15} className="enterprise-skill-spinner" /> : <Upload size={15} />}{busy ? '上传中' : props.target ? '替换上传' : '上传'}</button>
          </footer>
        </form>
      </section>
    </div>, document.body
  );
}
