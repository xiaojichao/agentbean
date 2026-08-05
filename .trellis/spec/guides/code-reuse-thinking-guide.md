# 代码复用思维指南

> **目的**：在创建新代码前停下来想一想——它是否已经存在？

---

## 问题

**重复代码是不一致性 bug 的头号来源。**

当你复制粘贴或重写已有逻辑时：
- bug 修复不会传播
- 行为随时间发散
- 代码库变得更难理解

---

## 写新代码之前

### 步骤 1：先搜索

```bash
# Search for similar function names
grep -r "functionName" .

# Search for similar logic
grep -r "keyword" .
```

### 步骤 2：问这些问题

| 问题 | 如果是…… |
|----------|-----------|
| 是否存在类似的函数？ | 使用或扩展它 |
| 这个模式在别处用到了吗？ | 沿用现有模式 |
| 它可以是一个共享 utility 吗？ | 在正确的位置创建它 |
| 我在从另一个文件复制代码吗？ | **停下** - 抽到共享位置 |

---

## 常见重复模式

### 模式 1：复制粘贴函数

**反面**：把一个校验函数复制到另一个文件

**正面**：抽到共享 utility，在需要处 import

### 模式 2：相似组件

**反面**：创建与现有组件 80% 相似的新组件

**正面**：用 props/variants 扩展现有组件

### 模式 3：重复常量

**反面**：在多个文件里定义同一常量

**正面**：单一真相源，到处 import

### 模式 4：重复的 payload 字段提取

**反面**：多个消费方各自对同一 JSON/event 字段做强制转换：

```typescript
const description = (ev as { description?: string }).description;
const context = (ev as { context?: ContextEntry[] }).context;
```

即便代码只有两行，这也是重复的契约逻辑。每个消费方现在都有了各自关于"合法 payload 长什么样"的定义。

**正面**：把 decoder、type guard 或 projection 放在数据所有者旁边：

```typescript
if (isThreadEvent(ev)) {
  renderThreadEvent(ev);
}
```

**规则**：如果同一未类型化 payload 字段在 2 处以上被读取，在出现第三个读取者之前，创建共享的 type guard / normalizer / projection。

---

## 何时抽象

**该抽象的情况**：
- 同一段代码出现 3 次以上
- 逻辑复杂到可能出 bug
- 多人可能需要它

**不该抽象的情况**：
- 只用一次
- 平凡的一行代码
- 抽象后比重复还复杂

---

## 批量修改之后

当你对多个文件做了相似的改动后：

1. **复查**：是否覆盖了所有实例？
2. **搜索**：跑 grep 找出遗漏的
3. **考虑**：这应该抽象出来吗？

### reducer 应使用穷举式结构

当状态从类 action 值（`action`、`kind`、`status`、`phase`）派生时，优先用一个带 `switch` 的 reducer，而不是分散的 `if/else` 更新。

```typescript
// BAD - action-specific state transitions are hard to audit
if (action === "opened") { ... }
else if (action === "comment") { ... }
else if (action === "status") { ... }

// GOOD - one reducer owns the transition table
switch (event.action) {
  case "opened":
    ...
    return;
  case "comment":
    ...
    return;
}
```

当 event log 是真相源时这很重要。reducer 是有文档记录的重放模型；展示代码和命令不应重复该重放模型的片段。

---

## 提交前清单

- [ ] 已搜索现有相似代码
- [ ] 没有本该共享却被复制粘贴的逻辑
- [ ] 没有在共享 decoder 之外重复提取未类型化 payload 字段
- [ ] 常量只在一处定义
- [ ] 相似模式沿用相同结构
- [ ] reducer/action 状态转换只存在于一个 reducer 或 command dispatcher 中

---

## 陷阱：Python if/elif/else 的穷举检查

**问题**：Python 的 if/elif/else 链没有编译期穷举检查。当你往一个 `Literal` 类型（例如 `Platform`）加新值时，已有的 if/elif/else 链会静默地落到 `else`，给出错误的默认值。

**症状**：新平台部分工作——某些方法返回 Claude 的默认值而非平台特定值。不抛任何错误。

**示例**（`cli_adapter.py`）：
```python
# BAD: "gemini" falls through to else, returns "claude"
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    else:
        return "claude"  # gemini silently gets "claude"!

# GOOD: explicit branch for every platform
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    elif self.platform == "gemini":
        return "gemini"
    else:
        return "claude"
```

**预防**：往 Python `Literal` 类型加新值时，搜索所有依据该类型分支的 if/elif/else 链并添加显式分支。不要依赖 `else` 对新值正确。

---

## 陷阱：产生同一输出的不对称机制

**问题**：当两个不同机制必须产出同一文件集合时（例如 init 用递归目录拷贝、update 用手动 `files.set()`），结构性变更（重命名、移动、新增子目录）只会通过自动机制传播。手动的那一侧会静默漂移。

**症状**：init 完美工作，但 update 在错误路径创建文件或完全漏掉文件。

**预防**：
- **最佳**：消除不对称——让手动路径调用自动路径（例如 `collectTemplateFiles()` 调用 `getAllScripts()`，而不是维护自己的列表）
- **若不对称不可避免**：加一个回归测试比较两种机制的输出
- 迁移目录结构时，搜索所有引用旧结构的代码路径

**真实案例**：`trellis update` 维护了一份手动 `files.set()` 列表，覆盖 11 个已被 `getAllScripts()` 跟踪的脚本。修复：用 `for..of getAllScripts()` 循环替换手动列表。见 v0.4.0-beta.3 中 `update.ts` 的重构。

---

## 模板文件注册（Trellis 专属）

往 `src/templates/trellis/scripts/` 添加新文件时：

**单一注册点**：`src/templates/trellis/index.ts`

1. 添加 `export const xxxScript = readTemplate("scripts/path/file.py");`
2. 加入 `getAllScripts()` Map

就这些。`commands/update.ts` 直接使用 `getAllScripts()`——无需手动同步。

**为何重要**：不在 `getAllScripts()` 中注册，`trellis update` 就不会把文件同步到用户项目。bug 修复和新功能都不会传播。

**历史**：v0.4.0-beta.3 之前，`update.ts` 有自己手工维护的文件列表，经常与 `getAllScripts()` 失同步。这导致 11 个 Python 文件在 `trellis update` 时被静默跳过。修复方式是消除重复列表，把 `getAllScripts()` 当作单一真相源。

### 新脚本快速清单

```bash
# After adding a new .py file, verify it's in getAllScripts():
grep -l "newFileName" src/templates/trellis/index.ts  # Should match
```

### 模板同步约定

`.trellis/scripts/`（dogfooded）与 `packages/cli/src/templates/trellis/scripts/`（模板）必须保持一致。编辑 `.trellis/scripts/` 之后，总要同步：

```bash
rsync -av --delete --exclude='__pycache__' .trellis/scripts/ packages/cli/src/templates/trellis/scripts/
```

**陷阱**：以错误的源/目标路径运行 rsync 会生成嵌套的垃圾目录（例如 `.trellis/scripts/packages/cli/...`）。运行前务必核对路径。
