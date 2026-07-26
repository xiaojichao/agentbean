---
status: accepted
---

# 项目阶段依赖由 Stage edge 承载，并只镜像自己写入的 canonical 依赖

## 背景

#822 要求「每条 Stage edge 与对应 Task dependency 在同一事务中创建或删除，不产生两套依赖事实」。

但既有 canonical Task dependency 表 `task_dependencies`（migration 0013）的两个外键都指向 `task_coordinations(task_id)`，而 `task_coordinations.management_run_id` 是 `NOT NULL` 且引用 `management_runs(id)`。这意味着它只接纳属于某次 PI management run 的 Task。#821 的 ProjectStage 绑定的是**普通频道 Tracked task**，这类 Task 没有 coordination 行，因此在 `PRAGMA foreign_keys = ON` 下写入 `task_dependencies` 会直接触发 `FOREIGN KEY constraint failed`。

放宽该外键需要在 SQLite 中重建 `task_dependencies` 并丢失 `ON DELETE CASCADE` 到 `task_coordinations` 的清理语义，属于对 Phase 2 机制的破坏性改动，与父规格「迁移只做 additive schema」相冲突。

## 决定

`project_stage_edges` 行是频道项目阶段依赖的唯一权威事实，同时承载项目语义与必需输入规则。

当且仅当上下游 Task 都拥有 canonical `task_coordinations` 行、且 canonical 依赖尚不存在时，创建 Stage edge 会在**同一事务内**追加一条 `task_dependencies` 行，并把 `project_stage_edges.mirrored_task_dependency` 置为 1；删除该 edge 时在同一事务内成对撤销。

若 canonical 依赖已由 PI 分解写入，本机制不认领其所有权（`mirrored_task_dependency = 0`），删除 Stage edge 时不会销毁不属于自己的依赖事实。

阶段投影只为同一依赖事实产出一条阻塞原因：被 Stage edge 覆盖的 `dependency_incomplete` 由边派生的 `stage_dependency_incomplete` 取代，避免界面出现重复解释。

## 结果

依赖事实在两个世界都保持单一且原子：普通频道阶段只有 edge 行；PI 协调的阶段则 edge 与 canonical 依赖同生共死。Phase 2 的 schema 与清理语义不受影响。

代价是普通频道阶段的依赖不会出现在 `task:dag` 视图中——该视图本身只投影 management run 的 DAG，属于既有边界，不是本决定引入的缺口。
