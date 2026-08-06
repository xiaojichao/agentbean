# 数据模型：投影表 / FK CASCADE / 跨库无 REFERENCES

## 何时适用

新建投影表、给频道挂审计/投影行、或处理 team_id 列时。`server-next` 的 SQLite 分 Global DB 与每 Team DB 两库，跨库不能建外键，这决定了 FK 的写法。

## 本地模式

### 双库结构

- **Global DB**：存 `teams` 等全局表（`migrations/global/`）。
- **Team DB**：存绝大多数业务表（`migrations/team/`），每个 team 一个库。

### 投影表（读模型）

三类投影表用于读路径优化与审计：

- `agent_memory_projections`：`migrations/team/0034_agent_memory_projections.sql`
- `system_activity_projections`：`migrations/team/0072_system_activity_projections.sql`（:4 建表）
- `channel_archives`：`migrations/team/0081_channel_archives.sql`（:11 建表）

### 挂在 channels 下的行：FK 必须 CASCADE

挂在 `channels` 表下的投影/审计行，外键**必须** `ON DELETE CASCADE`，否则频道硬删时被外键阻塞、删不掉（历史 bug）。

权威示例 `migrations/team/0081_channel_archives.sql`：

- `:8` 注释：`审计行随频道硬删级联（与投影表外键 CASCADE 惯例一致...）`
- `:14`：`channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE`

新加任何挂在 `channels`（或其它可能被硬删的父表）下的表，FK 一律 CASCADE。

### team_id 列无 REFERENCES（跨库限制）

Team DB 里的表通常有 `team_id` 列，但**不能**加 `REFERENCES teams(id)`，因为 `teams` 表在 Global DB，跨库 FK 在 SQLite 里不成立。

权威示例 `migrations/team/0034_agent_memory_projections.sql`：

- `:2` 注释：`team_id 不加 REFERENCES：teams 表在 Global DB，team 迁移在 Team DB，SQLite 无法跨库 FK`
- `:12`：`team_id TEXT NOT NULL,`（裸列，无 REFERENCES）

这意味着 team_id 的引用完整性靠应用层保证，不能靠 FK。

### 历史 RESTRICT bug

历史上曾有用 `ON DELETE RESTRICT`（或默认 RESTRICT）挂在 channels 下的表，导致频道删除事务因外键冲突失败、频道"删不掉"。修复方式即改回 CASCADE（如 team/0081 的显式注释）。新表不要重蹈覆辙。

## 佐证文件

- `/Users/shaw/AgentBean/apps/server-next/src/infra/sqlite/migrations/team/0081_channel_archives.sql`（:8 CASCADE 注释、:14 REFERENCES channels(id) ON DELETE CASCADE）
- `/Users/shaw/AgentBean/apps/server-next/src/infra/sqlite/migrations/team/0034_agent_memory_projections.sql`（:2 跨库注释、:12 team_id 裸列）
- `/Users/shaw/AgentBean/apps/server-next/src/infra/sqlite/migrations/team/0072_system_activity_projections.sql`（:4 建表）

## 反模式

- **挂 channels 的表用 RESTRICT/NO ACTION**：频道硬删被 FK 阻塞。
- **给 Team DB 表的 team_id 加 REFERENCES teams(id)**：建表直接报错（跨库找不到 teams）。
- **投影表不加 CASCADE 也不加索引**：删除级联失败 + 查询全表扫。
- **改 schema 不加迁移**：生产库不会变（见 migrations.md 静态注册）。

## 验证命令

```bash
cd /Users/shaw/AgentBean/apps/server-next
# 列出挂在 channels 且应 CASCADE 的 FK
grep -rn "REFERENCES channels" src/infra/sqlite/migrations/team/ | grep -v CASCADE
# 上面应无输出；若有输出说明缺 CASCADE
# 确认 team_id 没有非法跨库 REFERENCES
grep -rn "team_id TEXT.*REFERENCES teams" src/infra/sqlite/migrations/team/
# 上面应无输出
```
