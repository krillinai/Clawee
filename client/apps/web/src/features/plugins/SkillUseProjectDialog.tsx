import { Check, Folder, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useModalBehavior } from '../../components/dialogs/use-modal-behavior.js';
import './skill-market.css';

export type SkillMarketProjectOption = {
  id: string;
  name: string;
  cwd: string;
};

export function SkillUseProjectDialog({
  skillTitle,
  projects,
  currentProjectId,
  onClose,
  onConfirm,
}: {
  skillTitle: string;
  projects: readonly SkillMarketProjectOption[];
  currentProjectId: string;
  onClose(): void;
  onConfirm(projectId: string): void;
}) {
  const initialProjectId =
    projects.find((project) => project.id === currentProjectId)?.id
    ?? projects[0]?.id
    ?? '';
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  useModalBehavior(dialogRef, { open: true, onClose, initialFocusRef: closeRef });


  return (
    <div
      className="skill-market-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-modal="true"
        aria-labelledby="skill-market-use-project-title"
        className="skill-market-use-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="skill-market-use-dialog__header">
          <div>
            <span>{skillTitle}</span>
            <h2 id="skill-market-use-project-title">选择使用项目</h2>
          </div>
          <button
            aria-label="关闭项目选择"
            className="skill-market-icon-button"
            onClick={onClose}
            ref={closeRef}
            title="关闭"
            type="button"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="skill-market-use-project-list" role="radiogroup" aria-label="使用项目">
          {projects.map((project) => {
            const selected = project.id === selectedProjectId;
            return (
              <button
                aria-checked={selected}
                className={selected ? 'is-selected' : ''}
                key={project.id}
                onClick={() => setSelectedProjectId(project.id)}
                role="radio"
                type="button"
              >
                <Folder size={17} aria-hidden="true" />
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.cwd}</small>
                </span>
                <Check className="skill-market-use-project-list__check" size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>

        <footer className="skill-market-use-dialog__footer">
          <button
            className="skill-market-use-dialog__cancel"
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="skill-market-action-button skill-market-action-button--use"
            disabled={selectedProject === undefined}
            onClick={() => {
              if (selectedProject !== undefined) onConfirm(selectedProject.id);
            }}
            title={
              selectedProject === undefined
                ? undefined
                : `在 ${selectedProject.name} 中使用`
            }
            type="button"
          >
            <span>使用所选项目</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
