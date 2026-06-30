// 目录浏览失败错误码 → 面向用户的中文提示。
//
// daemon（directory-picker.ts）抛出带 code 的 DirectoryPickerError，socket 回传 code；
// 这里把 code 映射成可操作提示，并把任何未识别的原始 shell 报错兜底成通用提示，
// 绝不把 osascript/powershell 的 "Command failed: ..." + stderr 原样泄漏到 UI。

const DIRECTORY_PICKER_TIMEOUT_MESSAGE =
  '目录选择超时，请确认目标设备已登录桌面会话，并且 Daemon 是从该桌面用户会话启动的';

const DIRECTORY_PICKER_GENERIC_MESSAGE = '无法打开目录浏览窗口，请直接在输入框手动填写项目目录';

export function directoryPickerErrorMessage(error?: string): string {
  switch (error) {
    case 'CANCELLED':
      return '';
    case 'DEVICE_OFFLINE':
      return '目标设备不在线，无法在该设备上选择项目目录';
    case 'DAEMON_UPGRADE_REQUIRED':
      return '该设备的 Daemon 版本过旧，请升级后再使用目录浏览';
    case 'DIRECTORY_PICKER_TIMEOUT':
    case 'timeout':
      // 'timeout' 来自前端 emitWithTimeout 的兜底；与正式码共用同一条友好文案。
      return DIRECTORY_PICKER_TIMEOUT_MESSAGE;
    case 'DIRECTORY_PICKER_UNAVAILABLE':
      return '无法在该设备上打开目录浏览窗口（Daemon 可能未在桌面会话中运行）。请直接在输入框手动填写项目目录，或在桌面终端重启 Daemon 后重试。';
    case 'DEVICE_NOT_IN_TEAM':
      return '该设备不属于当前团队';
    default:
      break;
  }
  if (!error) return DIRECTORY_PICKER_GENERIC_MESSAGE;
  // 未识别错误：若是原始 shell 报错（多行 / 含解释器名或 "Command failed:"），不原样泄漏。
  if (/Command failed:|osascript|powershell|zenity|kdialog|execution error|\n/.test(error)) {
    return DIRECTORY_PICKER_GENERIC_MESSAGE;
  }
  return error;
}
