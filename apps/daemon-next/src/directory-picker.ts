import { execFile } from 'node:child_process';

type DirectoryPickerCommand = { command: string; args: string[] };

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

function isDirectoryPickerCancel(err: unknown): boolean {
  const e = err as { code?: number; message?: string; stderr?: string };
  const message = `${e?.message ?? ''}\n${e?.stderr ?? ''}`;
  return e?.code === 1 || /cancel|canceled|cancelled|User canceled|No file selected/i.test(message);
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
      if (isDirectoryPickerCancel(err)) return null;
      throw err;
    }
  }
  throw new Error(lastError ? `directory picker command not available: ${errorMessage(lastError)}` : 'directory picker command not available');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
