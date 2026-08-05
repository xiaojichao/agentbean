# 跨层思维指南

> **目的**：实现前先梳理跨层数据流。

---

## 问题

**大多数 bug 发生在层边界**，而非层内部。

常见的跨层 bug：

- API 返回格式 A，前端期望格式 B
- 数据库存 X，service 转成 Y，却丢了数据
- 多个层用不同方式实现同一逻辑

---

## 实现跨层功能之前

### 步骤 1：绘制数据流

画出数据如何流动：

```
Source → Transform → Store → Retrieve → Transform → Display
```

对每个箭头，问：

- 数据是什么格式？
- 可能出什么问题？
- 谁负责校验？

### 步骤 2：识别边界

| 边界                  | 常见问题                           |
| --------------------- | --------------------------------- |
| API ↔ Service         | 类型不匹配、字段缺失               |
| Service ↔ Database    | 格式转换、null 处理                |
| Backend ↔ Frontend    | 序列化、日期格式                   |
| Component ↔ Component | props 形状变更                     |

### 步骤 3：定义契约

对每个边界：

- 精确的输入格式是什么？
- 精确的输出格式是什么？
- 可能发生哪些错误？

---

## 常见跨层错误

### 错误 1：隐式格式假设

**反面**：不检查就假设日期格式

**正面**：在边界做显式格式转换

### 错误 2：分散校验

**反面**：在多个层校验同一件事

**正面**：在入口处校验一次

### 错误 3：抽象泄漏

**反面**：组件知道数据库 schema

**正面**：每一层只了解它的邻居

### 错误 4：每个消费方各自解析同一 payload

**反面**：某个命令读取 JSONL 事件并就地强制转换字段：

```typescript
const thread = (ev as { thread?: string }).thread;
const labels = (ev as { labels?: string[] }).labels;
```

这看起来是局部的，但它意味着每个消费方都拥有自己那份事件契约。下一次字段变更只会更新某一个命令而漏掉另一个。

**正面**：在事件边界解码一次，然后导出带类型的 projection：

```typescript
if (!isThreadEvent(ev)) return false;
return ev.thread === filter.thread;
```

**规则**：对 append-only 日志、JSON 流、RPC payload 或配置文件，为以下各项指定唯一所有者：

- event / payload 类型定义
- 从 `unknown` 做的 type guard 与 normalization
- UI 命令使用的 metadata projection
- 从真相源重放状态的 reducer

渲染代码可以格式化字段，但不得重新定义 payload 契约。

---

## 跨层功能清单

实现前：

- [ ] 已绘制完整数据流
- [ ] 已识别所有层边界
- [ ] 已在每个边界定义格式
- [ ] 已确定校验发生在何处

实现后：

- [ ] 已用边界情况测试（null、空、非法）
- [ ] 已在每个边界验证错误处理
- [ ] 已检查数据能经受往返（round-trip）
- [ ] 已检查消费方 import 共享 decoder / projection，而非
      就地强制转换 payload 字段
- [ ] 已检查派生状态回溯到源事件标识符
      （`seq`、`id`、`version`），而非另造第二个游标

---

## 跨平台模板一致性

在 Trellis 中，命令模板（例如 `record-session.md`）存在于**多个平台**，内容完全或几乎完全一致。这是一处跨层边界。

### 清单：修改任何命令模板之后

- [ ] 找出拥有同一命令的所有平台：`find src/templates/*/commands/trellis/ -name "<command>.*"`
- [ ] 更新所有平台副本（Markdown `.md` 和 TOML `.toml`）
- [ ] 对 Gemini TOML：适配行续符（`\\` 与 `\`）以及三引号字符串
- [ ] 运行 `/trellis:check-cross-layer` 验证没有遗漏

**真实案例**：在 Claude 下更新 `record-session.md` 使用 `--mode record`，却忘了 iFlow、Kilo、OpenCode 和 Gemini——被跨层检查发现。

---

## 生成式运行时模板的升级一致性

某些生成文件既是文档又是运行时输入。在 Trellis 中，`.trellis/workflow.md` 会被 `get_context.py`、`workflow_phase.py`、SessionStart 过滤器以及 per-turn hook 解析。模板变更必须同时针对全新 init 与升级路径验证。

### 清单：修改运行时解析的模板之后

- [ ] 识别每一个读取该模板的运行时解析器，而不只是
      安装它的文件写入器
- [ ] 检查相关语法是否存在于显式 managed 区域
      （如 tag block）之外
- [ ] 验证全新 `init` 输出，以及一个会写入旧版
      `.trellis/.version` 的带版本号 `update` 场景
- [ ] 用较旧的原始模板 fixture 加一个升级回归，然后
      断言安装后的文件达到当前打包形态
- [ ] 更新持有该运行时契约的后端 spec

---

## 版本化文档边界

版本化文档是一处跨层边界：源路径、`docs.json` 的版本路由，以及渲染出的版本选择器，三者必须描述同一条发布线。

### 清单：编辑版本化文档之前

- [ ] 识别目标发布线：stable、beta 还是 RC
- [ ] 验证所编辑的 MDX 路径与该发布线匹配：
  - stable：`docs-site/{start,advanced,...}` 和 `docs-site/zh/{start,advanced,...}`
  - beta：`docs-site/beta/**` 和 `docs-site/zh/beta/**`
  - RC：`docs-site/rc/**` 和 `docs-site/zh/rc/**`
- [ ] 验证 `docs.json` 导航把版本标签指向相同路径
- [ ] 提交前在另一棵目录树中 grep 发布线专属术语
- [ ] 把出现在 root 发布路径下的 beta 内容视为源路径 bug，
      而非渲染 bug

**真实案例**：一项仅限 beta 的 task workflow 变更把 `prd.md` + `design.md` + `implement.md`、任务创建许可、以及 Codex 模式横幅写到了 root `start/` 与 `advanced/` 路径下。文档站随后在 Release 选择器下提供了 0.6 beta 的行为。修复方式是恢复 root 发布文档，把 0.6 内容移到 `beta/` 与 `zh/beta/`，并加一个针对 root 发布树扫描 beta 标记的 grep 审计。

**真实案例**：Codex inline 模式把 workflow 平台标记从 `[Codex]` / `[Kilo, Antigravity, Windsurf]` 改为 `[codex-sub-agent]` / `[codex-inline, Kilo, Antigravity, Windsurf]`。全新 init 是对的，但 `trellis update` 只合并了 `[workflow-state:*]` 块，保留了这些块之外的过期标记。结果：被升级的项目拿到了新的 hook 脚本，workflow 路由却是旧的，于是 `get_context.py --mode phase --platform codex` 可能返回空的 Phase 2.1 详情。

---

## 模式探测（mode-detection probe）清单

当 CLI 通过探测远程资源来自动检测模式时（例如检查 `index.json` 是否存在，以决定 marketplace 还是直接下载）：

### 实现前：

- [ ] 探测在使用该结果的**所有**代码路径中都运行（交互式、`-y`、各种 `--flag` 组合）
- [ ] 区分 404 与瞬时错误——不要把两者都当作"未找到"
- [ ] 瞬时错误**中止或重试**，绝不静默切换模式
- [ ] 上下文变化时（例如用户切换源）**重置**共享状态（缓存、预取数据）
- [ ] **快捷路径**（例如 `--template` 跳过选择器）的错误处理质量必须与探测路径一致——核查下游函数没有调用 catch-all 包装器

### 实现后：

- [ ] 追踪从探测结果到模式决策分支的每一条路径——没有 fallthrough
- [ ] 外部格式契约（giget URI、原始 URL）经过测试，或至少以注释形式记录
- [ ] metadata 读取要么消费完整响应，要么使用流式 parser——绝不把固定大小的前缀当作完整 JSON 解析
- [ ] 从解析出的片段重建复合标识符时，验证**所有**字段都已包含且**位置正确**（例如 `provider:repo/path#ref` 而非 `provider:repo#ref/path`）
- [ ] 验证快捷路径之后调用的**action 函数**内部没有沿用旧的 catch-all fetch——当错误区分有意义时，它们必须使用具备探测质量的变体

**真实案例**：自定义 registry 流程在 3 轮评审中共出现 8 个 bug：(1) 探测只在交互模式下运行，(2) 瞬时错误落到错误模式，(3) giget URI 中 `#ref` 位置错误，(4) 预取模板在源切换时泄漏，(5) `--template` 快捷路径绕过探测，但 `downloadTemplateById` 内部使用了 catch-all `fetchTemplateIndex`，把超时变成"Template not found"。

**真实案例**：Agent-session 更新提示用 `response.read(4096)` 拉取 npm `latest` metadata，然后把它当作完整 JSON 解析。`@mindfoldhq/trellis` 包的 metadata 超过 4 KB，于是 JSON 被截断、解析静默失败、首次 session 注入没有显示更新提示。修复：解析前读取完整响应，并加一个回归用例，让 `version` 后面跟 8 KB 的 metadata 尾巴。

---

## 跨平台模板一致性

在 Trellis 中，命令模板（例如 `record-session.md`）存在于**多个平台**，内容完全或几乎完全一致。这是一处跨层边界。

### 清单：修改任何命令模板之后

- [ ] 找出拥有同一命令的所有平台：`find src/templates/*/commands/trellis/ -name "<command>.*"`
- [ ] 更新所有平台副本（Markdown `.md` 和 TOML `.toml`）
- [ ] 对 Gemini TOML：适配行续符（`\\` 与 `\`）以及三引号字符串
- [ ] 运行 `/trellis:check-cross-layer` 验证没有遗漏

**真实案例**：在 Claude 下更新 `record-session.md` 使用 `--mode record`，却忘了 iFlow、Kilo、OpenCode 和 Gemini——被跨层检查发现。

---

## 生成式运行时模板的升级一致性

某些生成文件既是文档又是运行时输入。在 Trellis 中，`.trellis/workflow.md` 会被 `get_context.py`、`workflow_phase.py`、SessionStart 过滤器以及 per-turn hook 解析。模板变更必须同时针对全新 init 与升级路径验证。

### 清单：修改运行时解析的模板之后

- [ ] 识别每一个读取该模板的运行时解析器，而不只是安装它的文件写入器
- [ ] 检查相关语法是否存在于显式 managed 区域（如 tag block）之外
- [ ] 验证全新 `init` 输出，以及一个会写入旧版 `.trellis/.version` 的带版本号 `update` 场景
- [ ] 用较旧的原始模板 fixture 加一个升级回归，然后断言安装后的文件达到当前打包形态
- [ ] 更新持有该运行时契约的后端 spec

**真实案例**：Codex inline 模式把 workflow 平台标记从 `[Codex]` / `[Kilo, Antigravity, Windsurf]` 改为 `[codex-sub-agent]` / `[codex-inline, Kilo, Antigravity, Windsurf]`。全新 init 是对的，但 `trellis update` 只合并了 `[workflow-state:*]` 块，保留了这些块之外的过期标记。结果：被升级的项目拿到了新的 hook 脚本，workflow 路由却是旧的，于是 `get_context.py --mode phase --platform codex` 可能返回空的 Phase 2.1 详情。

---

## 模式探测（mode-detection probe）清单

当 CLI 通过探测远程资源来自动检测模式时（例如检查 `index.json` 是否存在，以决定 marketplace 还是直接下载）：

### 实现前：
- [ ] 探测在使用该结果的**所有**代码路径中都运行（交互式、`-y`、各种 `--flag` 组合）
- [ ] 区分 404 与瞬时错误——不要把两者都当作"未找到"
- [ ] 瞬时错误**中止或重试**，绝不静默切换模式
- [ ] 上下文变化时（例如用户切换源）**重置**共享状态（缓存、预取数据）
- [ ] **快捷路径**（例如 `--template` 跳过选择器）的错误处理质量必须与探测路径一致——核查下游函数没有调用 catch-all 包装器

### 实现后：
- [ ] 追踪从探测结果到模式决策分支的每一条路径——没有 fallthrough
- [ ] 外部格式契约（giget URI、原始 URL）经过测试，或至少以注释形式记录
- [ ] metadata 读取要么消费完整响应，要么使用流式 parser——绝不把固定大小的前缀当作完整 JSON 解析
- [ ] 从解析出的片段重建复合标识符时，验证**所有**字段都已包含且**位置正确**（例如 `provider:repo/path#ref` 而非 `provider:repo#ref/path`）
- [ ] 验证快捷路径之后调用的**action 函数**内部没有沿用旧的 catch-all fetch——当错误区分有意义时，它们必须使用具备探测质量的变体

**真实案例**：自定义 registry 流程在 3 轮评审中共出现 8 个 bug：(1) 探测只在交互模式下运行，(2) 瞬时错误落到错误模式，(3) giget URI 中 `#ref` 位置错误，(4) 预取模板在源切换时泄漏，(5) `--template` 快捷路径绕过探测，但 `downloadTemplateById` 内部使用了 catch-all `fetchTemplateIndex`，把超时变成"Template not found"。

**真实案例**：Agent-session 更新提示用 `response.read(4096)` 拉取 npm `latest` metadata，然后把它当作完整 JSON 解析。`@mindfoldhq/trellis` 包的 metadata 超过 4 KB，于是 JSON 被截断、解析静默失败、首次 session 注入没有显示更新提示。修复：解析前读取完整响应，并加一个回归用例，让 `version` 后面跟 8 KB 的 metadata 尾巴。

---

## 何时创建流程文档

出现以下情况时创建详细流程文档：

- 功能跨 3 层以上
- 涉及多个团队
- 数据格式复杂
- 该功能以前出过 bug

---

## event log / projection 边界

append-only 日志是跨层契约。一条事件会经过：

```
CLI input → event writer → events.jsonl → reader → filter → reducer → display
```

### 清单：添加新 event kind 或字段之后

- [ ] 把该 event kind 加入中央 event 分类体系
- [ ] 在事件层添加带类型的 event 变体或 type guard
- [ ] 对来自用户输入或 JSON 的数组/对象字段
      添加 normalization helper
- [ ] 让 `seq` / `id` 的赋值只发生在 event writer 中
- [ ] 让 filter 和 reducer 消费带类型的 event guard，而非本地强制转换
- [ ] 让展示代码消费 reducer 输出或带类型的事件，而非原始 JSON
- [ ] 至少加一个回归，证明历史重放与实时过滤
      使用同一套 filter 模型

**真实案例**：Thread channel 添加了 `kind: "thread"`、`description`、`context`、labels 和 `lastSeq`。第一版实现正确重放了 thread 状态，但若干命令仍用本地强制转换重新解析事件 payload 字段。修复方式是让核心事件层拥有 `ThreadChannelEvent` 与 `isThreadEvent`，让 `reduceChannelMetadata` 成为唯一的 channel metadata projection，让 `reduceThreads` 成为唯一的 thread 重放 reducer。
