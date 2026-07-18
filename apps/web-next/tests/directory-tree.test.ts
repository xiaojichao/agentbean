import { describe, expect, test } from 'vitest';
import {
  applyDirectoryListFailure,
  applyDirectoryListSuccess,
  breadcrumbSegments,
  formatListDirectoryError,
  initialDirectoryTreeState,
  joinDirectoryPath,
  isRootAnchor,
  markDirectoryLoading,
  needsDirectoryFetch,
  toggleDirectoryExpanded,
  visibleDirectoryRows,
} from '../lib/directory-tree';

// 切片1 的 web 端纯函数：错误码翻译 + 路径拼接。
// 树形 UI 组件（切片4）会消费这些纯函数；此处只测可单测的逻辑（沿用 web-next 测 lib 不测组件的惯例）。
describe('formatListDirectoryError', () => {
  test('DEVICE_OFFLINE → 设备不在线提示', () => {
    expect(formatListDirectoryError('DEVICE_OFFLINE')).toContain('不在线');
  });

  test('DIRECTORY_LIST_TIMEOUT → 超时提示', () => {
    expect(formatListDirectoryError('DIRECTORY_LIST_TIMEOUT')).toContain('超时');
  });

  test('PATH_NOT_FOUND → 路径不存在提示', () => {
    expect(formatListDirectoryError('PATH_NOT_FOUND')).toContain('不存在');
  });

  test('PERMISSION_DENIED → 权限提示', () => {
    expect(formatListDirectoryError('PERMISSION_DENIED')).toContain('权限');
  });

  test('FORBIDDEN（server 授权拒绝的实际错误码）→ 权限提示', () => {
    // server assertCanManageDevice 拒绝时返回全仓惯例码 FORBIDDEN（非 spec 字面 PERMISSION_DENIED），
    // 映射层必须覆盖真实码，否则用户看到裸 "FORBIDDEN"。
    expect(formatListDirectoryError('FORBIDDEN')).toContain('权限');
  });

  test('未知错误码原样返回（不误吞，供排查）', () => {
    expect(formatListDirectoryError('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  test('空错误码兜底', () => {
    expect(formatListDirectoryError(undefined)).toContain('失败');
  });
});

describe('joinDirectoryPath', () => {
  test('Unix 绝对路径拼接子目录', () => {
    expect(joinDirectoryPath('/Users/shaw', 'projects')).toBe('/Users/shaw/projects');
  });

  test('根路径拼接不带重复斜杠', () => {
    expect(joinDirectoryPath('/', 'Users')).toBe('/Users');
  });

  test('homePath 锚点原样返回（首层不拼）', () => {
    expect(joinDirectoryPath('/Users/shaw', '')).toBe('/Users/shaw');
  });
});

describe('isRootAnchor', () => {
  test('空串是根锚点（首次请求 $HOME）', () => {
    expect(isRootAnchor('')).toBe(true);
  });

  test('~ 是根锚点', () => {
    expect(isRootAnchor('~')).toBe(true);
  });

  test('绝对路径不是根锚点', () => {
    expect(isRootAnchor('/Users/shaw')).toBe(false);
  });
});

// 切片4：树形选择器的纯状态逻辑。组件（DirectoryTreePicker）只负责渲染与发请求，
// 所有状态迁移都在这里，可单测（沿用 web-next 测 lib 不测组件惯例）。
describe('目录树状态（切片4）', () => {
  const ack = (over: Partial<Parameters<typeof applyDirectoryListSuccess>[2]> = {}) => ({
    ok: true as const,
    entries: [
      { name: 'projects', isDir: true },
      { name: 'docs', isDir: true },
      { name: 'README.md', isDir: false },
    ],
    homePath: '/home/u',
    ...over,
  });

  test('初始状态为空', () => {
    const s = initialDirectoryTreeState();
    expect(s.homePath).toBeUndefined();
    expect(visibleDirectoryRows(s)).toEqual([]);
  });

  test('加载成功写入 children + homePath，并记录 truncated', () => {
    let s = initialDirectoryTreeState();
    s = markDirectoryLoading(s, '');
    s = applyDirectoryListSuccess(s, '', ack({ truncated: true }));
    expect(s.homePath).toBe('/home/u');
    expect(s.children['/home/u']?.map((e) => e.name)).toEqual(['projects', 'docs', 'README.md']);
    expect(s.loading['']).toBeUndefined();
    expect(s.truncated['/home/u']).toBe(true);
  });

  test('加载失败翻译错误码并清 loading', () => {
    let s = initialDirectoryTreeState();
    s = markDirectoryLoading(s, '/home/u');
    s = applyDirectoryListFailure(s, '/home/u', 'FORBIDDEN');
    expect(s.errors['/home/u']).toContain('权限');
    expect(s.loading['/home/u']).toBeUndefined();
  });

  test('visibleDirectoryRows 只列目录、只展开已 expanded 的节点', () => {
    let s = initialDirectoryTreeState();
    s = applyDirectoryListSuccess(s, '', ack());
    // 未展开任何节点：只有根的下层（README.md 是文件被过滤）
    expect(visibleDirectoryRows(s).map((r) => r.path)).toEqual(['/home/u/projects', '/home/u/docs']);

    // 展开 projects（先加载其子项）
    s = toggleDirectoryExpanded(s, '/home/u/projects');
    s = applyDirectoryListSuccess(s, '/home/u/projects', {
      ok: true,
      entries: [
        { name: 'agentbean', isDir: true },
        { name: 'notes.txt', isDir: false },
      ],
    });
    const rows = visibleDirectoryRows(s);
    expect(rows.map((r) => r.path)).toEqual([
      '/home/u/projects',
      '/home/u/projects/agentbean',
      '/home/u/docs',
    ]);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[1]!.depth).toBe(1);
    expect(rows[0]!.expanded).toBe(true);
    expect(rows[1]!.expanded).toBe(false);

    // 折叠后子树消失
    s = toggleDirectoryExpanded(s, '/home/u/projects');
    expect(visibleDirectoryRows(s).map((r) => r.path)).toEqual(['/home/u/projects', '/home/u/docs']);
  });

  test('行的 loading / error / truncated 状态透传', () => {
    let s = initialDirectoryTreeState();
    s = applyDirectoryListSuccess(s, '', ack());
    s = markDirectoryLoading(s, '/home/u/docs');
    let rows = visibleDirectoryRows(s);
    expect(rows.find((r) => r.path === '/home/u/docs')!.loading).toBe(true);

    s = applyDirectoryListFailure(s, '/home/u/docs', 'RATE_LIMITED');
    rows = visibleDirectoryRows(s);
    const docs = rows.find((r) => r.path === '/home/u/docs')!;
    expect(docs.loading).toBe(false);
    expect(docs.error).toContain('频繁');
  });

  test('needsDirectoryFetch：未加载且非 loading 时才需要拉取', () => {
    let s = initialDirectoryTreeState();
    expect(needsDirectoryFetch(s, '/home/u')).toBe(true);
    s = markDirectoryLoading(s, '/home/u');
    expect(needsDirectoryFetch(s, '/home/u')).toBe(false);
    s = applyDirectoryListSuccess(s, '/home/u', { ok: true, entries: [] });
    expect(needsDirectoryFetch(s, '/home/u')).toBe(false);
  });

  test('加载失败后可重试（错误态不阻止再次拉取）', () => {
    let s = initialDirectoryTreeState();
    s = applyDirectoryListFailure(s, '/home/u', 'DEVICE_OFFLINE');
    expect(needsDirectoryFetch(s, '/home/u')).toBe(true);
  });
});

describe('breadcrumbSegments', () => {
  test('绝对路径拆成累计面包屑', () => {
    expect(breadcrumbSegments('/Users/shaw/projects')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'shaw', path: '/Users/shaw' },
      { label: 'projects', path: '/Users/shaw/projects' },
    ]);
  });

  test('根路径只有一段', () => {
    expect(breadcrumbSegments('/')).toEqual([{ label: '/', path: '/' }]);
  });

  test('空路径返回空', () => {
    expect(breadcrumbSegments('')).toEqual([]);
  });
});
