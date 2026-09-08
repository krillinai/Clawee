import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Folder,
  FolderOpen,
  FolderPlus,
  X
} from 'lucide-react';

export function CreateProjectDialog(props: {
  open: boolean;
  error?: string;
  onClose(): void;
  onSelectSourceDirectory?(): Promise<string | null>;
  onCreate(
    name: string,
    sourceCwd?: string
  ): boolean | void | Promise<boolean | void>;
}) {
  const [name, setName] = useState('');
  const [sourceCwd, setSourceCwd] = useState<string>();
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setName('');
    setSourceCwd(undefined);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [props.open]);

  if (!props.open) return null;

  const createProject = async () => {
    const normalizedName = name.trim();
    if (normalizedName.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const created = sourceCwd === undefined
        ? await props.onCreate(normalizedName)
        : await props.onCreate(normalizedName, sourceCwd);
      if (created !== false) props.onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="composer-project-name-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !submitting) props.onClose();
      }}
    >
      <section
        className="composer-project-name-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="创建项目"
      >
        <header className="composer-project-name-header">
          <strong>创建项目</strong>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭创建项目"
            disabled={submitting || selectingDirectory}
            onClick={props.onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        {props.error ? <p className="inline-error" role="alert">{props.error}</p> : null}
        <label className="composer-project-name-field">
          <span className="app-visually-hidden">项目名称</span>
          <div>
            <Folder size={17} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              aria-label="项目名称"
              placeholder="项目名称"
              maxLength={80}
              value={name}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              onChange={event => setName(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Escape' && !submitting) {
                  event.preventDefault();
                  props.onClose();
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void createProject();
                }
              }}
            />
          </div>
        </label>
        {props.onSelectSourceDirectory === undefined ? null : (
          <div className="composer-project-source">
            <span>源文件夹</span>
            {sourceCwd === undefined ? (
              <button
                type="button"
                className="composer-project-source-empty"
                aria-label="添加源文件夹"
                disabled={submitting || selectingDirectory}
                onClick={() => {
                  setSelectingDirectory(true);
                  void props.onSelectSourceDirectory?.()
                    .then(path => {
                      if (path !== null) setSourceCwd(path);
                    })
                    .finally(() => setSelectingDirectory(false));
                }}
              >
                <FolderPlus size={19} aria-hidden="true" />
                <span>
                  {selectingDirectory
                    ? '正在选择文件夹'
                    : '添加 Codex 可读取和编辑的文件夹'}
                </span>
              </button>
            ) : (
              <div className="composer-project-source-selected">
                <button
                  type="button"
                  aria-label="更换源文件夹"
                  title={sourceCwd}
                  disabled={submitting || selectingDirectory}
                  onClick={() => {
                    setSelectingDirectory(true);
                    void props.onSelectSourceDirectory?.()
                      .then(path => {
                        if (path !== null) setSourceCwd(path);
                      })
                      .finally(() => setSelectingDirectory(false));
                  }}
                >
                  <FolderOpen size={19} aria-hidden="true" />
                  <span>
                    <strong>{directoryName(sourceCwd)}</strong>
                    <code>{sourceCwd}</code>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="移除源文件夹"
                  disabled={submitting || selectingDirectory}
                  onClick={() => setSourceCwd(undefined)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        )}
        <footer>
          <button
            type="button"
            className="button-secondary"
            disabled={submitting || selectingDirectory}
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={submitting || selectingDirectory || name.trim().length === 0}
            onClick={() => void createProject()}
          >
            {submitting ? '正在创建' : '创建项目'}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

function directoryName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || path;
}
