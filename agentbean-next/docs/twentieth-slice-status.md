# 第二十切片实现状态

本文记录 AgentBean Next 第二十切片当前已经落地的 server-next SQLite dev storage 模式。

## 已实现

- `apps/server-next`
  - `parseServerNextDevConfig` 增加 `storage` 与 `dataDir`。
  - 支持 `AGENTBEAN_NEXT_STORAGE=memory|sqlite`、`AGENTBEAN_NEXT_DATA_DIR`、`--storage` 与 `--data-dir`。
  - `storage: "sqlite"` 时会在 `dataDir` 下创建 `global.sqlite` 与 `team.sqlite`。
  - dev server 会自动运行 global/team migrations。
  - migration runner 增加 `schema_migrations` 表，避免重启时重复执行 `CREATE TABLE`。
  - server close 时会关闭 SQLite handles。
- 根 workspace
  - 增加 `npm run dev:server-next:sqlite`，用于启动带文件持久化的 server-next preview。

## 已验证

覆盖范围：

- dev config 能从 args/env 解析 `storage` 与 `dataDir`。
- 使用 SQLite 文件模式启动 server-next 后，注册用户会写入磁盘。
- 关闭 server，再用同一 `dataDir` 重启后，可以登录同一个用户并恢复 current team。
- 完整 phase tests、packages build 与 preview smoke 均保持通过。

本地命令：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run dev:server-next:sqlite
```

默认数据目录：

```text
.agentbean-next/
```

## 暂未实现

这些不属于第二十切片：

- 每个 team 独立 SQLite 文件或多 team storage manager；当前 preview 使用一个 `team.sqlite`。
- production deploy 切换到 server-next。
- 后续第二十一切片已补上一条命令启动 server-next 与 daemon-next 的 full local preview launcher。
- 真实 Codex/Claude/Gemini 交互式 adapter 仍在后续切片。
