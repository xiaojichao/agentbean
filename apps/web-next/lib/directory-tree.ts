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

// ---------------------------------------------------------------------------
// 切片4：树形选择器的纯状态逻辑。
// 设计：扁平 record 而非嵌套树——每个已加载目录的子项按路径索引，
// 展开/加载/错误态各自一张表。immutable 迁移（每次返回新 state），
// 组件用 useState 持有，所有分支可单测。
// ---------------------------------------------------------------------------

export interface DirectoryTreeEntry {
  name: string;
  isDir: boolean;
}

/** socket listDirectory 的 ack 形状（daemon 切片3 起含 truncated）。 */
export interface ListDirectoryAck {
  ok: boolean;
  entries?: DirectoryTreeEntry[];
  homePath?: string;
  error?: string;
  truncated?: boolean;
}

export interface DirectoryTreeState {
  /** 根锚点解析出的 daemon $HOME（首次成功响应写入）。 */
  homePath?: string;
  /** 路径 → 已加载子项（含文件，渲染时过滤）。 */
  children: Record<string, DirectoryTreeEntry[]>;
  /** 路径 → 展开中。 */
  expanded: Record<string, true>;
  /** 路径 → 响应被截断（仅前 1000 项）。 */
  truncated: Record<string, true>;
  /** 路径 → 请求进行中。 */
  loading: Record<string, true>;
  /** 路径 → 已翻译的中文错误（展示后允许重试）。 */
  errors: Record<string, string>;
}

export function initialDirectoryTreeState(): DirectoryTreeState {
  return { children: {}, expanded: {}, truncated: {}, loading: {}, errors: {} };
}

/** daemon 截断阈值（与 daemon-next MAX_DIRECTORY_ENTRIES 对齐；web 侧仅用于文案）。 */
export const DIRECTORY_ENTRIES_TRUNCATE_LIMIT = 1000;

/** state 键解析：根锚点（''/'~'）请求的结果/错误挂在 homePath 下，其余挂请求路径。
 *  所有迁移函数必须经此解析，保证写键/清键对称（否则 anchor 重试清不掉旧错误）。 */
function directoryStateKey(state: DirectoryTreeState, path: string): string {
  return isRootAnchor(path) ? (state.homePath ?? path) : path;
}

export function markDirectoryLoading(state: DirectoryTreeState, path: string): DirectoryTreeState {
  const loading = { ...state.loading, [path]: true as const };
  const errors = { ...state.errors };
  delete errors[directoryStateKey(state, path)]; // 重新发起即清掉旧错误
  return { ...state, loading, errors };
}

export function applyDirectoryListSuccess(
  state: DirectoryTreeState,
  path: string,
  ack: ListDirectoryAck,
): DirectoryTreeState {
  // 响应里的 homePath 是根锚点（''）请求的权威根；非锚点请求不带时沿用旧值。
  // 注意：键解析必须先用响应里的 homePath（首轮时 state.homePath 尚未写入）。
  const homePath = ack.homePath ?? state.homePath;
  const key = isRootAnchor(path) ? (ack.homePath ?? path) : path;
  const children = { ...state.children, [key]: ack.entries ?? [] };
  const truncated = { ...state.truncated };
  if (ack.truncated) {
    truncated[key] = true;
  } else {
    delete truncated[key];
  }
  const loading = { ...state.loading };
  delete loading[path];
  const errors = { ...state.errors };
  delete errors[key];
  return { ...state, homePath, children, truncated, loading, errors };
}

export function applyDirectoryListFailure(
  state: DirectoryTreeState,
  path: string,
  error?: string,
): DirectoryTreeState {
  const errors = { ...state.errors, [directoryStateKey(state, path)]: formatListDirectoryError(error) };
  const loading = { ...state.loading };
  delete loading[path];
  return { ...state, errors, loading };
}

export function toggleDirectoryExpanded(state: DirectoryTreeState, path: string): DirectoryTreeState {
  const expanded = { ...state.expanded };
  if (expanded[path]) {
    delete expanded[path];
  } else {
    expanded[path] = true;
  }
  return { ...state, expanded };
}

/** 展开节点时是否需要发 fs:list：未加载过且不在请求中。失败后可重试（errors 不拦截）。 */
export function needsDirectoryFetch(state: DirectoryTreeState, path: string): boolean {
  return state.children[path] === undefined && state.loading[path] === undefined;
}

export interface DirectoryTreeRow {
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  loading: boolean;
  error?: string;
  truncated: boolean;
}

/** 把扁平 state 拍平成渲染用行序列：从 homePath 根 DFS，只列目录，只深入已展开节点。 */
export function visibleDirectoryRows(state: DirectoryTreeState): DirectoryTreeRow[] {
  const root = state.homePath;
  if (!root) return [];
  const rows: DirectoryTreeRow[] = [];
  const walk = (parentPath: string, depth: number) => {
    for (const entry of state.children[parentPath] ?? []) {
      if (!entry.isDir) continue; // 选目录场景只展示目录
      const path = joinDirectoryPath(parentPath, entry.name);
      rows.push({
        path,
        name: entry.name,
        depth,
        expanded: state.expanded[path] === true,
        loading: state.loading[path] === true,
        error: state.errors[path],
        truncated: state.truncated[path] === true,
      });
      if (state.expanded[path] === true) {
        walk(path, depth + 1);
      }
    }
  };
  walk(root, 0);
  return rows;
}

export interface BreadcrumbSegment {
  label: string;
  path: string;
}

/** 绝对路径 → 累计面包屑段（'/'、'/Users'、'/Users/shaw' …）。空路径返回空。 */
export function breadcrumbSegments(path: string): BreadcrumbSegment[] {
  if (!path) return [];
  if (path === '/') return [{ label: '/', path: '/' }];
  const segments: BreadcrumbSegment[] = [{ label: '/', path: '/' }];
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = `${current}/${part}`;
    segments.push({ label: part, path: current });
  }
  return segments;
}
