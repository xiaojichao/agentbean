# Domain Docs

本仓库使用 multi-context domain documentation 布局。

## 探索代码前

依次检查：

- 根目录 `CONTEXT-MAP.md`，确定与当前任务相关的业务上下文。
- `CONTEXT-MAP.md` 指向的相关 `CONTEXT.md`。
- `docs/adr/` 中影响当前领域的系统级 ADR。
- 相关 context 内 `docs/adr/` 中的局部 ADR。

如果这些文件尚不存在，继续工作，不将缺失本身作为错误，也不提前创建空文档。`domain-modeling` 等 skill 会在术语或架构决策真正形成时按需创建它们。

## 布局

```text
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/
├── apps/
│   └── <context>/
│       ├── CONTEXT.md
│       └── docs/adr/
└── packages/
    └── <context>/
        ├── CONTEXT.md
        └── docs/adr/
```

`docs/adr/` 保存跨 context 的系统级决策。`apps/*` 或 `packages/*` 下的 ADR 只记录该 context 内部决策。

## 使用 glossary 术语

issue 标题、重构建议、假设和测试名称应使用对应 `CONTEXT.md` glossary 中定义的术语，避免改用 glossary 明确排除的同义词。

若所需概念尚未定义，先判断它是否只是代码库未使用的新说法；若确属领域缺口，将其记录给 `domain-modeling`。

## ADR 冲突

输出若与现有 ADR 冲突，必须明确指出冲突及重新讨论的理由，不得静默覆盖既有决策。
