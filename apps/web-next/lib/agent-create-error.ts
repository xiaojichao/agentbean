// 创建自定义 Agent 失败错误码 → 面向用户的中文提示。
//
// 后端 createCustomAgent（usecases.ts）回传错误码；这里把码映射成可操作提示，
// 避免把 FORBIDDEN_REMOTE_DEVICE_SETTINGS 等晦涩码原样泄漏到 UI。

export function formatCreateAgentError(error?: string): string {
  switch (error) {
    case 'FORBIDDEN_REMOTE_DEVICE_SETTINGS':
      // 普通账号登录无 deviceId → 服务端把本机误判为远程 → 创建被拒。
      // 引导用户在目标设备本机完成设备登录（建立本机设备身份）。
      return '自定义 Agent 的运行时（命令/项目目录/环境变量）需在该设备本机配置。当前浏览器未关联到本设备（账号密码登录无设备身份）。请在该设备本机完成设备登录后再试。';
    case 'DEVICE_OFFLINE':
      return '目标设备不在线，请确认设备已连接后再试';
    case 'FORBIDDEN':
      return '没有权限在该设备上创建 Agent（需为设备拥有者或系统管理员）';
    case 'NOT_FOUND':
      return '未找到目标设备，请刷新设备列表后重试';
    default:
      break;
  }
  if (!error) return '创建失败';
  // 未识别错误码原样展示，供排查（与 directory-picker-error 一致：不误吞）。
  return error;
}
