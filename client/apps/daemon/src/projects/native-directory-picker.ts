import type {
  ProjectDirectorySelectionPurpose
} from '@clawee/protocol';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const CANCELLED = '__CLAWEE_DIRECTORY_PICKER_CANCELLED__';

export type NativeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type NativeCommandRunner = (
  command: string,
  args: readonly string[]
) => Promise<NativeCommandResult>;

export type ProjectDirectoryPicker = {
  selectDirectory(
    purpose: ProjectDirectorySelectionPurpose
  ): Promise<string | null>;
};

export type ProjectDirectoryPickerErrorCode =
  | 'PROJECT_DIRECTORY_PICKER_UNAVAILABLE'
  | 'PROJECT_DIRECTORY_PICKER_BUSY'
  | 'PROJECT_DIRECTORY_PICKER_FAILED';

export class ProjectDirectoryPickerError extends Error {
  constructor(
    readonly code: ProjectDirectoryPickerErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function createNativeProjectDirectoryPicker(input: {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  runCommand?: NativeCommandRunner;
} = {}): ProjectDirectoryPicker {
  const platform = input.platform ?? process.platform;
  const homeDirectory = input.homeDirectory ?? homedir();
  const runCommand = input.runCommand ?? runNativeCommand;
  let selecting = false;
  let lastDirectory = homeDirectory;

  return {
    async selectDirectory(purpose) {
      if (selecting) {
        throw new ProjectDirectoryPickerError(
          'PROJECT_DIRECTORY_PICKER_BUSY',
          '另一个文件夹选择窗口仍在打开'
        );
      }
      selecting = true;
      try {
        const selected = await selectNativeDirectory({
          platform,
          purpose,
          initialDirectory: lastDirectory,
          runCommand
        });
        if (selected !== null) lastDirectory = selected;
        return selected;
      } finally {
        selecting = false;
      }
    }
  };
}

async function selectNativeDirectory(input: {
  platform: NodeJS.Platform;
  purpose: ProjectDirectorySelectionPurpose;
  initialDirectory: string;
  runCommand: NativeCommandRunner;
}): Promise<string | null> {
  if (input.platform === 'darwin') {
    return selectMacOSDirectory(input);
  }
  if (input.platform === 'win32') {
    return selectWindowsDirectory(input);
  }
  if (input.platform === 'linux') {
    return selectLinuxDirectory(input);
  }
  throw new ProjectDirectoryPickerError(
    'PROJECT_DIRECTORY_PICKER_UNAVAILABLE',
    '当前系统不支持原生文件夹选择窗口'
  );
}

async function selectMacOSDirectory(input: {
  purpose: ProjectDirectorySelectionPurpose;
  initialDirectory: string;
  runCommand: NativeCommandRunner;
}): Promise<string | null> {
  const copy = pickerCopy(input.purpose);
  const script = [
    "ObjC.import('AppKit');",
    '(function () {',
    '  const application = $.NSApplication.sharedApplication;',
    '  application.setActivationPolicy($.NSApplicationActivationPolicyAccessory);',
    '  application.activateIgnoringOtherApps(true);',
    '  const panel = $.NSOpenPanel.openPanel;',
    `  panel.setTitle($(${JSON.stringify(copy.title)}));`,
    `  panel.setMessage($(${JSON.stringify(copy.description)}));`,
    `  panel.setPrompt($(${JSON.stringify(copy.confirmLabel)}));`,
    '  panel.setCanChooseFiles(false);',
    '  panel.setCanChooseDirectories(true);',
    '  panel.setAllowsMultipleSelection(false);',
    '  panel.setCanCreateDirectories(true);',
    '  panel.setResolvesAliases(true);',
    `  panel.setDirectoryURL($.NSURL.fileURLWithPath($(${JSON.stringify(input.initialDirectory)})));`,
    '  const response = panel.runModal;',
    `  if (Number(response) !== 1) return ${JSON.stringify(CANCELLED)};`,
    '  return ObjC.unwrap(panel.URL.path);',
    '})();'
  ].join('\n');
  const result = await runPickerCommand(
    input.runCommand,
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', script]
  );
  return parsePickerResult(result, {
    cancellationExitCodes: []
  });
}

async function selectWindowsDirectory(input: {
  purpose: ProjectDirectorySelectionPurpose;
  initialDirectory: string;
  runCommand: NativeCommandRunner;
}): Promise<string | null> {
  const copy = pickerCopy(input.purpose);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${escapePowerShell(copy.description)}'`,
    '$dialog.UseDescriptionForTitle = $true',
    `$dialog.InitialDirectory = '${escapePowerShell(input.initialDirectory)}'`,
    `if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {`,
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '} else {',
    `  [Console]::Out.Write('${CANCELLED}')`,
    '}'
  ].join('\n');
  const result = await runPickerCommand(
    input.runCommand,
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', script]
  );
  return parsePickerResult(result, {
    cancellationExitCodes: []
  });
}

async function selectLinuxDirectory(input: {
  purpose: ProjectDirectorySelectionPurpose;
  initialDirectory: string;
  runCommand: NativeCommandRunner;
}): Promise<string | null> {
  const copy = pickerCopy(input.purpose);
  try {
    const zenity = await input.runCommand('zenity', [
      '--file-selection',
      '--directory',
      `--title=${copy.title}`,
      `--filename=${ensureTrailingSlash(input.initialDirectory)}`
    ]);
    return parsePickerResult(zenity, { cancellationExitCodes: [1] });
  } catch (error) {
    if (!isCommandUnavailable(error)) throw pickerFailure(error);
  }

  try {
    const kdialog = await input.runCommand('kdialog', [
      '--getexistingdirectory',
      input.initialDirectory,
      '--title',
      copy.title
    ]);
    return parsePickerResult(kdialog, { cancellationExitCodes: [1] });
  } catch (error) {
    if (!isCommandUnavailable(error)) throw pickerFailure(error);
  }

  throw new ProjectDirectoryPickerError(
    'PROJECT_DIRECTORY_PICKER_UNAVAILABLE',
    '未找到可用的系统文件夹选择器'
  );
}

async function runPickerCommand(
  runCommand: NativeCommandRunner,
  command: string,
  args: readonly string[]
): Promise<NativeCommandResult> {
  try {
    return await runCommand(command, args);
  } catch (error) {
    if (isCommandUnavailable(error)) {
      throw new ProjectDirectoryPickerError(
        'PROJECT_DIRECTORY_PICKER_UNAVAILABLE',
        '系统文件夹选择器不可用'
      );
    }
    throw pickerFailure(error);
  }
}

function parsePickerResult(
  result: NativeCommandResult,
  options: { cancellationExitCodes: readonly number[] }
): string | null {
  const stdout = stripLineEndings(result.stdout);
  if (stdout === CANCELLED || options.cancellationExitCodes.includes(result.exitCode)) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw new ProjectDirectoryPickerError(
      'PROJECT_DIRECTORY_PICKER_FAILED',
      stripLineEndings(result.stderr) || '系统文件夹选择器执行失败'
    );
  }
  if (stdout.length === 0) {
    throw new ProjectDirectoryPickerError(
      'PROJECT_DIRECTORY_PICKER_FAILED',
      '系统文件夹选择器没有返回有效路径'
    );
  }
  return stdout;
}

function pickerCopy(purpose: ProjectDirectorySelectionPurpose): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  if (purpose === 'create') {
    return {
      title: '选择源文件夹',
      description: '选择一个 Codex 可以读取和编辑的本地文件夹',
      confirmLabel: '打开'
    };
  }
  if (purpose === 'replace') {
    return {
      title: '更换项目文件夹',
      description: '选择项目后续使用的本地文件夹',
      confirmLabel: '打开'
    };
  }
  return {
    title: '选择项目文件夹',
    description: '选择一个要添加到 Clawee 的本地文件夹',
    confirmLabel: '打开'
  };
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

function ensureTrailingSlash(path: string): string {
  return /[\\/]$/.test(path) ? path : `${path}/`;
}

function stripLineEndings(value: string): string {
  return value.replace(/[\r\n]+$/, '');
}

function isCommandUnavailable(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function pickerFailure(error: unknown): ProjectDirectoryPickerError {
  if (error instanceof ProjectDirectoryPickerError) return error;
  return new ProjectDirectoryPickerError(
    'PROJECT_DIRECTORY_PICKER_FAILED',
    error instanceof Error ? error.message : '系统文件夹选择器执行失败'
  );
}

function runNativeCommand(
  command: string,
  args: readonly string[]
): Promise<NativeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', exitCode => {
      resolve({
        exitCode: exitCode ?? -1,
        stdout,
        stderr
      });
    });
  });
}
