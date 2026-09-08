import type { MenuItemConstructorOptions } from 'electron';

export type WindowsApplicationMenuActions = {
  development: boolean;
  navigate(route: string): void;
  openLogs(): void;
  showAbout(): void;
  quit(): void;
};

export function createWindowsApplicationMenuTemplate(
  actions: WindowsApplicationMenuActions
): MenuItemConstructorOptions[] {
  const developerItems: MenuItemConstructorOptions[] = actions.development
    ? [
        { label: '强制重新加载', role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' },
        { label: '开发者工具', role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
        { type: 'separator' }
      ]
    : [];

  return [
    {
      label: '文件',
      submenu: [
        {
          label: '新建任务',
          accelerator: 'CmdOrCtrl+N',
          click: () => actions.navigate('#/')
        },
        {
          label: '任务中心',
          click: () => actions.navigate('#/tasks')
        },
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => actions.navigate('#/settings')
        },
        { type: 'separator' },
        { label: '关闭窗口', role: 'close', accelerator: 'CmdOrCtrl+W' },
        {
          label: '退出 Clawee',
          accelerator: 'CmdOrCtrl+Q',
          click: actions.quit
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '删除', role: 'delete' },
        { type: 'separator' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载界面', role: 'reload', accelerator: 'CmdOrCtrl+R' },
        ...developerItems,
        { label: '实际大小', role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { label: '放大', role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
        { label: '缩小', role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { type: 'separator' },
        { label: '进入全屏', role: 'togglefullscreen', accelerator: 'F11' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        {
          label: '最大化/还原',
          click: (_menuItem, browserWindow) => {
            if (browserWindow === undefined) return;
            if (browserWindow.isMaximized()) {
              browserWindow.unmaximize();
            } else {
              browserWindow.maximize();
            }
          }
        },
        { type: 'separator' },
        { label: '关闭窗口', role: 'close' }
      ]
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        { label: '打开日志目录', click: actions.openLogs },
        { type: 'separator' },
        { label: '关于 Clawee', click: actions.showAbout }
      ]
    }
  ];
}
