// fs:list 目录浏览的 web 端纯逻辑（切片1）。
// 错误码翻译 + 路径拼接 + 根锚点判定，供树形 UI 组件（切片4）消费。
// 沿用 agent-create-error 的模式：把后端码映射成可操作中文提示，未知码不误吞。

/** server/daemon 回传的 fs:list 错误码 → 面向用户的中文提示。 */
export function formatListDirectoryError(error?: string): string {
  switch (error) {
    case 'DEVICE_OFFLINE':
      return '目标设备不在线，请确认设备已连接后再试';
    case 'DIRECTORY_LIST_TIMEOUT':
      return '读取目录超时，请稍后重试';
    case 'PATH_NOT_FOUND':
      return '该路径不存在或不可访问';
    case 'PERMISSION_DENIED':
    case 'FORBIDDEN':
      // fs:list 授权拒绝（assertCanManageDevice）实际到达的是全仓惯例码 FORBIDDEN；
      // PERMISSION_DENIED 为 memory 面在用的旧码，此处保留作防御性兼容。
      return '没有权限浏览该设备目录（需为设备拥有者或系统管理员）';
    case 'RATE_LIMITED':
      return '操作过于频繁，请稍后再试';
    default:
      break;
  }
  if (!error) return '读取目录失败';
  // 未识别错误码原样展示，供排查（与 formatCreateAgentError 一致：不误吞）。
  return error;
}

/** 首次请求 $HOME 用的根锚点判定（空串或 ~）。daemon 据此返回 $HOME 下一层。 */
export function isRootAnchor(path: string): boolean {
  return path === '' || path === '~';
}

/** 父目录 + 子项名 → 子项绝对路径。空子项名时原样返回父路径（锚点用）。 */
export function joinDirectoryPath(parent: string, child: string): string {
  if (!child) return parent;
  if (parent === '/') return `/${child}`;
  return `${parent}/${child}`;
}
