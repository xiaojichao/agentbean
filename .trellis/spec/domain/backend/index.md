# @agentbean/domain 编码指南导航

本目录是包 `@agentbean/domain`（仓库路径 `packages/domain/`）的实战编码规范。读者=未来 AI agent 与新成员。所有规则来自真实源码取证，无占位内容。

## 包定位一句话

纯领域逻辑包：定义 Agent 身份、Task 生命周期、交付成形、频道授权等业务的**决策函数与值对象**。无持久化、无 IO、无时钟、无随机——唯一运行时依赖是 `node:crypto` 的确定性 SHA-256。Repository 接口不在本包，全在 `apps/server-next/src/application/*-repositories.ts`。

## 阅读顺序

| 文件 | 回答的问题 | 何时读 |
|---|---|---|
| [architecture.md](./architecture.md) | 这个包做什么、不做什么、核心抽象在哪 | 第一次接触本包 |
| [conventions.md](./conventions.md) | 纯函数纪律、readonly、now 注入、clone-before-sort、domain-vs-infra 边界 | 动手写/改任何 `src/*.ts` 之前 |
| [gotchas.md](./gotchas.md) | readonly 幻觉、相对路径绕包、确定性泄漏、桶幽灵导出等已踩过的坑 | 改完代码跑测试前，以及审查本包 PR 时 |
| [testing.md](./testing.md) | 测试风格、代表文件、运行命令 | 新增/修改任何 `tests/*.test.ts` 时 |

## 取证基准

- 仓库根：`/Users/shaw/AgentBean`
- 包根：`packages/domain/`
- 源码：`packages/domain/src/`（扁平约 70 文件）
- 测试：`packages/domain/tests/`（镜像结构，66 文件）
- 桶：`packages/domain/src/index.ts`（73 个 `export`，re-export 全部公共模块）
- 清单：`packages/domain/package.json`（唯一依赖 `@agentbean/contracts` 经 `file:../contracts` 软链）

## 验证命令速查

```bash
pnpm --filter @agentbean/domain test          # 跑全部 vitest
pnpm --filter @agentbean/domain build         # tsc 编译到 dist/（验证桶完整、幽灵导出）
```

详细命令与判定标准见 [testing.md](./testing.md)。

## 相关 ADR（决策真相源）

本包约定由以下 ADR 治理（spec 讲"怎么动手"，ADR 讲"为什么"）：

- `docs/adr/0005-agent-memory-is-isolated-by-team-and-agent.md` — memory 按 team/agent 隔离
- `docs/adr/0007-memory-write-authority-follows-evidence-and-scope.md` — memory 写权限随证据与 scope
- `docs/adr/0023-agent-acceptance-is-required-before-task-claim.md` — claim 前须 acceptance（task-claim 状态机前置条件）
- `docs/adr/0044-memory-visibility-follows-source-scope.md` — memory 可见性跟随来源 scope
- `docs/adr/0014-task-followups-use-evidence-graded-linking-and-revisions.md` — task followups 证据分级
