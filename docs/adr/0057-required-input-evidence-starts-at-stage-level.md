---
status: accepted
---

# 必需输入的满足证据从阶段级起步

## 背景

#822 要求 Stage edge 能配置「必需输入规则」，并在依赖或必需输入未满足时由执行门禁阻止新的 claim/Invocation。

但可以精确指向具体产物版本的能力属于后续切片：逻辑产物集合与版本来自 #823，Markdown 文档包来自 #825，把冻结选择物化给 Agent 的 InputSet 来自 #827（且 #827 被 #822 阻塞）。在 #822 落地时，仓库里既没有项目产物集合，也没有把 Artifact 归属到某个 Task 的链路（`artifacts` 表只关联 message/dispatch/workspace_run）。

若把「必需输入」定义为必须指向具体产物版本，则本切片的门禁将永远无法满足，AC5 要求的「满足后无需人工修复内部状态即可继续」也就无法成立。

## 决定

必需输入规则在 Stage edge 上以**声明式**形式保存：`{ key, kind: 'artifact' | 'document', label }`。它描述下游阶段需要从上游阶段获得什么，不指向具体文件。

满足证据在本切片为**阶段级**：上游阶段绑定的 Task 已进入 `done`/`closed` 且其 canonical 审核结论不是 `rejected`/`needs_human` 时，该边声明的必需输入视为就绪。上游未交付时逐项产出 `required_input_missing`；上游已交付但被否决时产出 `stage_dependency_unaccepted`。

门禁是对权威事实的**纯投影**，每次调用重新计算，不保存任何需要人工清理的阻塞状态位。

未知 `kind` 一律 fail closed 拒绝，不做静默降级。

## 结果

依赖的阻塞与解除阻塞在本切片即可端到端验证，且解除只依赖上游交付这一权威事实。

后续切片细化证据时，只需替换 `resolveSatisfiedRequiredInputKeys` 一处证据解析：领域门禁函数 `evaluateProjectStageExecutionGate` 已按「已满足的输入 key 集合」建模，投影与契约无需改动。#823 可把阶段级证据换成已通过/final ArtifactVersion，#827 可据同一规则物化 InputSet。
