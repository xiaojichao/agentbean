---
status: accepted
---

# 历史文档包回填只分组能证明的输出，且不新增第二条建包路径

## 背景

#830 要求为历史 Markdown 输出补建 ProjectDocumentBundle，同时明令「不从文件名、目录、mime、TaskStatus 或聊天文字猜测」，并要求「歧义数据保持不变」。

#825 的建包语义把一次 Workspace Run 的多份 Markdown 冻结为固定成员的包。它的成员资格判定依赖 ChannelDocument revision 的 `derivationSource`，而不是正文 Artifact —— 正文是 derive/save 每次新建的上传件，不保留原始 Run 的路径与角色。

回填与交互建包有一处关键差异：交互路径由**人**当场断言「这些文档就是那一次输出」，回填没有这个断言。因此凡是人可以凭上下文消解、而机器只能靠推测的地方，回填都必须止步。

另有一个容易踩空的事实：`derivationSource` 会被后续 revision **继承**。一份被人工改写过的文档，其当前 revision 的 `source` 是 `edit`，但 `derivationSource` 仍指向原始 Run。只看 `derivationSource` 判「这是不是那次 Run 的产物」永远为真，漂移检测会全程空转。

## 决定

**分组单位是 Workspace Run，判定单位是「可证性」。** 一次 Run 只有在满足全部条件时才成包：频道存在且未归档、Run 记录存在且经 handoff 判定为公开交付（非内部 Invocation）、来源 Invocation 的 Task revision 未被取代、可证成员至少两份，且每份都通过 #825 既有的成员资格判定。

**「仍是这次 Run 的产物」= 当前 revision 的 `derivationSource` 指向该 Run **且** `source = 'run'`。** 只要有任何一份曾派生自该 Run 的文档不再满足这一条（被人工编辑、恢复，或改由另一次 Run 派生），整次 Run 判为歧义并保持未分组 —— 不做「丢掉存疑的那份、把剩下的凑成一个包」的降级，因为漂移意味着这次输出到底有几份本身已不可知。

**回填不是第二条建包路径。** apply 模式一律调用 `createProjectDocumentBundle` 写入，归档、来源公开性、Invocation fence、成员资格与幂等都由既有用例再复验一次。回填自身没有身份，只借用一个在该频道本就有权建包的既有身份（频道创建者 → 项目负责人 → Team owner，取第一个仍是 Team 成员者），因此它永远建不出真人建不出的包，也不需要任何权限豁免路径。

**dry-run 的裁决必须等于 apply 的裁决。** 两种模式跑同一段预检，且预检调用的是用例内部使用的同一批只读判定函数（`isPublicWorkspaceRun`、`loadProjectDocumentBundleCandidate`、`resolveProjectDocumentBundleSource`）；dry-run 只是在最后一步不写库。为此这些函数从 usecases 导出 —— 共享真相比另写一份 SQL 复刻便宜得多。

包名与幂等键都只由 `runId` 推导，成员顺序取文档创建时间的稳定序。命名与排序都不得成为「从文件名反推结构」的入口，同时保证任何一次重试的请求指纹完全一致。

## 结果

历史数据宁可缺少项目语义，也不制造错误事实：来源不明、成员漂移、跨频道声称、内部 Invocation、归档频道与不可见文档全部保持未分组，并在逐候选裁决记录里留下稳定原因码。

回填可分批、可暂停、可恢复：游标只推进到「连续成功」的最后一个候选，中途出错就地停批，下一轮从出错的那一个重新开始；裁决本身幂等（已有 Bundle 直接短路，幂等键兜底），重跑安全。报告只含 ID、原因码与计数，可随运维指标端点一起暴露。

代价是覆盖率保守：一次 Run 只要有一份产物事后被人编辑过，整次输出就不会成包。这是刻意的取舍 —— 这些数据仍可由人在界面上显式建包，而错误的历史分组无法被同样廉价地撤销。

关闭回填开关只是不再产生新的裁决：既有 Bundle、#770 文件库读路径与 Markdown 编辑一律不受影响，没有任何回退动作。
