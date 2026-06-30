import { execFile } from 'node:child_process';

type DirectoryPickerCommand = { command: string; args: string[] };

/**
 * 带稳定 `code` 的 picker 错误。daemon 会优先把 `code` 回传给前端，
 * 前端据此渲染可操作的友好提示，而不是把原始 shell 报错泄漏给用户。
 */
export class DirectoryPickerError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'DirectoryPickerError';
    this.code = code;
  }
}

function execFileAsync(command: string, args: string[], options: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(err as unknown as Error & { code?: string | number });
        return;
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

export function nativeDirectoryPickerCommands(platform: NodeJS.Platform = process.platform): DirectoryPickerCommand[] {
  if (platform === 'darwin') {
    return [{
      command: 'osascript',
      args: [
        '-e',
        'POSIX path of (choose folder with prompt "选择项目目录" default location (path to home folder))',
      ],
    }];
  }
  if (platform === 'win32') {
    return [{
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-STA',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }',
      ],
    }];
  }
  return [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=选择项目目录'] },
    { command: 'kdialog', args: ['--getexistingdirectory', '.', '选择项目目录'] },
  ];
}

function isMissingCommandError(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ENOENT';
}

function pickerErrorText(err: unknown): string {
  const e = err as { message?: string; stderr?: string };
  return `${e?.message ?? ''}\n${e?.stderr ?? ''}`;
}

// macOS：daemon 未在桌面(Aqua)会话中运行时，osascript 拿不到窗口服务器连接，
// 报 com.apple.view-bridge: Connection interrupted（AppleScript 仍会附带 -128）。
// 这种"对话框根本没弹出"的失败必须与"用户主动取消"区分开，单独归类为不可用。
function isDirectoryPickerUnavailable(err: unknown): boolean {
  return /view-bridge|Connection interrupted|endpointForReply/i.test(pickerErrorText(err));
}

function isDirectoryPickerCancel(err: unknown): boolean {
  // -128 = userCanceledErr；同时覆盖英文与本地化文案（如中文"取消"）。
  return /cancel|canceled|cancelled|取消|No file selected/i.test(pickerErrorText(err));
}

export async function selectNativeDirectory(commands = nativeDirectoryPickerCommands()): Promise<string | null> {
  let lastError: unknown = null;
  for (const cmd of commands) {
    try {
      const { stdout } = await execFileAsync(cmd.command, cmd.args, { timeout: 120_000 });
      const selected = stdout.trim();
      if (selected) return selected;
      return null;
    } catch (err) {
      if (isMissingCommandError(err)) {
        lastError = err;
        continue;
      }
      // 必须先判 unavailable：view-bridge 错误里也带"取消/-128"字样，否则会被误判成用户取消。
      if (isDirectoryPickerUnavailable(err)) {
        throw new DirectoryPickerError(
          'directory picker unavailable: no desktop session (view-bridge connection interrupted)',
          'DIRECTORY_PICKER_UNAVAILABLE',
        );
      }
      if (isDirectoryPickerCancel(err)) return null;
      throw err;
    }
  }
  throw new DirectoryPickerError(
    lastError ? `directory picker command not available: ${errorMessage(lastError)}` : 'directory picker command not available',
    'DIRECTORY_PICKER_UNAVAILABLE',
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
