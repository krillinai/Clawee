import type { EnterpriseSessionResponse } from '@clawee/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Activity,
  Blocks,
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  FolderCog,
  FolderMinus,
  FolderPlus,
  FolderOpen,
  GripVertical,
  HardDrive,
  LibraryBig,
  Link2,
  LayoutDashboard,
  LoaderCircle,
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Settings2,
  SquarePen,
  Trash2,
  UserRound,
  type LucideIcon
} from 'lucide-react';
import type { ActiveView } from '../../app/app-state.js';
import { CLAWEE_APP_VERSION } from '../../app-version.js';
import { ConfirmDialog } from '../../components/dialogs/ConfirmDialog.js';
import type { ColorMode } from '../../styles/color-mode.js';
import type {
  ClaweeConversation,
  ClaweeProject
} from '../projects/project-model.js';
import { createSidebarRecentItems } from './sidebar-recent-model.js';
import type { SidebarTaskSummary } from './sidebar-task-model.js';

const SIDEBAR_ACTION_MENU_WIDTH = 154;
const SIDEBAR_ACTION_MENU_MAX_HEIGHT = 140;
const SIDEBAR_ACTION_MENU_VIEWPORT_MARGIN = 8;
const SIDEBAR_ACTION_MENU_GAP = 4;
const PROJECT_CONVERSATION_PREVIEW_LIMIT = 5;
const PROJECT_DRAG_DATA_TYPE = 'application/x-clawee-project-id';

export function ClaweeSidebar(props: {
  projects: ClaweeProject[];
  conversations: ClaweeConversation[];
  tasks: SidebarTaskSummary[];
  runningConversationIds?: ReadonlySet<string>;
  currentProjectId?: string;
  selectedConversationId?: string;
  activeView: ActiveView;
  collapsed?: boolean;
  autoCollapsed?: boolean;
  colorMode?: ColorMode;
  enterpriseSession?: EnterpriseSessionResponse;
  activityAllowed?: boolean;
  onNewConversation(projectId?: string): void;
  onSelectProject(projectId: string): void;
  onSelectConversation(conversationId: string): void;
  onSelectTask(threadId: string): void;
  onOpenView(view: ActiveView): void;
  onOpenAccount(): void;
  onOpenSettings(): void;
  onToggleCollapsed(): void;
  onAddProject?(): void;
  onAddProjectDirectory?(): void | Promise<void>;
  onManageProjects?(): void;
  onEditProject?(projectId: string): void;
  onReplaceProjectDirectory?(projectId: string): void;
  onReorderProjects?(projectIds: string[]): void | Promise<void>;
  onArchiveProject?(projectId: string): void;
  onTogglePinnedConversation?(conversationId: string, pinned: boolean): void | Promise<void>;
  onArchiveConversation?(conversationId: string): void | Promise<void>;
  onRenameConversation?(conversationId: string, title: string): void | Promise<void>;
  onDeleteConversation?(conversationId: string): void | Promise<void>;
  onArchiveTask?(task: SidebarTaskSummary): void | Promise<void>;
  onRenameTask?(task: SidebarTaskSummary, title: string): void | Promise<void>;
  onDeleteTask?(task: SidebarTaskSummary): void | Promise<void>;
}) {
  const [projectAddMenuOpen, setProjectAddMenuOpen] = useState(false);
  const [projectMenuId, setProjectMenuId] = useState<string>();
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(props.currentProjectId === undefined ? [] : [props.currentProjectId])
  );
  const [fullyExpandedProjectIds, setFullyExpandedProjectIds] = useState<Set<string>>(
    () => new Set()
  );
  const [recentConversationsCollapsed, setRecentConversationsCollapsed] = useState(false);
  const [archivingConversationId, setArchivingConversationId] = useState<string>();
  const [conversationPendingArchive, setConversationPendingArchive] = useState<{
    id: string;
    title: string;
  }>();
  const [conversationMenuId, setConversationMenuId] = useState<string>();
  const [conversationMenuPosition, setConversationMenuPosition] = useState<{ top: number; left: number }>();
  const [conversationRename, setConversationRename] = useState<{
    id: string;
    originalTitle: string;
    title: string;
  }>();
  const [conversationPendingDeletion, setConversationPendingDeletion] = useState<{
    id: string;
    title: string;
  }>();
  const [conversationActionBusyId, setConversationActionBusyId] = useState<string>();
  const [taskMenuId, setTaskMenuId] = useState<string>();
  const [taskMenuPosition, setTaskMenuPosition] = useState<{ top: number; left: number }>();
  const [taskRename, setTaskRename] = useState<{ id: string; originalTitle: string; title: string }>();
  const [taskPendingDeletion, setTaskPendingDeletion] = useState<SidebarTaskSummary>();
  const [taskActionBusyId, setTaskActionBusyId] = useState<string>();
  const [projectPendingRemoval, setProjectPendingRemoval] = useState<{
    id: string;
    name: string;
  }>();
  const [draggedProjectId, setDraggedProjectId] = useState<string>();
  const [projectDropTarget, setProjectDropTarget] = useState<{
    id: string;
    position: 'before' | 'after';
  }>();
  const projectAddMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const conversationMenuRef = useRef<HTMLDivElement>(null);
  const conversationMenuPortalRef = useRef<HTMLDivElement>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const taskMenuPortalRef = useRef<HTMLDivElement>(null);
  const renameCanceledRef = useRef(false);
  const collapsed = props.collapsed === true;
  const autoCollapsed = props.autoCollapsed === true;
  const logoColor = props.colorMode === 'light' ? 'black' : 'white';
  const account = props.enterpriseSession?.account;
  const accountTitle = account?.name ?? '企业账户';
  const fullLogoSrc = props.colorMode === 'light' ? '/logo-v2-black.svg' : '/logo-v2-white.svg';
  const globalActions: Array<{
    label: string;
    icon: LucideIcon;
    view?: ActiveView;
    onClick(): void;
  }> = [
    { label: '新建会话', icon: SquarePen, onClick: () => props.onNewConversation() },
    { label: '数据看板', icon: LayoutDashboard, view: 'dashboard', onClick: () => props.onOpenView('dashboard') },
    ...(props.activityAllowed === true
      ? [{ label: 'Agent动态', icon: Activity, view: 'activity' as const, onClick: () => props.onOpenView('activity') }]
      : []),
    { label: '企业Skill中心', icon: Blocks, view: 'plugins', onClick: () => props.onOpenView('plugins') },
    { label: '连接器', icon: Link2, view: 'connections', onClick: () => props.onOpenView('connections') },
    { label: '企业知识库', icon: LibraryBig, view: 'knowledge', onClick: () => props.onOpenView('knowledge') },
    { label: '共享网盘', icon: HardDrive, view: 'drive', onClick: () => props.onOpenView('drive') },
    { label: '定时任务', icon: Clock3, view: 'schedules', onClick: () => props.onOpenView('schedules') }
  ];
  const selectedTaskThread = props.tasks.some(
    task => task.threadId === props.selectedConversationId
  );
  const recentItems = createSidebarRecentItems(props.conversations, props.tasks);
  const hasMultipleProjectAddActions =
    props.onAddProject !== undefined && props.onAddProjectDirectory !== undefined;
  const projectsReorderable =
    props.onReorderProjects !== undefined && props.projects.length > 1;
  const conversationsByProject = useMemo(() => {
    const grouped = new Map<string, ClaweeConversation[]>();
    for (const conversation of props.conversations) {
      const projectConversations = grouped.get(conversation.projectId);
      if (projectConversations === undefined) {
        grouped.set(conversation.projectId, [conversation]);
      } else {
        projectConversations.push(conversation);
      }
    }
    return grouped;
  }, [props.conversations]);
  const conversationShortcutCount =
    Number(props.onTogglePinnedConversation !== undefined)
    + Number(props.onArchiveConversation !== undefined);
  const conversationShortcutClassName = conversationShortcutCount === 2
    ? ' has-two-conversation-shortcuts'
    : conversationShortcutCount === 1
      ? ' has-one-conversation-shortcut'
      : '';

  useEffect(() => {
    const currentProjectId = props.currentProjectId;
    if (currentProjectId === undefined) return;
    setExpandedProjectIds(current => addExpandedProject(current, currentProjectId));
  }, [props.currentProjectId]);

  useEffect(() => {
    const selectedProjectId = props.conversations.find(
      conversation => conversation.id === props.selectedConversationId
    )?.projectId;
    if (selectedProjectId === undefined) return;
    setExpandedProjectIds(current => addExpandedProject(current, selectedProjectId));
  }, [props.conversations, props.selectedConversationId]);

  useEffect(() => {
    if (!projectAddMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!projectAddMenuRef.current?.contains(event.target as Node)) {
        setProjectAddMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectAddMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [projectAddMenuOpen]);

  useEffect(() => {
    if (projectMenuId === undefined) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) {
        setProjectMenuId(undefined);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectMenuId(undefined);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [projectMenuId]);

  useEffect(() => {
    if (conversationMenuId === undefined) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !conversationMenuRef.current?.contains(target)
        && !conversationMenuPortalRef.current?.contains(target)
      ) {
        setConversationMenuId(undefined);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConversationMenuId(undefined);
    };
    const closeOnViewportChange = () => setConversationMenuId(undefined);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [conversationMenuId]);

  useEffect(() => {
    if (taskMenuId === undefined) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !taskMenuRef.current?.contains(target)
        && !taskMenuPortalRef.current?.contains(target)
      ) setTaskMenuId(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTaskMenuId(undefined);
    };
    const closeOnViewportChange = () => setTaskMenuId(undefined);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [taskMenuId]);

  function startProjectDrag(
    event: ReactDragEvent<HTMLButtonElement>,
    projectId: string
  ) {
    if (!projectsReorderable) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROJECT_DRAG_DATA_TYPE, projectId);
    setDraggedProjectId(projectId);
    setProjectDropTarget(undefined);
  }

  function updateProjectDropTarget(
    event: ReactDragEvent<HTMLDivElement>,
    targetProjectId: string
  ) {
    if (draggedProjectId === undefined || draggedProjectId === targetProjectId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    setProjectDropTarget({
      id: targetProjectId,
      position: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    });
  }

  function dropProject(
    event: ReactDragEvent<HTMLDivElement>,
    targetProjectId: string
  ) {
    if (draggedProjectId === undefined || draggedProjectId === targetProjectId) return;
    event.preventDefault();
    event.stopPropagation();
    const position = projectDropTarget?.id === targetProjectId
      ? projectDropTarget.position
      : 'after';
    const projectIds = moveProjectId(
      props.projects.map(project => project.id),
      draggedProjectId,
      targetProjectId,
      position
    );
    setDraggedProjectId(undefined);
    setProjectDropTarget(undefined);
    void props.onReorderProjects?.(projectIds);
  }

  function finishProjectDrag() {
    setDraggedProjectId(undefined);
    setProjectDropTarget(undefined);
  }

  return (
    <nav className="clawee-sidebar" aria-label="Clawee" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="sidebar-brand">
        {collapsed ? (
          <button
            className="sidebar-brand-button sidebar-expand-button"
            type="button"
            aria-disabled={autoCollapsed || undefined}
            aria-label={autoCollapsed ? '侧栏已自动收起' : '展开侧栏'}
            title={autoCollapsed ? '窗口较窄，关闭文件工作区后可展开侧栏' : '展开侧栏'}
            onClick={autoCollapsed ? undefined : props.onToggleCollapsed}
          >
            <span className="sidebar-logo-mark">
              <img
                className="sidebar-logo-image"
                src={`/krillinai-mark-${logoColor}.png`}
                alt="KrillinAI"
              />
            </span>
            <PanelLeftOpen className="sidebar-expand-icon" size={19} strokeWidth={1.85} aria-hidden="true" />
          </button>
        ) : (
          <>
            <div className="sidebar-logo-lockup">
              <span className="sidebar-brand-lockup-logo">
                <img
                  className="sidebar-logo-image"
                  src={`/krillinai-wordmark-${logoColor}.png`}
                  alt="KrillinAI"
                />
              </span>
              <span className="sidebar-brand-product">
                <span className="sidebar-logo-word">Clawee</span>
                <span className="sidebar-brand-version">
                  v{CLAWEE_APP_VERSION}
                </span>
              </span>
            </div>
            <div className="sidebar-brand-actions">
              <button
                className="sidebar-collapse-button sidebar-search-button"
                type="button"
                aria-label="搜索"
                title="搜索"
                aria-current={props.activeView === 'search' ? 'page' : undefined}
                onClick={() => props.onOpenView('search')}
              >
                <Search size={18} strokeWidth={1.85} aria-hidden="true" />
              </button>
              <button
                className="sidebar-collapse-button"
                type="button"
                aria-label="收起侧栏"
                title="收起侧栏"
                onClick={props.onToggleCollapsed}
              >
                <PanelLeftClose size={18} strokeWidth={1.85} aria-hidden="true" />
              </button>
            </div>
          </>
        )}
      </div>

      <div className="sidebar-primary">
        {globalActions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.label}
              type="button"
              className="sidebar-row"
              title={collapsed ? action.label : undefined}
              aria-current={action.view && props.activeView === action.view ? 'page' : undefined}
              onClick={action.onClick}
            >
              <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
              <span>{action.label}</span>
            </button>
          );
        })}
      </div>

      {collapsed ? null : (
        <div className="sidebar-content">
          <section className="sidebar-section" aria-labelledby="clawee-projects-heading">
            <div className="sidebar-section-heading">
              <h2 id="clawee-projects-heading">项目</h2>
              {props.onAddProject || props.onAddProjectDirectory || props.onManageProjects ? (
                <div className="sidebar-section-actions">
                  {props.onAddProject || props.onAddProjectDirectory ? (
                    <div className="sidebar-project-menu-shell" ref={projectAddMenuRef}>
                      <button
                        type="button"
                        className="sidebar-section-action"
                        aria-label={hasMultipleProjectAddActions ? '添加项目' : '创建项目'}
                        title={hasMultipleProjectAddActions ? '添加项目' : '创建项目'}
                        aria-haspopup={hasMultipleProjectAddActions ? 'menu' : undefined}
                        aria-expanded={hasMultipleProjectAddActions ? projectAddMenuOpen : undefined}
                        onClick={() => {
                          if (!hasMultipleProjectAddActions) {
                            if (props.onAddProject !== undefined) {
                              props.onAddProject();
                            } else {
                              void props.onAddProjectDirectory?.();
                            }
                            return;
                          }
                          setProjectAddMenuOpen(current => !current);
                        }}
                      >
                        <FolderPlus size={16} strokeWidth={1.9} aria-hidden="true" />
                      </button>
                      {projectAddMenuOpen ? (
                        <div
                          className="sidebar-project-menu sidebar-project-add-menu"
                          role="menu"
                          aria-label="添加项目"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setProjectAddMenuOpen(false);
                              props.onAddProject?.();
                            }}
                          >
                            <FolderPlus size={15} strokeWidth={1.9} aria-hidden="true" />
                            <span>新建项目</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setProjectAddMenuOpen(false);
                              void props.onAddProjectDirectory?.();
                            }}
                          >
                            <FolderOpen size={15} strokeWidth={1.9} aria-hidden="true" />
                            <span>使用现有文件夹</span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {props.onManageProjects ? (
                    <button
                      type="button"
                      className="sidebar-section-action"
                      aria-label="管理项目"
                      title="管理项目"
                      onClick={props.onManageProjects}
                    >
                      <Settings2 size={16} strokeWidth={1.9} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="sidebar-project-tree" aria-label="项目">
              {props.projects.map((project) => {
                const isCurrentProject =
                  !selectedTaskThread && project.id === props.currentProjectId;
                const ProjectIcon = isCurrentProject ? FolderOpen : Folder;
                const projectConversations = conversationsByProject.get(project.id) ?? [];
                const isExpanded = expandedProjectIds.has(project.id);
                const showsAllConversations = fullyExpandedProjectIds.has(project.id);
                const visibleProjectConversations = showsAllConversations
                  ? projectConversations
                  : projectConversations.slice(0, PROJECT_CONVERSATION_PREVIEW_LIMIT);

                return (
                  <div
                    className="sidebar-project-node"
                    key={project.id}
                    data-project-dragging={draggedProjectId === project.id ? 'true' : undefined}
                    data-project-drop-position={
                      projectDropTarget?.id === project.id
                        ? projectDropTarget.position
                        : undefined
                    }
                    onDragOver={event => updateProjectDropTarget(event, project.id)}
                    onDrop={event => dropProject(event, project.id)}
                  >
                    <div
                      className="sidebar-project-row-shell"
                      data-reorderable={projectsReorderable ? 'true' : undefined}
                    >
                      {projectsReorderable ? (
                        <button
                          type="button"
                          className="sidebar-project-drag-handle"
                          aria-label={`拖动 ${project.name} 排序`}
                          title="拖动排序"
                          draggable
                          onDragStart={event => startProjectDrag(event, project.id)}
                          onDragEnd={finishProjectDrag}
                        >
                          <GripVertical size={15} strokeWidth={1.9} aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="sidebar-row project-row"
                        data-current-project={isCurrentProject ? 'true' : undefined}
                        aria-expanded={projectConversations.length > 0 ? isExpanded : undefined}
                        onClick={() => {
                          if (projectConversations.length > 0) {
                            setExpandedProjectIds(current => (
                              toggleExpandedProject(current, project.id)
                            ));
                            if (isExpanded) {
                              setFullyExpandedProjectIds(current => (
                                removeExpandedProject(current, project.id)
                              ));
                            }
                          }
                          props.onSelectProject(project.id);
                        }}
                      >
                        <ProjectIcon className="project-icon" size={18} strokeWidth={1.85} aria-hidden="true" />
                        <span>{project.name}</span>
                      </button>
                      <div
                        className="sidebar-project-actions"
                        ref={projectMenuId === project.id ? projectMenuRef : undefined}
                      >
                        <button
                          type="button"
                          className="sidebar-project-new-conversation"
                          aria-label={`在 ${project.name} 中新建会话`}
                          title="新建会话"
                          onClick={() => props.onNewConversation(project.id)}
                        >
                          <SquarePen size={16} strokeWidth={1.9} aria-hidden="true" />
                        </button>
                        {props.onArchiveProject ? (
                          <div className="sidebar-project-menu-shell">
                            <button
                              type="button"
                              className="sidebar-project-menu-trigger"
                              aria-label={`项目操作 ${project.name}`}
                              title="项目操作"
                              aria-haspopup="menu"
                              aria-expanded={projectMenuId === project.id}
                              onClick={() => setProjectMenuId(
                                current => current === project.id ? undefined : project.id
                              )}
                            >
                              <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
                            </button>
                            {projectMenuId === project.id ? (
                              <div
                                className="sidebar-project-menu"
                                role="menu"
                                aria-label={`${project.name} 项目操作`}
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    setProjectMenuId(undefined);
                                    props.onEditProject?.(project.id);
                                  }}
                                >
                                  <Settings2 size={15} strokeWidth={1.9} aria-hidden="true" />
                                  <span>编辑项目</span>
                                </button>
                                {props.onReplaceProjectDirectory ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setProjectMenuId(undefined);
                                      props.onReplaceProjectDirectory?.(project.id);
                                    }}
                                  >
                                    <FolderCog size={15} strokeWidth={1.9} aria-hidden="true" />
                                    <span>更换目录</span>
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  role="menuitem"
                                  aria-label={`移除项目 ${project.name}`}
                                  title="仅从项目列表移除，不会删除本机文件"
                                  onClick={() => {
                                    setProjectMenuId(undefined);
                                    setProjectPendingRemoval({ id: project.id, name: project.name });
                                  }}
                                >
                                  <FolderMinus size={15} strokeWidth={1.9} aria-hidden="true" />
                                  <span>移除项目</span>
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {isExpanded && projectConversations.length > 0 ? (
                      <div
                        className="sidebar-project-conversations"
                        role="group"
                        aria-label={`${project.name} 会话`}
                      >
                        {visibleProjectConversations.map(conversation => {
                          const isRunning =
                            props.runningConversationIds?.has(conversation.id) === true;
                          const isSelected =
                            props.activeView === 'conversation'
                            && conversation.id === props.selectedConversationId;
                          return (
                            <div
                              className="sidebar-project-conversation-row-shell"
                              key={conversation.id}
                            >
                              <a
                                href={`#/thread/${encodeURIComponent(conversation.id)}`}
                                className="conversation-row sidebar-project-conversation-row"
                                aria-label={`${conversation.title}${isRunning ? ' 正在运行' : ''}`}
                                aria-current={isSelected ? 'page' : undefined}
                                onClick={event => {
                                  event.preventDefault();
                                  props.onSelectConversation(conversation.id);
                                }}
                              >
                                <strong>{conversation.title}</strong>
                                {isRunning ? (
                                  <LoaderCircle
                                    className="conversation-run-spinner"
                                    size={13}
                                    strokeWidth={2}
                                    aria-hidden="true"
                                  />
                                ) : null}
                              </a>
                            </div>
                          );
                        })}
                        {projectConversations.length > PROJECT_CONVERSATION_PREVIEW_LIMIT ? (
                          <button
                            type="button"
                            className="sidebar-project-conversations-toggle"
                            aria-expanded={showsAllConversations}
                            onClick={() => setFullyExpandedProjectIds(current => (
                              toggleExpandedProject(current, project.id)
                            ))}
                          >
                            {showsAllConversations ? '收起显示' : '展开显示'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="sidebar-section sidebar-recent-section" aria-label="侧栏会话历史">
            <div className="sidebar-recent-heading">
              <h2 id="clawee-recent-heading">最近会话</h2>
              <button
                type="button"
                className="sidebar-recent-toggle"
                aria-label={recentConversationsCollapsed ? '展开最近会话' : '收起最近会话'}
                aria-expanded={!recentConversationsCollapsed}
                aria-controls="clawee-recent-content"
                onClick={() => setRecentConversationsCollapsed(current => !current)}
              >
                {recentConversationsCollapsed ? (
                  <ChevronRight size={15} strokeWidth={1.9} aria-hidden="true" />
                ) : (
                  <ChevronDown size={15} strokeWidth={1.9} aria-hidden="true" />
                )}
              </button>
            </div>
            <div
              id="clawee-recent-content"
              className="sidebar-recent-content"
              hidden={recentConversationsCollapsed}
            >
              {recentItems.length === 0 ? (
                <p className="sidebar-empty">暂无最近会话</p>
              ) : (
                <div className="sidebar-recent-list" aria-label="最近会话">
                  {recentItems.map(item => {
                  if (item.kind === 'conversation') {
                    const { conversation } = item;
                    const isRunning =
                      props.runningConversationIds?.has(conversation.id) === true;
                    return (
                      <div
                        key={item.key}
                        className={`sidebar-conversation-row-shell sidebar-recent-row-shell${conversationShortcutClassName}`}
                        data-kind="conversation"
                        role="group"
                        aria-label={conversation.title}
                      >
                        {conversationRename?.id === conversation.id ? (
                          <input
                            className="sidebar-conversation-rename-input"
                            aria-label={`重命名 ${conversationRename.originalTitle}`}
                            autoFocus
                            value={conversationRename.title}
                            onChange={event => setConversationRename(current => (
                              current === undefined ? current : { ...current, title: event.target.value }
                            ))}
                            onKeyDown={event => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                event.currentTarget.blur();
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                renameCanceledRef.current = true;
                                setConversationRename(undefined);
                              }
                            }}
                            onBlur={() => {
                              if (renameCanceledRef.current) {
                                renameCanceledRef.current = false;
                                return;
                              }
                              const nextTitle = conversationRename.title.trim();
                              if (
                                nextTitle.length === 0
                                || nextTitle === conversationRename.originalTitle
                              ) {
                                setConversationRename(undefined);
                                return;
                              }
                              setConversationActionBusyId(conversation.id);
                              void Promise.resolve(
                                props.onRenameConversation?.(conversation.id, nextTitle)
                              ).finally(() => {
                                setConversationActionBusyId(undefined);
                                setConversationRename(undefined);
                              });
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="conversation-row sidebar-recent-row"
                            data-kind="conversation"
                            aria-current={
                              props.activeView === 'conversation'
                              && conversation.id === props.selectedConversationId
                                ? 'page'
                                : undefined
                            }
                            onClick={() => props.onSelectConversation(conversation.id)}
                          >
                            <strong>{conversation.title}</strong>
                            <span className="conversation-row-meta">
                              {isRunning ? (
                                <LoaderCircle
                                  className="conversation-run-spinner"
                                  size={13}
                                  strokeWidth={2}
                                  aria-label="正在运行"
                                />
                              ) : null}
                              <span className="conversation-updated-label">
                                {item.updatedLabel}
                              </span>
                            </span>
                          </button>
                        )}
                        {conversationRename?.id === conversation.id ? null : (
                          <div
                            className={`sidebar-conversation-actions${conversationShortcutClassName}`}
                            ref={conversationMenuId === conversation.id ? conversationMenuRef : undefined}
                          >
                            {props.onTogglePinnedConversation ? (
                              <button
                                type="button"
                                className="sidebar-conversation-action"
                                aria-label={conversation.pinnedAt ? '取消置顶' : '置顶'}
                                title={conversation.pinnedAt ? '取消置顶' : '置顶'}
                                disabled={
                                  isRunning
                                  || archivingConversationId === conversation.id
                                  || conversationActionBusyId === conversation.id
                                }
                                onClick={() => {
                                  setConversationActionBusyId(conversation.id);
                                  void Promise.resolve(
                                    props.onTogglePinnedConversation?.(
                                      conversation.id,
                                      conversation.pinnedAt === undefined
                                      || conversation.pinnedAt === null
                                    )
                                  ).finally(() => setConversationActionBusyId(undefined));
                                }}
                              >
                                {conversationActionBusyId === conversation.id ? (
                                  <LoaderCircle
                                    className="conversation-run-spinner"
                                    size={15}
                                    strokeWidth={2}
                                    aria-hidden="true"
                                  />
                                ) : conversation.pinnedAt ? (
                                  <PinOff size={16} strokeWidth={1.9} aria-hidden="true" />
                                ) : (
                                  <Pin size={16} strokeWidth={1.9} aria-hidden="true" />
                                )}
                              </button>
                            ) : null}
                            {props.onArchiveConversation ? (
                              <button
                                type="button"
                                className="sidebar-conversation-action"
                                aria-label="归档"
                                title="归档"
                                disabled={
                                  isRunning
                                  || archivingConversationId === conversation.id
                                  || conversationActionBusyId === conversation.id
                                }
                                onClick={() => {
                                  setConversationPendingArchive({
                                    id: conversation.id,
                                    title: conversation.title
                                  });
                                }}
                              >
                                <Archive size={16} strokeWidth={1.9} aria-hidden="true" />
                              </button>
                            ) : null}
                            <div className="sidebar-conversation-menu-shell">
                              <button
                                type="button"
                                className="sidebar-conversation-action"
                                aria-label="更多"
                                title="更多"
                                aria-haspopup="menu"
                                aria-expanded={conversationMenuId === conversation.id}
                                disabled={
                                  archivingConversationId === conversation.id
                                  || conversationActionBusyId === conversation.id
                                }
                                onClick={event => {
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  setConversationMenuPosition(positionSidebarActionMenu(rect));
                                  setConversationMenuId(current => (
                                    current === conversation.id ? undefined : conversation.id
                                  ));
                                }}
                              >
                                <MoreHorizontal size={16} strokeWidth={1.9} aria-hidden="true" />
                              </button>
                              {conversationMenuId === conversation.id
                                && conversationMenuPosition !== undefined
                                ? createPortal((
                                  <div
                                    className="sidebar-conversation-menu sidebar-conversation-menu--portal"
                                    role="menu"
                                    aria-label={`${conversation.title} 操作`}
                                    ref={conversationMenuPortalRef}
                                    style={conversationMenuPosition}
                                  >
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setConversationMenuId(undefined);
                                        setConversationRename({
                                          id: conversation.id,
                                          originalTitle: conversation.title,
                                          title: conversation.title
                                        });
                                      }}
                                    >
                                      <Pencil size={15} strokeWidth={1.9} aria-hidden="true" />
                                      <span>重命名</span>
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="is-destructive"
                                      disabled={isRunning}
                                      onClick={() => {
                                        setConversationMenuId(undefined);
                                        setConversationPendingDeletion({
                                          id: conversation.id,
                                          title: conversation.title
                                        });
                                      }}
                                    >
                                      <Trash2 size={15} strokeWidth={1.9} aria-hidden="true" />
                                      <span>删除会话</span>
                                    </button>
                                  </div>
                                ), document.body)
                                : null}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }

                  const { task } = item;
                  const isRunning = task.status === 'running' || task.status === 'queued';
                  const isRenaming = taskRename?.id === task.id;
                  return (
                    <div
                      className="sidebar-conversation-row-shell sidebar-recent-row-shell"
                      data-kind="task"
                      key={item.key}
                      role="group"
                      aria-label={task.name}
                    >
                      {isRenaming ? (
                        <input
                          className="sidebar-conversation-rename-input"
                          aria-label={`重命名 ${task.name}`}
                          autoFocus
                          value={taskRename.title}
                          onChange={event => setTaskRename(current => current === undefined
                            ? current
                            : { ...current, title: event.target.value })}
                          onKeyDown={event => {
                            if (event.key === 'Escape') {
                              renameCanceledRef.current = true;
                              setTaskRename(undefined);
                            } else if (event.key === 'Enter') {
                              event.currentTarget.blur();
                            }
                          }}
                          onBlur={() => {
                            if (renameCanceledRef.current) {
                              renameCanceledRef.current = false;
                              return;
                            }
                            const title = taskRename.title.trim();
                            if (title.length === 0 || title === taskRename.originalTitle) {
                              setTaskRename(undefined);
                              return;
                            }
                            setTaskActionBusyId(task.id);
                            void Promise.resolve(props.onRenameTask?.(task, title)).finally(() => {
                              setTaskActionBusyId(undefined);
                              setTaskRename(undefined);
                            });
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="conversation-row sidebar-recent-row"
                          data-kind="task"
                          aria-current={
                            props.activeView === 'conversation'
                            && task.threadId === props.selectedConversationId
                              ? 'page'
                              : undefined
                          }
                          onClick={() => props.onSelectTask(item.threadId)}
                        >
                          <strong>{task.name}</strong>
                          <span className="conversation-row-meta">
                            {isRunning ? (
                              <LoaderCircle
                                className="conversation-run-spinner"
                                size={13}
                                strokeWidth={2}
                                aria-label="正在运行"
                              />
                            ) : null}
                            <span className="conversation-updated-label">
                              {item.updatedLabel}
                            </span>
                          </span>
                        </button>
                      )}
                      {isRenaming ? null : (
                        <div
                          className="sidebar-conversation-actions"
                          ref={taskMenuId === task.id ? taskMenuRef : undefined}
                        >
                          <div className="sidebar-conversation-menu-shell">
                            <button
                              type="button"
                              className="sidebar-conversation-action"
                              aria-label={`更多 ${task.name}`}
                              title="更多"
                              aria-haspopup="menu"
                              aria-expanded={taskMenuId === task.id}
                              onClick={event => {
                                const rect = event.currentTarget.getBoundingClientRect();
                                setTaskMenuPosition(positionSidebarActionMenu(rect));
                                setTaskMenuId(current => current === task.id ? undefined : task.id);
                              }}
                            >
                              <MoreHorizontal size={16} strokeWidth={1.9} aria-hidden="true" />
                            </button>
                            {taskMenuId === task.id && taskMenuPosition !== undefined
                              ? createPortal((
                                <div
                                  className="sidebar-conversation-menu sidebar-conversation-menu--portal"
                                  role="menu"
                                  aria-label={`${task.name} 操作`}
                                  ref={taskMenuPortalRef}
                                  style={taskMenuPosition}
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setTaskMenuId(undefined);
                                      setTaskRename({
                                        id: task.id,
                                        originalTitle: task.name,
                                        title: task.name
                                      });
                                    }}
                                  >
                                    <Pencil size={15} strokeWidth={1.9} aria-hidden="true" />
                                    <span>重命名</span>
                                  </button>
                                  {props.onArchiveTask ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      disabled={isRunning || taskActionBusyId === task.id}
                                      onClick={() => {
                                        setTaskMenuId(undefined);
                                        setTaskActionBusyId(task.id);
                                        void Promise.resolve(props.onArchiveTask?.(task)).finally(
                                          () => setTaskActionBusyId(undefined)
                                        );
                                      }}
                                    >
                                      <Archive size={15} strokeWidth={1.9} aria-hidden="true" />
                                      <span>归档</span>
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="is-destructive"
                                    disabled={isRunning}
                                    onClick={() => {
                                      setTaskMenuId(undefined);
                                      setTaskPendingDeletion(task);
                                    }}
                                  >
                                    <Trash2 size={15} strokeWidth={1.9} aria-hidden="true" />
                                    <span>删除任务</span>
                                  </button>
                                </div>
                              ), document.body)
                              : null}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      <div className="sidebar-bottom">
        <button
          className="sidebar-account-button"
          type="button"
          aria-label={accountTitle}
          aria-current={props.activeView === 'account' ? 'page' : undefined}
          title={collapsed ? accountTitle : undefined}
          onClick={props.onOpenAccount}
        >
          <span className="sidebar-account-avatar" aria-hidden="true">
            <UserRound size={16} strokeWidth={2} />
          </span>
          <span className="sidebar-account-copy">
            <strong>{accountTitle}</strong>
          </span>
        </button>
        <button
          className="sidebar-settings-button"
          type="button"
          aria-label="设置"
          aria-current={props.activeView === 'settings' ? 'page' : undefined}
          title="设置"
          onClick={props.onOpenSettings}
        >
          <Settings size={17} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <ConfirmDialog
        open={conversationPendingDeletion !== undefined}
        title="删除会话"
        description={conversationPendingDeletion === undefined
          ? '永久删除后无法恢复，但不会删除项目文件。'
          : `确认永久删除“${conversationPendingDeletion.title}”？会话及历史记录将无法恢复，但不会删除项目文件。`}
        confirmLabel="永久删除"
        destructive
        busy={conversationActionBusyId !== undefined}
        onCancel={() => setConversationPendingDeletion(undefined)}
        onConfirm={() => {
          if (conversationPendingDeletion === undefined || conversationActionBusyId !== undefined) return;
          const { id } = conversationPendingDeletion;
          setConversationActionBusyId(id);
          void Promise.resolve(props.onDeleteConversation?.(id)).finally(() => {
            setConversationActionBusyId(undefined);
            setConversationPendingDeletion(undefined);
          });
        }}
      />
      <ConfirmDialog
        open={conversationPendingArchive !== undefined}
        title="归档会话"
        description={conversationPendingArchive === undefined
          ? '归档后会从项目列表隐藏，但不会删除项目文件或 Codex 历史。'
          : `确认归档“${conversationPendingArchive.title}”？归档后会从项目列表隐藏，但不会删除项目文件或 Codex 历史。`}
        confirmLabel="归档"
        busy={archivingConversationId !== undefined}
        onCancel={() => setConversationPendingArchive(undefined)}
        onConfirm={() => {
          if (conversationPendingArchive === undefined || archivingConversationId !== undefined) return;
          const { id } = conversationPendingArchive;
          setArchivingConversationId(id);
          void Promise.resolve(props.onArchiveConversation?.(id)).finally(() => {
            setArchivingConversationId(undefined);
            setConversationPendingArchive(undefined);
          });
        }}
      />
      <ConfirmDialog
        open={projectPendingRemoval !== undefined}
        title="移除项目"
        description={projectPendingRemoval === undefined
          ? '项目目录和文件不会被删除。'
          : `确认从 Clawee 中移除“${projectPendingRemoval.name}”？项目目录和文件不会被删除。`}
        confirmLabel="移除项目"
        destructive
        onCancel={() => setProjectPendingRemoval(undefined)}
        onConfirm={() => {
          if (projectPendingRemoval === undefined) return;
          props.onArchiveProject?.(projectPendingRemoval.id);
          setProjectPendingRemoval(undefined);
        }}
      />
      <ConfirmDialog
        open={taskPendingDeletion !== undefined}
        title="删除任务"
        description={taskPendingDeletion === undefined
          ? '删除后无法恢复。'
          : `确认删除“${taskPendingDeletion.name}”？删除后无法恢复。`}
        confirmLabel="删除任务"
        destructive
        busy={taskActionBusyId !== undefined}
        onCancel={() => setTaskPendingDeletion(undefined)}
        onConfirm={() => {
          if (taskPendingDeletion === undefined || taskActionBusyId !== undefined) return;
          const task = taskPendingDeletion;
          setTaskActionBusyId(task.id);
          void Promise.resolve(props.onDeleteTask?.(task)).finally(() => {
            setTaskActionBusyId(undefined);
            setTaskPendingDeletion(undefined);
          });
        }}
      />
    </nav>
  );
}

function addExpandedProject(current: Set<string>, projectId: string): Set<string> {
  if (current.has(projectId)) return current;
  const next = new Set(current);
  next.add(projectId);
  return next;
}

function removeExpandedProject(current: Set<string>, projectId: string): Set<string> {
  if (!current.has(projectId)) return current;
  const next = new Set(current);
  next.delete(projectId);
  return next;
}

function toggleExpandedProject(current: Set<string>, projectId: string): Set<string> {
  const next = new Set(current);
  if (next.has(projectId)) {
    next.delete(projectId);
  } else {
    next.add(projectId);
  }
  return next;
}

function moveProjectId(
  projectIds: string[],
  draggedProjectId: string,
  targetProjectId: string,
  position: 'before' | 'after'
): string[] {
  const remaining = projectIds.filter(projectId => projectId !== draggedProjectId);
  const targetIndex = remaining.indexOf(targetProjectId);
  if (targetIndex < 0) return projectIds;
  remaining.splice(targetIndex + (position === 'after' ? 1 : 0), 0, draggedProjectId);
  return remaining;
}

function positionSidebarActionMenu(trigger: DOMRect): { top: number; left: number } {
  return {
    top: Math.max(
      SIDEBAR_ACTION_MENU_VIEWPORT_MARGIN,
      Math.min(
        window.innerHeight - SIDEBAR_ACTION_MENU_MAX_HEIGHT - SIDEBAR_ACTION_MENU_VIEWPORT_MARGIN,
        trigger.bottom + SIDEBAR_ACTION_MENU_GAP
      )
    ),
    left: Math.max(
      SIDEBAR_ACTION_MENU_VIEWPORT_MARGIN,
      Math.min(
        window.innerWidth - SIDEBAR_ACTION_MENU_WIDTH - SIDEBAR_ACTION_MENU_VIEWPORT_MARGIN,
        trigger.right - SIDEBAR_ACTION_MENU_WIDTH
      )
    )
  };
}
