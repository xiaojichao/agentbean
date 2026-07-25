-- #798 PI server 接线切片 1：拆解 gate 的 requiredSkills 与 atomicityHint 持久化。
-- 对应 domain task-coverage-policy / task-decomposition-policy（已合 91cbff4c / #715）。
-- team_id 不加 REFERENCES：teams 在 Global DB，team 迁移在 Team DB，SQLite 无法跨库 FK
--   （同 0036 task_offers / team_pi_policies / agent_exposure_manifests 惯例）。
--
-- AC#1：required_skills_json 持久化子 Task 的 required Skills（#715 Phase2SubtaskDraftV1
--   已声明，kernel createSubtasks 拆解时写入），供 evaluateSkillCoverageUnion 在
--   createSubtasks gate 校验「子 skills 并集联合覆盖根 requiredSkills」。nullable：
--   既有行（未声明 skills）为空，kernel coverage gate 用 required_capabilities_json
--   兼任兜底（ADR 0018 当前 Capability/Skill 兼任，向后兼容，严格拆分留后续）。
-- AC#4：atomicity_hint 持久化「该 Task 在语义/安全/事务上是否可拆分」（create_subtasks
--   输入，parent 级）。nullable：默认 decomposable；atomic 的工作由 kernel gate 拒绝
--   （TASK_NOT_DECOMPOSABLE，不为适配现有 Agent 强拆，ADR 0021）。
ALTER TABLE task_coordinations ADD COLUMN required_skills_json TEXT;
ALTER TABLE task_coordinations ADD COLUMN atomicity_hint TEXT;
