import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { collectArtifacts, extractReportedOutputPaths, shouldCollectWindowedFile } from '../src/artifact-collector';

async function touch(path: string, mtimeMs: number): Promise<void> {
  writeFileSync(path, 'x');
  const seconds = Math.floor(mtimeMs / 1000);
  utimesSync(path, seconds, seconds);
}

describe('artifact-collector', () => {
  describe('extractReportedOutputPaths (#1045)', () => {
    test('提取交付语境中的路径并去重保序', () => {
      const body = [
        '搞定！总结文件已生成，保存在桌面上：',
        '',
        '/Users/shaw/Desktop/短视频二次创作总结.md',
        '',
        '已保存到：/Users/shaw/Documents/report.md。',
      ].join('\n');
      expect(extractReportedOutputPaths(body)).toEqual([
        '/Users/shaw/Desktop/短视频二次创作总结.md',
        '/Users/shaw/Documents/report.md',
      ]);
    });

    test('仅作为引用、来源或参考资料出现的路径不得进入候选（#1053）', () => {
      expect(extractReportedOutputPaths('参考了 /Users/shaw/notes.md 与 https://example.com/a.pdf')).toEqual([]);
      expect(extractReportedOutputPaths('数据来自 /Users/shaw/source.pdf，引用 /tmp/input.md')).toEqual([]);
      expect(extractReportedOutputPaths('based on /Users/a/notes.md, see /tmp/ref.pdf')).toEqual([]);
      expect(extractReportedOutputPaths('## 参考资料\n- /Users/a/notes.md\n- /tmp/source.pdf')).toEqual([]);
    });

    test('交付语境绑定到路径所在分句：同行其他分句的交付词不救引用路径（#1053 codex P1）', () => {
      // codex 指出的泄露场景：引用路径与交付词同行但不同分句，不得提取。
      expect(extractReportedOutputPaths('参考 "/tmp/customer data.pdf"，输出已经完成')).toEqual([]);
      expect(extractReportedOutputPaths('输出 "/a/x.md"，参考 "/b/y.md"')).toEqual(['/a/x.md']);
      expect(extractReportedOutputPaths('整理自 /tmp/source.md，已生成 /tmp/final.md')).toEqual(['/tmp/final.md']);
      // 交付词后置也成立：路径所在分句的后续文本含交付词。
      expect(extractReportedOutputPaths('/tmp/report.md 已生成')).toEqual(['/tmp/report.md']);
    });

    test('交付标题小节与交付声明冒号换行算结构化交付声明（#1053）', () => {
      expect(extractReportedOutputPaths('## 交付物\n- /Users/a/report.md\n- /tmp/final.pdf')).toEqual([
        '/Users/a/report.md',
        '/tmp/final.pdf',
      ]);
      expect(extractReportedOutputPaths('## Deliverables\n- /Users/a/report.md')).toEqual(['/Users/a/report.md']);
      expect(extractReportedOutputPaths('文件已生成：\n/Users/a/report.md')).toEqual(['/Users/a/report.md']);
    });

    test('忽略非交付扩展名、相对路径、缺失正文并处理尾部标点', () => {
      expect(extractReportedOutputPaths('已生成 /Users/a/state.json，输出 /Users/a/tmp.log')).toEqual([]);
      expect(extractReportedOutputPaths('使用 docs/a.md 作为模板')).toEqual([]);
      expect(extractReportedOutputPaths('交付：/Users/x/报告.md。')).toEqual(['/Users/x/报告.md']);
      expect(extractReportedOutputPaths('已生成：\n/Users/x/a.md\n输出 /Users/x/a.md')).toEqual(['/Users/x/a.md']);
      expect(extractReportedOutputPaths(undefined)).toEqual([]);
    });

    test('支持带引号且包含空格的 Unix 绝对路径（#1053）', () => {
      expect(extractReportedOutputPaths('已生成 "/Users/a/Desktop/final report.pdf"')).toEqual([
        '/Users/a/Desktop/final report.pdf',
      ]);
      expect(extractReportedOutputPaths("报告已保存到 '/Users/a/My Documents/报告.md'")).toEqual([
        '/Users/a/My Documents/报告.md',
      ]);
      expect(extractReportedOutputPaths('交付 “/Users/a/季度 总结.md”')).toEqual(['/Users/a/季度 总结.md']);
    });

    test('支持反引号（Markdown 代码 span）包裹的交付路径', () => {
      // Agent 用 Markdown 反引号报路径是最常见写法；修复前目录正则的边界集不含反引号，
      // 导致反引号包裹的交付目录被静默丢弃（剧本 Agent 实测：文件留在设备、永不发布 → 无 OutputPackage）。
      expect(extractReportedOutputPaths('10集剧本已全部创建在 `/Users/luyun/Desktop/ScriptCreate/剧本创作/` 目录下。')).toEqual([
        '/Users/luyun/Desktop/ScriptCreate/剧本创作/',
      ]);
      // 文件路径在反引号里（文件正则本就排除反引号作 body，能提取）。
      expect(extractReportedOutputPaths('已生成 `/Users/a/report.md`')).toEqual(['/Users/a/report.md']);
      // 反引号里的非绝对路径内容不误收。
      expect(extractReportedOutputPaths('运行 `npm run build` 后完成')).toEqual([]);
    });

    test('支持 Windows 绝对交付路径（#1053）', () => {
      expect(extractReportedOutputPaths('已生成 C:\\Users\\a\\Desktop\\report.md')).toEqual([
        'C:\\Users\\a\\Desktop\\report.md',
      ]);
      expect(extractReportedOutputPaths('已保存到 "D:\\My Documents\\final report.pdf"')).toEqual([
        'D:\\My Documents\\final report.pdf',
      ]);
      expect(extractReportedOutputPaths('输出 C:/Users/a/report.zip。')).toEqual(['C:/Users/a/report.zip']);
      expect(extractReportedOutputPaths('参考 C:\\Users\\a\\notes.md')).toEqual([]);
    });

    test('拒绝路径穿越与隐藏路径段', () => {
      expect(extractReportedOutputPaths('输出在 /Users/x/../etc/passwd.md')).toEqual([]);
      expect(extractReportedOutputPaths('已生成 /Users/x/.ssh/config.md')).toEqual([]);
      expect(extractReportedOutputPaths('已生成 /Users/x/.agentbean/device.md')).toEqual([]);
      expect(extractReportedOutputPaths('输出 //nas/share/a.md')).toEqual([]);
      expect(extractReportedOutputPaths('已生成 "C:\\Users\\a\\.ssh\\config.md"')).toEqual([]);
      expect(extractReportedOutputPaths('已生成 "C:\\Users\\a\\..\\x.md"')).toEqual([]);
    });

    test('提取回复报告的目录路径（尾斜杠，交付语境换行）', () => {
      // 真实 bug 形态：远程 agent 把交付物写到一个目录并在回复里报告该目录路径。
      // 目录（尤其尾斜杠）几乎必然是交付位置，语境门槛较文件路径放宽。
      expect(extractReportedOutputPaths('文件位置\n\n/Users/luyun/Desktop/ScriptCreate/剧本创作/')).toEqual([
        '/Users/luyun/Desktop/ScriptCreate/剧本创作/',
      ]);
      expect(extractReportedOutputPaths('已生成到 /tmp/outputs/')).toEqual(['/tmp/outputs/']);
      expect(extractReportedOutputPaths('产物位于 /Users/a/build/。')).toEqual(['/Users/a/build/']);
      // 引用/来源语境的目录仍拒绝（目录虽放宽语境，但不放过明确引用）。
      expect(extractReportedOutputPaths('参考 /tmp/data/')).toEqual([]);
      expect(extractReportedOutputPaths('数据来自 /Users/a/source/')).toEqual([]);
      // 隐藏段目录与穿越目录仍拒绝（结构校验先于语境）。
      expect(extractReportedOutputPaths('已生成 /Users/x/.ssh/')).toEqual([]);
      expect(extractReportedOutputPaths('已生成 /Users/x/../etc/')).toEqual([]);
    });
  });

  describe('collectArtifacts reported outputs (#1045)', () => {
    test('收集回复报告的交付文件并标记为受管 run output 通道', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-')));
      const agentBeanHome = join(cwd, '.agentbean');
      mkdirSync(agentBeanHome, { recursive: true });
      const desktopDir = join(cwd, 'Desktop');
      mkdirSync(desktopDir, { recursive: true });
      const target = join(desktopDir, '短视频二次创作总结.md');
      writeFileSync(target, '交付内容');

      const collected = await collectArtifacts({
        reportedOutputPaths: [target],
        reportedOutputExcludedPathPrefixes: [agentBeanHome],
        startedAt: Date.now() - 60_000,
      });

      expect(collected.map((artifact) => artifact.filename)).toEqual(['短视频二次创作总结.md']);
      expect(collected[0]!.sourceRoot).toEqual({
        id: 'agent-reported-outputs', kind: 'run_output', label: 'Agent 报告的输出',
      });
      expect(collected[0]!.role).toBe('run_output');
      expect(collected[0]!.relativePath).toBe('短视频二次创作总结.md');
      expect(collected[0]!.absolutePath).toBe(target);
    });

    test('拒绝窗口外、不存在、.agentbean 内部与排除前缀内的报告路径', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-reject-')));
      const agentBeanHome = join(cwd, '.agentbean');
      const inputDir = join(agentBeanHome, 'workspaces', 't', 'channels', 'c', 'runs', 'a', 'tk', '1', 'r', 'inputs');
      mkdirSync(inputDir, { recursive: true });
      const external = join(cwd, 'external');
      mkdirSync(external);
      const fresh = join(external, 'fresh.md');
      writeFileSync(fresh, 'new');
      const stale = join(external, 'stale.md');
      await touch(stale, 500);
      const attachment = join(inputDir, 'att-1-seed.md');
      writeFileSync(attachment, '输入附件');
      const internal = join(agentBeanHome, 'device.md');
      writeFileSync(internal, 'internal');

      const collected = await collectArtifacts({
        reportedOutputPaths: [fresh, stale, join(external, 'missing.md'), attachment, internal],
        reportedOutputExcludedPathPrefixes: [agentBeanHome],
        startedAt: 1000,
      });

      expect(collected.map((artifact) => artifact.filename)).toEqual(['fresh.md']);
    });

    test('symlink 逃逸被拒绝：链接目标落在排除前缀或隐藏路径内', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-symlink-')));
      const agentBeanHome = join(cwd, '.agentbean');
      mkdirSync(agentBeanHome, { recursive: true });
      const secretDir = join(cwd, '.secrets');
      mkdirSync(secretDir);
      const internalFile = join(agentBeanHome, 'state.md');
      writeFileSync(internalFile, '内部状态');
      const hiddenFile = join(secretDir, 'hidden.md');
      writeFileSync(hiddenFile, '隐藏内容');
      const publicFile = join(cwd, 'public.md');
      writeFileSync(publicFile, '合法交付');
      const linkDir = join(cwd, 'links');
      mkdirSync(linkDir);
      const escapeInternal = join(linkDir, 'escape-internal.md');
      const escapeHidden = join(linkDir, 'escape-hidden.md');
      const legitLink = join(linkDir, 'legit.md');
      symlinkSync(internalFile, escapeInternal);
      symlinkSync(hiddenFile, escapeHidden);
      symlinkSync(publicFile, legitLink);

      const collected = await collectArtifacts({
        reportedOutputPaths: [escapeInternal, escapeHidden, legitLink],
        reportedOutputExcludedPathPrefixes: [agentBeanHome],
        startedAt: Date.now() - 60_000,
      });

      // 合法 symlink 解析到通过全部校验的真实路径后仍可收集（macOS /tmp 同理）；
      // 指向排除前缀与隐藏路径的逃逸被明确拒绝。
      expect(collected.map((artifact) => artifact.filename)).toEqual(['public.md']);
      expect(collected[0]!.absolutePath).toBe(publicFile);
    });

    test('报告路径与受管输出目录发现同一文件时只收一次', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-dedupe-')));
      const outputDir = join(cwd, 'outputs');
      mkdirSync(outputDir, { recursive: true });
      const target = join(outputDir, '交付.md');
      writeFileSync(target, 'same');

      const collected = await collectArtifacts({
        outputDir,
        reportedOutputPaths: [target],
        reportedOutputExcludedPathPrefixes: [join(cwd, '.agentbean')],
        startedAt: 1000,
      });

      expect(collected.filter((artifact) => artifact.filename === '交付.md')).toHaveLength(1);
    });

    test('内容相同的不同路径文件只收一次（AC4 只发布一次）', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-sha-')));
      const outputDir = join(cwd, 'outputs');
      mkdirSync(outputDir, { recursive: true });
      const managed = join(outputDir, '交付.md');
      writeFileSync(managed, '完全相同的内容');
      const externalDir = join(cwd, 'Desktop');
      mkdirSync(externalDir);
      const reported = join(externalDir, '交付-副本.md');
      writeFileSync(reported, '完全相同的内容');

      const collected = await collectArtifacts({
        outputDir,
        reportedOutputPaths: [reported],
        reportedOutputExcludedPathPrefixes: [join(cwd, '.agentbean')],
        startedAt: 1000,
      });

      expect(collected).toHaveLength(1);
      expect(collected[0]!.absolutePath).toBe(managed);
    });

    test('同名不同内容的报告文件进入 reported/ 前缀避免覆盖受管输出', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-conflict-')));
      const outputDir = join(cwd, 'outputs');
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, '报告.md'), '受管版本');
      const externalDir = join(cwd, 'Desktop');
      mkdirSync(externalDir);
      const reported = join(externalDir, '报告.md');
      writeFileSync(reported, '报告的不同版本');

      const collected = await collectArtifacts({
        outputDir,
        reportedOutputPaths: [reported],
        reportedOutputExcludedPathPrefixes: [join(cwd, '.agentbean')],
        startedAt: 1000,
      });

      expect(collected.map((artifact) => artifact.relativePath).sort()).toEqual(['reported/报告.md', '报告.md']);
    });

    test('敏感文件名被拒绝并记录路径无关诊断', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-sensitive-')));
      const credentials = join(cwd, 'credentials.md');
      writeFileSync(credentials, 'token = abc');
      const key = join(cwd, 'id_rsa.txt');
      writeFileSync(key, 'PRIVATE KEY');
      const normal = join(cwd, 'normal.md');
      writeFileSync(normal, 'ok');
      const diagnostics: string[] = [];

      const collected = await collectArtifacts({
        reportedOutputPaths: [credentials, key, normal],
        reportedOutputExcludedPathPrefixes: [join(cwd, '.agentbean')],
        startedAt: Date.now() - 60_000,
        onDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.code}:${diagnostic.relativePath ?? ''}`),
      });

      expect(collected.map((artifact) => artifact.filename)).toEqual(['normal.md']);
      expect(diagnostics).toHaveLength(2);
      for (const line of diagnostics) {
        expect(line.startsWith('REPORTED_PATH_REJECTED:')).toBe(true);
        expect(line).not.toContain(cwd);
      }
    });

    test('超限报告文件跳过并报告 FILE_TOO_LARGE', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-large-')));
      const big = join(cwd, 'big.md');
      writeFileSync(big, 'x'.repeat(64));
      const skipped: Array<{ filename: string; reason: string }> = [];

      const collected = await collectArtifacts({
        reportedOutputPaths: [big],
        reportedOutputExcludedPathPrefixes: [join(cwd, '.agentbean')],
        startedAt: Date.now() - 60_000,
        maxBytes: 8,
        onSkipped: (artifact) => skipped.push({ filename: artifact.filename, reason: artifact.reason }),
      });

      expect(collected).toEqual([]);
      expect(skipped).toEqual([{ filename: 'big.md', reason: 'FILE_TOO_LARGE' }]);
    });

    test('报告目录路径时递归收集目录下的交付文件', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-dir-')));
      const agentBeanHome = join(cwd, '.agentbean');
      mkdirSync(agentBeanHome, { recursive: true });
      // 真实 bug 形态：远程 agent 把交付物写到 /Users/luyun/Desktop/ScriptCreate/剧本创作/
      const scriptDir = join(cwd, 'Desktop', 'ScriptCreate', '剧本创作');
      mkdirSync(scriptDir, { recursive: true });
      writeFileSync(join(scriptDir, '第1集-清晨的问候.md'), '第1集内容');
      writeFileSync(join(scriptDir, '第2集-她的名字.md'), '第2集内容');
      // 嵌套子目录验证递归
      mkdirSync(join(scriptDir, '大纲'));
      writeFileSync(join(scriptDir, '大纲', '总纲.md'), '大纲内容');
      // 隐藏文件跳过
      writeFileSync(join(scriptDir, '.hidden.md'), '隐藏内容');

      const collected = await collectArtifacts({
        reportedOutputPaths: [scriptDir],
        reportedOutputExcludedPathPrefixes: [agentBeanHome],
        startedAt: Date.now() - 60_000,
      });

      const names = collected.map((a) => a.filename).sort();
      expect(names).toEqual(['总纲.md', '第1集-清晨的问候.md', '第2集-她的名字.md']);
      // 嵌套文件保留相对目录结构作为 relativePath
      expect(collected.find((a) => a.filename === '总纲.md')!.relativePath).toBe('大纲/总纲.md');
      // 每个文件标记为受管 reported 通道
      for (const artifact of collected) {
        expect(artifact.sourceRoot.kind).toBe('run_output');
        expect(artifact.role).toBe('run_output');
      }
    });

    test('目录递归跳过 IGNORED_OUTPUT_DIRS 与排除前缀内的逃逸', async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-dir-skip-')));
      const agentBeanHome = join(cwd, '.agentbean');
      mkdirSync(agentBeanHome, { recursive: true });
      const deliverDir = join(cwd, '交付');
      mkdirSync(deliverDir, { recursive: true });
      writeFileSync(join(deliverDir, 'main.md'), 'ok');
      // node_modules 应被跳过
      mkdirSync(join(deliverDir, 'node_modules'));
      writeFileSync(join(deliverDir, 'node_modules', 'dep.md'), 'dep');
      // 排除前缀内的 symlink 逃逸应被拒
      const internal = join(agentBeanHome, 'secret.md');
      writeFileSync(internal, 'secret');
      symlinkSync(internal, join(deliverDir, 'escape.md'));

      const collected = await collectArtifacts({
        reportedOutputPaths: [deliverDir],
        reportedOutputExcludedPathPrefixes: [agentBeanHome],
        startedAt: Date.now() - 60_000,
      });

      expect(collected.map((a) => a.filename).sort()).toEqual(['main.md']);
    });
  });

  describe('collectArtifacts reported 通道升级 (#1051)', () => {
    test('回复报告 adapter 默认根已发现的同一文件：升级为受管 run output 且只收一次', async () => {
      const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'col-upgrade-home-')));
      const target = join(homeDir, 'HyperFrames视频制作完全指南-摘要.md');
      writeFileSync(target, '交付内容');

      const collected = await collectArtifacts({
        adapterOutputRoots: [{ dir: homeDir, recursive: false, createdInWindow: true }],
        reportedOutputPaths: [target],
        reportedOutputExcludedPathPrefixes: [join(homeDir, '.agentbean')],
        startedAt: 1000,
      });

      // 精确声明优先于猜测兜底：adapter 版本被移除，reported 版本进入受管通道。
      expect(collected).toHaveLength(1);
      expect(collected[0]!.sourceRoot).toEqual({
        id: 'agent-reported-outputs', kind: 'run_output', label: 'Agent 报告的输出',
      });
      expect(collected[0]!.role).toBe('run_output');
      expect(collected[0]!.absolutePath).toBe(target);
    });

    test('symlink 别名与 adapter 根同内容撞车：按 sha256 升级而非跳过', async () => {
      const realHome = realpathSync(mkdtempSync(join(tmpdir(), 'col-upgrade-sha-real-')));
      const linkParent = realpathSync(mkdtempSync(join(tmpdir(), 'col-upgrade-sha-link-')));
      const linkHome = join(linkParent, 'home-link');
      symlinkSync(realHome, linkHome);
      writeFileSync(join(realHome, 'report.md'), '同内容');

      const collected = await collectArtifacts({
        // adapter 根经 symlink 目录扫描，绝对路径文本与 realpath 不同，
        // abs 判同必然落空，只有 sha256 判同能命中——锁定 sha 升级路径。
        adapterOutputRoots: [{ dir: linkHome, recursive: false, createdInWindow: true }],
        reportedOutputPaths: [join(realHome, 'report.md')],
        reportedOutputExcludedPathPrefixes: [join(realHome, '.agentbean')],
        startedAt: 1000,
      });

      expect(collected).toHaveLength(1);
      expect(collected[0]!.sourceRoot.id).toBe('agent-reported-outputs');
      expect(collected[0]!.absolutePath).toBe(join(realHome, 'report.md'));
    });

    test('受管目录已有同内容时：reported 跳过且 adapter 同内容副本被移除（同内容只发一次）', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'col-upgrade-managed-')));
      const outputDir = join(root, 'outputs');
      mkdirSync(outputDir, { recursive: true });
      const managed = join(outputDir, '交付.md');
      writeFileSync(managed, '完全相同的内容');
      const homeDir = join(root, 'home');
      mkdirSync(homeDir);
      const adapterCopy = join(homeDir, '交付-副本.md');
      writeFileSync(adapterCopy, '完全相同的内容');

      const collected = await collectArtifacts({
        outputDir,
        adapterOutputRoots: [{ dir: homeDir, recursive: false, createdInWindow: true }],
        reportedOutputPaths: [adapterCopy],
        reportedOutputExcludedPathPrefixes: [join(root, '.agentbean')],
        startedAt: 1000,
      });

      expect(collected).toHaveLength(1);
      expect(collected[0]!.absolutePath).toBe(managed);
      expect(collected[0]!.sourceRoot.kind).toBe('run_output');
    });

    test('报告受管目录内路径时：同内容 adapter 副本被顺带移除（AC2 闭环）', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'col-upgrade-abs-managed-')));
      const outputDir = join(root, 'outputs');
      mkdirSync(outputDir, { recursive: true });
      const managed = join(outputDir, '交付.md');
      writeFileSync(managed, '完全相同的内容');
      const homeDir = join(root, 'home');
      mkdirSync(homeDir);
      // Agent 把同一交付同时拷进 adapter 默认根，但回复报告的是受管目录内路径。
      const adapterCopy = join(homeDir, '交付.md');
      writeFileSync(adapterCopy, '完全相同的内容');

      const collected = await collectArtifacts({
        outputDir,
        adapterOutputRoots: [{ dir: homeDir, recursive: false, createdInWindow: true }],
        reportedOutputPaths: [managed],
        reportedOutputExcludedPathPrefixes: [join(root, '.agentbean')],
        startedAt: 1000,
      });

      // 受管版本只发一次；adapter 副本若保留会 legacy + revision 双发。
      expect(collected).toHaveLength(1);
      expect(collected[0]!.absolutePath).toBe(managed);
      expect(collected[0]!.sourceRoot.kind).toBe('run_output');
    });

    test('adapter 与配置根重复发现的同一文件：升级时两个猜测条目都被移除', async () => {
      const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'col-upgrade-multi-')));
      const target = join(homeDir, '交付.md');
      writeFileSync(target, '交付内容');

      const collected = await collectArtifacts({
        adapterOutputRoots: [{ dir: homeDir, recursive: false, createdInWindow: true }],
        configuredOutputRoots: [{ id: 'shared', path: homeDir, label: '共享目录' }],
        reportedOutputPaths: [target],
        reportedOutputExcludedPathPrefixes: [join(homeDir, '.agentbean')],
        startedAt: 1000,
      });

      expect(collected).toHaveLength(1);
      expect(collected[0]!.sourceRoot.id).toBe('agent-reported-outputs');
      expect(collected[0]!.absolutePath).toBe(target);
    });

    test('升级目标未通过安全校验时保留既有 adapter 条目（交付不回退）', async () => {
      const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'col-upgrade-keep-')));
      const target = join(homeDir, 'credentials.md');
      writeFileSync(target, 'token = abc');
      const diagnostics: string[] = [];

      const collected = await collectArtifacts({
        adapterOutputRoots: [{ dir: homeDir, recursive: false, createdInWindow: true }],
        reportedOutputPaths: [target],
        reportedOutputExcludedPathPrefixes: [join(homeDir, '.agentbean')],
        startedAt: 1000,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      });

      // 敏感文件名被 reported 安全校验拒绝时不得误删已收集的 adapter 版本——
      // 通道升级只在 reported 版本通过全部校验后发生。
      expect(collected).toHaveLength(1);
      expect(collected[0]!.sourceRoot.kind).toBe('adapter_generated');
      expect(diagnostics).toContain('REPORTED_PATH_REJECTED');
    });

    test('reported .hermes 收(信任 agent 声明);managed run_output 优先于 adapter scan', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'col-upgrade-hidden-')));
      const outputRoot = join(root, '.hermes', 'output');
      mkdirSync(join(outputRoot, '20260803'), { recursive: true });
      const target = join(outputRoot, '20260803', 'report.md');
      writeFileSync(target, '数据根交付');
      const diagnostics: string[] = [];

      const collected = await collectArtifacts({
        // reported 通道信任 agent 声明:.hermes 等 agent 数据目录放行(只拒真敏感段)。
        // scan(adapterOutputRoots)走 skipHidden 不经段守卫;reported 收的 managed run_output
        // 与 adapter_generated 同文件时,managed 优先(dedup 删 adapter 副本)。
        adapterOutputRoots: [{ dir: outputRoot, recursive: true }],
        reportedOutputPaths: [target],
        reportedOutputExcludedPathPrefixes: [join(root, '.agentbean')],
        startedAt: 1000,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      });

      expect(collected).toHaveLength(1);
      expect(collected[0]!.sourceRoot.kind).toBe('run_output');
      expect(diagnostics).not.toContain('REPORTED_PATH_REJECTED');
    });
  });

  test('shouldCollectWindowedFile 只收 run 窗口内新建的共享目录文件', () => {
    const startedAt = Date.now() - 60_000;
    // 窗口内新建：mtime 与 birthtime 都在窗口内 → 收集。
    expect(shouldCollectWindowedFile({
      mtimeMs: Date.now(), birthtimeMs: Date.now(), startedAt, createdInWindow: true,
    })).toBe(true);
    // 窗口外 mtime → 不收集。
    expect(shouldCollectWindowedFile({
      mtimeMs: startedAt - 1000, birthtimeMs: Date.now(), startedAt, createdInWindow: true,
    })).toBe(false);
    // 既有文件仅被修改（birthtime 早于窗口，mtime 在窗口内）→ 不收集。
    expect(shouldCollectWindowedFile({
      mtimeMs: Date.now(), birthtimeMs: startedAt - 86_400_000, startedAt, createdInWindow: true,
    })).toBe(false);
    // 平台无 birthtime（<=0）→ 退化为仅 mtime 判断。
    expect(shouldCollectWindowedFile({
      mtimeMs: Date.now(), birthtimeMs: 0, startedAt, createdInWindow: true,
    })).toBe(true);
    // 未开启 createdInWindow → 仅 mtime 判断。
    expect(shouldCollectWindowedFile({
      mtimeMs: Date.now(), birthtimeMs: startedAt - 86_400_000, startedAt,
    })).toBe(true);
  });

  test('collects all matching files from outputs dir regardless of mtime', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'a.png'), 'pic');
    writeFileSync(join(outputDir, 'b.txt'), 'text');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 0 });
    const names = collected.map((c) => c.filename).sort();
    expect(names).toEqual(['a.png', 'b.txt']);
  });

  test('ignores files without whitelisted extension', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'keep.pdf'), 'p');
    writeFileSync(join(outputDir, 'skip.exe'), 'x');
    writeFileSync(join(outputDir, 'skip.log'), 'x');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 0 });
    expect(collected.map((c) => c.filename)).toEqual(['keep.pdf']);
  });

  test('cwd fallback scan only picks files with mtime > startedAt', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    await touch(join(cwd, 'old.json'), 1000);
    await touch(join(cwd, 'new.json'), 5000);

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 3000 });
    const names = collected.map((c) => c.filename);
    expect(names).toContain('new.json');
    expect(names).not.toContain('old.json');
  });

  test('extra output dirs collect Codex-native generated images by mtime', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    const generatedImagesDir = join(cwd, 'codex-generated-images', 'run-1');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(generatedImagesDir, { recursive: true });
    await touch(join(generatedImagesDir, 'old.png'), 1000);
    await touch(join(generatedImagesDir, 'ig_abc123.png'), 5000);

    const collected = await collectArtifacts({
      outputDir,
      cwd,
      extraOutputDirs: [join(cwd, 'codex-generated-images')],
      startedAt: 3000,
    });

    const names = collected.map((c) => c.filename);
    expect(names).toContain('ig_abc123.png');
    expect(names).not.toContain('old.png');
  });

  test('missing optional adapter output dirs do not add Run diagnostics', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const diagnostics: string[] = [];

    await collectArtifacts({
      extraOutputDirs: [join(cwd, 'missing-generated-images')],
      startedAt: 0,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    expect(diagnostics).toEqual([]);
  });

  test('adapter output roots collect only whitelisted top-level and output/ files', async () => {
    const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'col-adapter-home-')));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-adapter-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    const hermesHomeDir = join(homeDir, '.hermes');
    mkdirSync(outputDir, { recursive: true });
    // 主目录顶层：交付 .md 可收集；.json/.yaml/隐藏项/子目录/超窗文件均排除。
    await touch(join(homeDir, 'HyperFrames视频制作完全指南-摘要.md'), 5000);
    await touch(join(homeDir, 'notes.json'), 5000);
    await touch(join(homeDir, '.hidden.md'), 5000);
    await touch(join(homeDir, 'old.md'), 500);
    mkdirSync(join(homeDir, 'Documents'), { recursive: true });
    await touch(join(homeDir, 'Documents', 'draft.md'), 5000);
    // AgentOS 数据根：顶层 总结.md 可收集；pairing/config 等状态排除；output/ 递归可收集。
    mkdirSync(hermesHomeDir, { recursive: true });
    await touch(join(hermesHomeDir, '总结.md'), 5000);
    await touch(join(hermesHomeDir, 'gateway_state.json'), 5000);
    await touch(join(hermesHomeDir, 'config.yaml'), 5000);
    mkdirSync(join(hermesHomeDir, 'pairing'), { recursive: true });
    await touch(join(hermesHomeDir, 'pairing', 'weixin.json'), 5000);
    mkdirSync(join(hermesHomeDir, 'output', '20260801'), { recursive: true });
    await touch(join(hermesHomeDir, 'output', '20260801', 'report.md'), 5000);

    const collected = await collectArtifacts({
      outputDir,
      adapterOutputRoots: [
        { dir: homeDir, recursive: false, createdInWindow: true },
        { dir: hermesHomeDir, recursive: false },
        { dir: join(hermesHomeDir, 'output'), recursive: true },
      ],
      startedAt: 1000,
    });

    const names = collected.map((c) => c.filename).sort();
    expect(names).toEqual(['HyperFrames视频制作完全指南-摘要.md', 'report.md', '总结.md']);
    expect(collected.every((artifact) => artifact.sourceRoot.kind === 'adapter_generated')).toBe(true);
  });

  test('extra output dirs do not let many old files hide a new generated image', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    const generatedImagesDir = join(cwd, 'codex-generated-images');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(generatedImagesDir, { recursive: true });
    for (let i = 0; i < 2005; i += 1) {
      await touch(join(generatedImagesDir, `old-${i}.png`), 1000);
    }
    await touch(join(generatedImagesDir, 'ig_new.png'), 5000);

    const collected = await collectArtifacts({
      outputDir,
      cwd,
      extraOutputDirs: [generatedImagesDir],
      startedAt: 3000,
    });

    expect(collected.map((c) => c.filename)).toContain('ig_new.png');
  });

  test('cwd fallback skips ignored dirs like node_modules and .agentbean', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(join(cwd, 'node_modules'), { recursive: true });
    mkdirSync(join(cwd, '.agentbean', 'runs', 'r'), { recursive: true });
    await touch(join(cwd, 'node_modules', 'leak.png'), 5000);
    await touch(join(cwd, '.agentbean', 'runs', 'r', 'nested.png'), 5000);

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 1000 });
    expect(collected.map((c) => c.filename)).not.toContain('leak.png');
    expect(collected.map((c) => c.filename)).not.toContain('nested.png');
  });

  test('keeps distinct relative paths even when file content is identical', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'image-001.png'), 'same-bytes');
    mkdirSync(join(outputDir, 'sub'), { recursive: true });
    await touch(join(outputDir, 'sub', 'zzz.png'), 5000);
    writeFileSync(join(outputDir, 'sub', 'zzz.png'), 'same-bytes');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 1000 });
    const sameContent = collected.filter((c) => c.sha256 === collected[0].sha256);
    expect(sameContent).toHaveLength(2);
    expect(sameContent.map((artifact) => artifact.relativePath).sort()).toEqual([
      'image-001.png',
      join('sub', 'zzz.png'),
    ]);
  });

  test('fills sha256 and sizeBytes', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'a.txt'), 'hello');
    const [collected] = await collectArtifacts({ outputDir, cwd, startedAt: 0 });
    expect(collected.sizeBytes).toBe(5);
    expect(collected.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('skips files larger than maxBytes before hashing', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'big.zip'), 'x'.repeat(50));
    writeFileSync(join(outputDir, 'small.txt'), 'ok');

    const diagnostics: string[] = [];
    const collected = await collectArtifacts({
      outputDir,
      cwd,
      startedAt: 0,
      maxBytes: 10,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    expect(collected.map((c) => c.filename)).toEqual(['small.txt']);
    expect(diagnostics).toContain('ARTIFACT_FILE_TOO_LARGE');
  });

  test('keeps same relative files independent across source roots and assigns explicit roles', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    const configuredDir = join(cwd, 'deliverables');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(configuredDir, { recursive: true });
    writeFileSync(join(outputDir, 'report.md'), 'same');
    writeFileSync(join(configuredDir, 'report.md'), 'same');

    const collected = await collectArtifacts({
      outputDir,
      configuredOutputRoots: [{ id: 'deliverables', path: configuredDir, label: '交付目录', defaultRole: 'deliverable' }],
      startedAt: 0,
    });

    const reports = collected.filter((artifact) => artifact.filename === 'report.md');
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((artifact) => artifact.sourceRoot.id)).size).toBe(2);
    expect(reports.map((artifact) => artifact.role).sort()).toEqual(['deliverable', 'run_output']);
    expect(reports.find((artifact) => artifact.role === 'deliverable')?.sourceRoot.id).toBe('deliverables');
    expect(reports.every((artifact) => !artifact.absolutePath.includes('AGENTBEAN_OUTPUT_DIR'))).toBe(true);
  });
});
