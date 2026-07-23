# AgentBean 协作执行上下文

本上下文描述 AgentBean 中 PI Manager 与外部 Agent 协作执行的核心语言，避免 Phase 4 设计混用 Device、Server 与用户可见执行概念。

## Device Service

macOS 当前用户唯一的 AgentBean 后台系统服务，承载该用户全部已授权 Device Profile，并在终端退出或用户重新登录后继续提供设备能力。
_Avoid_: 每 Team Daemon、前台连接进程、系统级 root 服务。

## Device Profile

Device Service 中一份 Team 范围的本地连接身份与凭据；同一用户可以保存多个 Profile，由同一个 Device Service 统一运行。
_Avoid_: 独立系统服务、Team Daemon、历史邀请命令。

## PI Manager

AgentBean 内置的系统协调者，默认理解每一条人类频道消息，并决定是否忽略、回答系统问题、请求澄清、调用 Agent、创建或调整 Task。它不是 Team 成员，也不替代外部 Agent 完成用户领域工作。
_Avoid_: 普通聊天 Agent、仅用于复杂任务的 Manager、用户任务执行 Agent。

## Channel coordination decision

PI Manager 对一条人类频道消息形成的协作意图，决定消息应进入闲聊、系统回答、用户澄清、单 Agent 调用、Task 创建、Task 分解或既有 Task 修订中的哪条路径。形成该决策不等于创建 Task 或 ManagementRun。
_Avoid_: 每消息建 Task、直接 Dispatch、自然语言自动执行。

## Task allocation

PI Manager 为一个结构化 Task 选择定向指派或开放认领的协作决定；显式 @Agent 必须形成定向指派，多能力任务可以在分解后分别决定分配方式。
_Avoid_: Agent 争抢原始频道消息、所有任务统一抢占、PI 任意改写显式目标。

## Task offer

向具备所需能力和可见权限的外部 Agent 发布的结构化认领机会；多个 Agent 可以响应，但同一时刻只有一个 Agent 获得有效认领权。
_Avoid_: 原始聊天广播、重复 Dispatch、无约束抢答。

## Tracked task

由 PI Manager 为需要持续跟踪、异步等待、多 Agent 协作、明确交付或用户审核的请求创建的持久工作承诺。低风险且意图明确时可以自动创建；高成本、高风险、跨越隐私边界或意图不清时必须先请求用户确认。
_Avoid_: 每消息 Task、聊天记录别名、未经确认的高风险执行。

## Task creation gate

PI Manager 在创建 Tracked task 前对意图清晰度、持续跟踪需要、交付要求、成本、风险和权限边界进行的产品判断。不满足门槛的消息继续作为聊天或简单单 Agent 请求处理。
_Avoid_: 关键词触发、统一人工确认、模型无约束自动建单。

## Coordination message

PI Manager 以 AgentBean 系统协调身份发出的必要用户可见内容，包括澄清问题、紧凑的 Task 状态和注明贡献 Agent 与来源 Task 的最终汇总。它不是普通 Agent 消息，也不掩盖外部 Agent 原始交付的真实归属。
_Avoid_: PI 成员消息、伪装成外部 Agent、内部推理展示、冗长计划播报。

## Team-scoped Agent Memory

一个 Team 内关于特定外部 Agent 的职责、偏好和可复用经验；它由 `Team + Agent` 共同界定，同一个 Agent 在不同 Team 中拥有彼此隔离的协作记忆。
_Avoid_: 跨 Team Agent Memory、Agent 全局人格、Agent 私有 Session 历史。

## Device-local Agent Memory

归属于设备所有者、本地 Agent 与本地工作空间的记忆，不天然属于任何 Team。只有经过明确授权和最小化投影后，才能进入某个 Team 的协作上下文。
_Avoid_: Team Agent Memory、自动上传记忆、跨 Team 共享缓存。

## Reusable Experience Pack

从已完成项目的频道经验中整理出的、带来源、适用条件和排除条件的可复用知识单元。它保存在 Team Experience Library 中，但默认不进入任何频道上下文，只有显式关联后才可在目标频道使用。
_Avoid_: Team Memory、频道历史副本、自动跨频道记忆。

## Team Experience Library

一个 Team 保存 Reusable Experience Pack 的待复用知识集合；进入该集合不代表对所有频道生效，也不授予跨频道读取源内容的权限。
_Avoid_: 全局 Active Context、Team Memory 同义词、频道聊天归档。

## Experience Pack attachment

用户确认将一个 Reusable Experience Pack 用于目标频道的授权关系。关联可以撤销，PI 可以推荐关联，但不能静默创建关联。
_Avoid_: 自动继承、隐式复制、全 Team 广播。

## Explicit Memory

由用户明确要求记住、由已确认交付明确确定，或经用户确认复述后的正式记忆。它可以在原作用域内直接生效，并且必须提供可见提示和撤销能力。
_Avoid_: 模型推断、隐式偏好、未确认总结。

## Inferred Memory Candidate

PI 从对话、行为或多条事实中推断出的偏好、规律、评价或经验草稿；它在用户确认前不属于正式记忆，也不能影响后续协作决策。
_Avoid_: 自动生效推断、隐藏画像、正式 Memory。

## Memory scope expansion

使记忆进入比原来源更宽的可见或可用范围，包括跨频道、Channel 到 Team、Device-local 到 Team，或将特定 Agent 记忆提供给其他 Agent。PI 只能提出扩展建议，用户确认后才能生效。
_Avoid_: 自动晋升、隐式共享、来源权限继承替代复验。

## Active Memory Context

PI Manager 为当前消息或 Task 临时组合的最小相关记忆集合，由少量核心 Team Memory、当前频道相关记忆、已关联经验包和当前 Task 事实组成。Memory 的作用域决定能否检索，相关性与显式关联决定是否进入该集合。
_Avoid_: 全量 Memory prompt、Team Memory 全部自动注入、长期 Session 事实源。

## System Knowledge

由系统管理员维护并随产品版本治理的 AgentBean 功能、规则与安全知识。它不是 PI 从用户聊天中学习得到的 Memory，也不能被频道内容自动改写。
_Avoid_: AgentBean 全局记忆、Team Memory、模型自学习事实。

## User Memory

只描述当前用户自身稳定偏好和工作习惯、可在该用户有权访问的多个 Team 中使用的记忆。它不得包含任何 Team 的业务事实、频道摘要、客户数据、项目内容或其他用户信息。
_Avoid_: 跨 Team 业务记忆、用户画像仓库、Team Memory。

## Cross-Team business knowledge

源自一个 Team 的业务事实、项目经验或协作内容，并被提供给另一个 Team 的知识。AgentBean 默认不存在这种共享，只能通过未来显式的导出、共享与接收流程建立。
_Avoid_: AgentBean 全局记忆、同 owner 自动共享、Agent 携带共享。

## Memory governance access

Memory 的来源作用域决定谁可查看，作用域管理员决定正式审批、编辑与删除。Team Memory 对 Team 成员可见并由 Team Owner/Admin 管理；Channel Memory 对频道成员可见并由 Team Owner/Admin 管理，频道成员可纠错或申请删除；Team + Agent Memory 的公开投影由 Agent 所有者管理、Team Owner/Admin 决定本 Team 是否使用；User Memory 仅用户本人管理；System Knowledge 仅系统管理员管理。
_Avoid_: PI 管理员读取所有 Memory、普通成员直接改正式记忆、Agent 内部 Memory 浏览。

## Memory use explanation

当 Memory 实际影响 PI 回答、Task 分解或 Agent 选择时，向当前用户说明使用了哪些其有权查看的 Memory 与来源。解释必须遵守原始权限，不能为了可追溯性泄露其他 Channel、Team、User 或 Agent 未公开内容。
_Avoid_: 隐藏影响、全量 prompt 展示、越权来源引用。

## Channel Coordinator

默认运行在 AgentBean Server、负责每条人类频道消息理解与 Channel coordination decision 的 PI 能力。它不依赖用户 Device 在线，也不具备本地文件、shell、Workspace 或 Device-local Memory 能力。
_Avoid_: Manager Worker、聊天成员、Device Agent、外部任务执行器。

## Device-only coordination

Team 为隐私或本地模型需求选择的可选协调方式，Channel Coordinator 只在授权 Device 可用时工作。Device 离线导致的协调能力不可用必须向用户明确展示。
该能力不进入首个 PI MVP，当前设置页不展示 Device-only 选项。
_Avoid_: MVP placement、静默降级、Server 协调同义词。

## PI MVP placement

首个 PI MVP 中 Channel Coordinator 的唯一执行位置：AgentBean Server。全系统 Active PI Model 绑定一个 Server-hosted PI Provider Card 中的模型；Device Agent 继续承担本地文件、Workspace、Shell 和 Device-local Memory 等 Task 执行，不承担本次 MVP 的频道协调模型运行。
_Avoid_: Device-only coordination、Team placement 选择、Device Agent 被移除。

## Supported user device platform

AgentBean 当前对用户设备能力作出的平台承诺，仅包括 macOS，并同时覆盖 Apple Silicon arm64 与 Intel x64。Device Service、Agent 扫描与执行、本地文件访问、原生选择器、安装和升级不再为 Windows/Linux 新增实现或发布保证；现有跨平台代码可保留但不构成产品能力。Server 与 Web 继续运行在 Railway/Vercel 的云端环境，不受该终端平台限制。
_Avoid_: 仅 arm64、Rosetta 作为正式兼容、Server 必须运行在 macOS、Windows/Linux Device 承诺。

## Supported macOS architectures

AgentBean 用户设备首版必须原生支持 `darwin-arm64` 与 `darwin-x64`。两种架构都需要对应的可安装产物、签名/公证流程和真实启动及 Device 能力验证；不能用 arm64 单架构结论外推 Intel，也不能只要求 Intel 用户通过 Rosetta 运行。
_Avoid_: arm64-only、未经验证的 universal binary、Rosetta-only。

## Active PI Model

系统管理员从已发布 PI Provider Card 中选择一个 Model ID，形成全系统唯一生效的 PI 模型绑定。所有 Team 的实时协调、深度编排和 Memory 管理统一使用它，不能选择或覆盖，也不向 Team 或普通用户披露 Provider、Model、Endpoint 或切换历史；这些细节只对系统管理员可见。
_Avoid_: PI Runtime Profile、Team 模型选择、按 Team Provider、公开底层模型身份。

## PI Provider Card

系统管理员维护的一份完整 Server provider 配置，也是 PI Provider Supply 在 MVP 中的基本管理单元。它从预设或 Custom 创建，包含显示信息、协议、Endpoint、Credential 引用、可选模型目录、默认模型和经过校验的高级配置；支持复制、模型获取、生产同路径测试、备注与控制台链接。高级配置不作为默认入口，Credential 不向 Team 暴露。
_Avoid_: Provider Connection 与 Model Deployment 多层对象、Team 模型配置、可回显明文 Credential。

## PI Provider Card revision

PI Provider Card 的不可变 Draft 或 Active 配置版本。编辑已发布 Card 只产生 Draft；测试通过并由系统管理员发布后，新 revision 才可被 Active PI Model 使用。进行中的 Run 继续使用启动时固定的 Card revision；刷新模型目录不自动改变 Active PI Model 的 Model ID。
_Avoid_: 即时覆盖、运行中配置漂移、模型列表刷新即切模型。

## PI Provider Card advanced configuration

PI Provider Card 普通表单的受限 JSON 投影，而不是任意请求透传。MVP 只允许编辑 Schema 明确支持的 `baseUrl`、`endpointMode`、`modelId`、`timeout`、`maxOutputTokens` 和少量兼容参数；Credential 只显示不可编辑的引用。保存必须通过 Schema 与真实模型测试。
_Avoid_: 明文 Credential、OAuth、Shell 命令、环境变量插值、任意 Headers、任意 Request Body。

## PI Provider Protocol

PI Provider Card 与模型运行之间的传输协议。MVP 只实现 `openai_chat_completions`：Bearer API Key、OpenAI-compatible messages 与 tool calls，以及 `/chat/completions` 请求语义。Provider 预设可以有不同品牌名称，但只有通过该协议兼容性测试才能启用。
_Avoid_: Provider 名称推断原生协议、Anthropic Messages、OpenAI Responses、Gemini、Bedrock、OAuth。

## PI Provider Preset

用于快速创建 PI Provider Card 的系统内置默认配置。MVP 只提供 OpenAI、OpenRouter、DeepSeek 与 Custom OpenAI-compatible 四类；Preset 只填充显示信息、Base URL、Endpoint Mode 和已知兼容参数，不代表模型已经可用，仍需选择模型并通过真实 tool-call 测试。
_Avoid_: Provider 支持证明、庞大合作商目录、原生协议 Adapter。

## PI model discovery

PI Provider Card 使用当前 Endpoint 与 Credential 调用 Provider 的模型列表接口并让系统管理员选择 Model ID 的辅助流程。Provider 不支持发现接口时允许手工填写；发现结果变化不会自动改写 Active PI Model。
_Avoid_: 自动启用所有模型、模型池、运行时 fallback。

## PI model test

通过与生产 Management Model Adapter 相同的非流式请求与解析路径，对 PI Provider Card 中选定模型执行固定无业务数据的普通文本响应和完整 tool-call 回合，并验证鉴权、Model ID、响应格式、finish reason、usage、超时与取消。Card 可以保存为 Draft，但只有测试通过并发布后，其中的模型才能设为 Active PI Model。
_Avoid_: 只 ping Endpoint、使用真实业务消息、单独 Streaming/TTFB 测试、模型列表成功即视为可运行。

## PI token usage telemetry

每次 ManagementRun 从 Provider 响应中记录的 input/output Token 数量，只用于上下文增长、异常消耗和模型响应诊断。MVP 不由此计算金额、执行 Token 配额或自动停用；Provider 未返回 usage 时标记为“未知”，不阻止 Provider Card 发布。
_Avoid_: 费用、账单、Team 配额、伪造为零。

## PI degraded

Active PI Model 在有限同模型重试后仍不可用的显式全系统运行状态。频道消息继续保存和展示，但 PI 暂停自动建 Task、分解、认领和 Memory 写入；Team 与普通用户只看到 PI 正常、降级或不可用，不看到 Provider 或 Model 身份。MVP 不静默切换到其他模型。
_Avoid_: 消息发送失败、隐式跨模型 fallback、伪装成正常协调、静默丢弃自动化。

## PI Management

设置侧栏中与“团队”并列的一级产品区域。系统管理员在系统作用域管理 PI Provider Supply、Active PI Model、Rollout、治理和健康；Team Owner/Admin 在 Team 作用域只管理自动化、Memory、Agent coverage、限制与使用情况，不查看或选择底层模型。两种作用域不共享配置表单。
_Avoid_: Team 详情页内的 PI 表单、系统与 Team 混合保存、Provider 管理入口。

## PI Memory Center

PI Management 的 Memory 管理区域。系统作用域只维护 System Knowledge；Team 作用域集中展示并治理 Team Memory、Channel Memory、Agent Memory 投影、Memory Candidates 与 Reusable Experience Packs。频道和 Agent 页面只提供带当前作用域过滤的快捷入口；User Memory 位于个人设置。
_Avoid_: 独立顶级 Memory 产品、跨 Team 混合列表、Agent 内部 Memory 浏览器。

## Formal Memory

已在其作用域内生效、可以进入检索与 Active Memory Context 的版本化 Memory。授权角色可以直接创建或编辑 Formal Memory，不要求先由 PI 生成 Candidate；每次变更记录操作者、时间、来源和原因。停用后立即退出有效上下文，但不反向改写原频道消息或历史交付。
_Avoid_: PI Candidate 唯一入口、覆盖式编辑、停用即删除来源。

## Memory kind

Formal Memory 与 Memory Candidate 的固定 MVP 类型：`fact` 表示已确认事实，`decision` 表示已经作出的决定，`rule` 表示必须遵守的流程或约束，`preference` 表示非强制偏好。每条只保存类型、简短内容、作用域、来源、状态、创建/更新时间和可选失效时间；项目经验使用 Reusable Experience Pack。
_Avoid_: 自定义类型、知识图谱、实体关系、经验塞入单条 Memory。

## Memory conflict

同一作用域内新的 Formal Memory 与已有有效 Memory 可能互相矛盾的保存状态。PI 不自动覆盖或合并，授权管理者只选择由新 Memory 取代旧项并将旧项标记为 `superseded`，或确认二者同时保留；无法判断时新内容保持 Candidate，不影响有效上下文。
_Avoid_: 跨作用域复杂优先级、模型自动裁决、静默覆盖。

## PI Provider Supply

由系统管理员通过 PI Provider Cards 管理的 Provider、Credential、模型选择与健康供给。MVP 不包含模型池或自动 fallback；系统管理员指定全局 Active PI Model，所有 Team 零模型配置统一使用且不获知底层身份。
_Avoid_: Team 模型配置、Team Credential、Team 运行方案。

## PI Rollout State

系统管理员用于紧急停用、旁路评估或正式启用 Channel Coordinator 的系统运行状态。它是发布与故障控制，不属于 Team 的日常产品设置。
_Avoid_: Team PI 模式、自动化权限、placement。

## Team PI Automation Policy

Team 对 PI Manager 自动采取低风险协作动作的单一总开关“PI 自动协调”，默认开启，由 Team Owner/Admin 切换。开启时统一允许低风险建 Task、任务分解、发出 Task Offer、开放认领和生成 Memory Candidate；关闭时 PI 仍理解消息，但只建议或等待明确要求。高风险、不可逆和作用域扩大动作始终需要确认。
_Avoid_: 多个功能开关、direct/shadow/managed、关闭消息理解、Provider 配置。

## System PI Governance Boundary

系统管理员为所有 Team 设定的 Provider 供给、Active PI Model、安全、数据处理和紧急停用硬边界。任何 Team 角色都不能越过该边界。
货币成本治理不进入 MVP，首版只实现 Provider、全局模型、安全、数据处理与紧急停用边界。
_Avoid_: Team 配置、日常 PI 运营、默认偏好。

## Team PI Governance Ceiling

Team 所有者在系统边界内设定的数据可见范围与最高 Phase。Team 管理员可以在该上限内运营或收紧，但不能扩大它；Team Owner/Admin 都可以切换独立的“PI 自动协调”总开关。任何 Team 角色都不能查看、选择或覆盖 Active PI Model。货币成本属于未来能力，MVP 不提供相关字段。
_Avoid_: 系统全局边界、管理员日常选择、单次 Run 决策。

## Task-linked message

通过 Task 详情、Task 讨论串、回复 Task 系统消息或明确 Task 引用而与现有 Task 强绑定的用户消息。缺少强绑定时，PI 只能在高置信的小范围补充中自动建议关联，模糊或重大变更必须请求用户确认。
_Avoid_: 同频道自动归属、最近 Task 猜测、任意语义合并。

## Task revision

对已开始执行的 Task 目标、范围或验收要求所做的可追溯新版本。它保留旧要求与交付历史，并使受影响的旧认领、调用或验收失去当前效力，而不是原地覆盖。
_Avoid_: 编辑覆盖、隐藏变更、复用旧执行权。

## Artifact source root

一次 Agent 运行收集文件时采用的有边界来源目录，例如该 Run 的输出目录、Agent 工作目录或 Agent 配置的额外输出目录。频道成员只看到稳定的来源标签和根内相对路径；真实设备路径不构成公开身份，source root 及其相对路径也不能单独决定文件的业务角色。
_Avoid_: 无作用域绝对路径、项目产物类型、最终版目录。

## Artifact role

Agent 结果清单或 Server 授权流程为文件明确记录的协作角色，例如中间产物、普通运行产物或交付物。目录可以提供默认分类信号，但最终版必须由独立的人类确认或审核事实确定。
_Avoid_: 路径推断、文件名标签、`pathKind`、最终版指针。

## Run artifact

一次 Agent Run 从某个 Artifact source root 收集并保留来源路径的不可变文件。中间 Run artifact 在频道文件视图的“运行产物”下可供预览和下载，不能回写历史 Run。
_Avoid_: 普通消息附件、可变工作区文件、最终版。

## Channel file directory

频道文件视图根据 Artifact source root 和根内相对路径形成的导航层，只表示当前层级实际存在的文件与子路径。它不拥有独立权限或生命周期，空路径也不会被推断为真实目录。
_Avoid_: Agent 设备绝对目录、独立文件夹实体、递归文件平铺。

## Channel file index

Server 为一个频道维护的权威文件读模型，统一投影公开消息附件、交付物和允许公开的 Run artifact。它支持目录、分页、搜索、角色筛选和稳定排序，不能由浏览器已加载的消息临时推断。
_Avoid_: 聊天附件平铺、客户端消息缓存、内部日志。

## Channel archive

用户对频道所代表项目已经结束的权威声明，也是 PI 发起项目收尾、Memory 候选与 Reusable Experience Pack 建议的边界事件。它不依赖 PI 从静默时间或 Task 状态推测项目是否结束。
_Avoid_: 独立 Project 完成状态、静默超时、PI 自动判定项目结束。

## Channel archive gate

Channel archive 前对该频道全部非终态 Task、Invocation、claim、lease 和待审核交付进行显式收尾的事务边界。用户必须确认取消未完成工作，系统保留历史事实并停止归档后的新执行。
_Avoid_: UI 隐藏、后台继续执行、静默取消、跨频道搬迁 Task。

## Archived Channel Memory

Channel archive 后冻结的原频道记忆，只作为归档查看、审计和来源复验的只读历史，不再直接进入任何活跃频道的 Active Memory Context。此前已明确批准的 Team Memory 或 Reusable Experience Pack 投影不因归档自动失效。
_Avoid_: 可继续检索的 Channel Memory、删除的 Memory、自动跨频道来源。

## Agent Capability

Agent 通过对外契约声明自己当前可以接受的操作类型、输入输出、约束和可用状态。Task 的 `requiredCapabilities` 是候选资格的硬门槛，但 PI 只能使用 Agent 暴露的信息与 AgentBean 可观测的连接状态，不能检查其内部运行环境、工具或权限实现。
_Avoid_: Agent 内部权限、Agent Skill、相似任务经验、模型推断出的擅长领域。

## Agent Skill

Agent 通过对外契约主动声明、愿意用于任务匹配的专业方法能力。Task 可分别声明硬门槛 `requiredSkills` 和只参与排序的 `preferredSkills`；声明不代表 PI 知道该 Skill 是否安装、如何实现或依赖什么内部资源。
_Avoid_: Agent 内部 Skill 清单、Capability 标签、PI 猜测、一次成功执行自动生成的 Skill。

## Agent Exposure Manifest

由 Agent 或其适配器主动发布给 AgentBean 的结构化公开契约，包含愿意暴露的 Capabilities、Skills、版本、约束、可用状态和有效期。PI 只能据此做候选匹配，不得扫描 Agent 文件、核验内部依赖，或把未暴露的信息补入 Manifest。
_Avoid_: Agent 内部清单、PI 探测、永久有效缓存、自然语言自述。

## Team Agent Exposure

Agent 或 Agent 所有者向特定 Team 发布的 Agent Exposure Manifest 投影。PI 只能看到当前 Team 的投影；Team Owner/Admin 可以通过治理规则进一步禁用已暴露的操作，但不能扩大投影、查看其他 Team 的投影或要求 Agent 暴露内部信息。Channel 复用所属 Team 的投影，并由频道权限限制上下文与请求资格。
_Avoid_: 全局 Agent Skill 目录、Channel 独立 Skill 清单、Team 强制暴露。

## Manifest revision

一次 Team Agent Exposure 的不可变版本标识。Task Offer 同时固定 `taskRevision` 与 `manifestRevision`；相关 Capability 或 Skill 被撤回后，尚未接受的旧 Offer 失效。Agent acceptance 形成独立履约承诺后，Manifest 后续变化不自动取消该 Task。
_Avoid_: 活动 Task 配置、内部 Skill 版本、无版本覆盖更新。

## Claim relinquishment

Agent 在接受 Task 后明确声明无法继续履约并交还 claim 的协议事件。它触发 PI 重新规划、交接或失败处理；Manifest 改变本身不能替代 relinquishment。System/Team 的当前安全撤权可以越过该承诺并停止相关操作。
_Avoid_: 静默离线、Offer 拒绝、Manifest 撤回。

## Task Offer

PI 根据 Agent Exposure Manifest 向候选 Agent 发出的结构化协作请求，包含目标、输入、交付物、约束、required Capabilities、required Skills、时限和风险。Offer 不等于分配；Agent 可以接受、拒绝、请求补充信息或提出调整建议，只有明确接受后才产生有效 claim/lease。
_Avoid_: 强制指派、已认领 Task、原始频道消息广播。

## Agent acceptance

Agent 对一个仍有效的 Task Offer 作出的明确接受承诺，是 PI 将候选关系转换为正式 claim/lease 的必要条件。用户显式 `@Agent` 只决定优先询问对象，不能替代 Agent acceptance；Offer 超时或 Task revision 后，旧 acceptance 失效。
_Avoid_: Manifest 匹配、消息已送达、PI 单方面分配。

## Unknown Skill status

Agent 未暴露 Skill 维度、公开声明已过期或无法得到当前响应时的外部状态。PI 只能说“未声明”或“未知”，不能据此断言 Agent 内部没有该 Skill；需要该 Skill 的任务只能通过用户确认继续交给该 Agent。
_Avoid_: 未安装、内部缺失、模型猜测。

## High-risk Agent operation

根据 Agent 暴露的操作契约与 Task 预期效果，会产生高成本、敏感数据处理、外部副作用或不可逆结果的 Agent 请求。系统与 Team 治理的是 PI 是否可以发出该请求，而不是 Agent 内部如何安装、实现或授权 Skill。
_Avoid_: 管理 Agent 内部 Skill、安装即授权、PI 内部探测。

## Task Skill Requirement Resolution

PI 先分解任务，再将每个可执行 Task 与当前 Team 可见的 Agent Exposure Manifest 中真实声明的稳定 Skill ID 匹配。只有缺少某 Skill 就无法正确或安全完成时才写入 `requiredSkills`；只改善质量、速度或流程规范时写入 `preferredSkills`。PI 必须保留可见的匹配理由，歧义或会排除用户显式指定 Agent 时请求确认。
_Avoid_: PI 创造 Skill 名称、所有任务强制 Skill、质量偏好升级为资格门槛。

## Task Skill Coverage Plan

根 Task 所需 Skills 在任务树中的覆盖关系。根 Task 可以由多个 Agent 的 Skills 共同覆盖，但每个可执行子 Task 必须由一个同时满足该子 Task 全部 required Capabilities 与 required Skills 的 Agent 认领；PI 同时定义子 Task 间的输入、输出、依赖与验收。语义上不可安全拆分的工作不能只为适配现有 Agent 而强拆。
_Avoid_: 全能 Agent 要求、父 Task 直接认领、跨 Agent 拼接一个不可分割操作。

## Agent Experience Signal

来自当前 Team 内 Agent Memory 与可追溯执行历史的相似任务经验信号，只用于在合格候选之间排序，不能替代缺失的 required Capability 或 required Skill，也不得跨 Team 自动使用。
_Avoid_: Agent Skill、资格证明、全局 Agent 画像。

## Agent reliability signal

根据当前 Team 内可观测且已确认归因的 Task acceptance、完成、超时、claim relinquishment 和人工验收形成的按 Skill 或任务类型统计信号。它只参与候选排序与风险提示，不能修改 Agent Exposure Manifest；主观模型评价和未审核结果不得直接形成负面事实。
_Avoid_: 全局 Agent 评分、PI 能力裁决、自动删除 Skill、跨 Team 信誉。

## Team Agent operation restriction

Team Owner/Admin 基于治理规则或多次已确认失败，禁止 PI 在本 Team 请求某项已暴露 Agent operation 的限制。它只收紧 Team 的使用范围，不改变 Agent 的公开声明或内部状态，并必须向 Agent 所有者展示依据和提供错误归因纠正入口。
_Avoid_: 修改 Manifest、封禁 Agent 内部 Skill、系统全局信誉处罚。

## Agent Exposure Management

Agent 所有者在 Agent 管理界面维护该 Agent 面向各 Team 的公开 Capabilities、Skills 与约束的产品边界。PI 管理界面只读取这些投影，展示 Skill coverage、匹配理由、可靠性和 Team Agent operation restriction，不提供内部 Skill 的安装、编辑、启停或复制功能。
_Avoid_: PI Skill 管理器、Team 修改 Agent 供给、内部 Skill 浏览器。

## Agent eligibility

PI 根据 Task 的 required Capabilities 与 required Skills 对 Agent 的公开声明做候选过滤，再使用 preferred Skills、Team 内经验、负载和可用性排序的判断结果。该判断只表示“根据当前暴露信息是否适合请求”，不证明 Agent 内部真实实现。用户显式 `@Agent` 但其未声明必要 Skill 时，PI 必须提示并请求决定，不能静默改派或断言该 Agent 不会。
_Avoid_: 只按 Agent 名称认领、Skill 与 Capability 混用、经验直接授予资格。

## Manager Worker

负责驱动一次 ManagementRun 的 PI Manager 执行单元，可以运行在用户授权的 Device 上，也可以运行在 AgentBean Server 的受控环境中。
_Avoid_: Agent、普通执行 Agent、Daemon。

## Device Worker

运行在用户授权 Device Service 中的 Manager Worker，能够使用 Device-local credentials 和 local-only context。
_Avoid_: local Agent、Daemon Worker。

## Server-hosted Worker

运行在 AgentBean Server 受控环境中的 Manager Worker，只能使用明确允许进入 Server 的上下文与凭据引用。
_Avoid_: cloud Agent、remote Device。

## Placement

一次 ManagementRun 对 Manager Worker 执行位置的明确选择；Phase 4 第一阶段只开放受控 `managed` placement，`auto` 仍不进入生产默认路径。
_Avoid_: routing、failover（除非明确指 lease 接管）。

## Server-authorized context

允许 Server-hosted Worker 使用的、严格继承发起用户当前 Team/Task/Channel 权限后的上下文；私聊和私有频道可以进入，但不得向原 scope 外扩散。它不包含 Device-local Memory、cwd、local files、Device token 或本地模型凭据。
_Avoid_: full Team context、Device context、shared secret。

## Server credential reference

由 Server 管理、可撤销且不把 secret material 写入 ManagementRun、Event 或 checkpoint 的 provider 凭据引用。
_Avoid_: API key、Device credential、auth token（除非讨论 secret material 本身）。

## Lease takeover

原 Manager Worker 的租约过期后，由另一合法 Worker 以更高 fencing token 接手未完成的 ManagementRun；已完成的事实不重做，未完成部分从 Server checkpoint 继续。
_Avoid_: forced takeover、duplicate retry。

## Managed opt-in

Team owner/admin 显式开启后，Team 才允许使用 Server-hosted Worker；默认不启用，普通成员不能通过单次请求绕过 Team 设置。
_Avoid_: implicit managed、member-level placement override。

## Deployment-managed provider credential

第一阶段由部署方预先配置、Server 统一管理的一套 provider credential；Team 只能使用其引用，不能上传、读取或替换 secret material。
_Avoid_: Team API key、raw credential、Device credential。

## Managed task

需要持续跟踪、交付审核或多 Agent 协作，并具有明确根 Task 的复杂请求。普通聊天和简单单 Agent 请求会经过 Channel coordination decision，但不属于 Managed task。
_Avoid_: every chat、direct dispatch、background retry。

## User-delegated Server Worker

Server-hosted Worker 不拥有独立 Team 成员身份，而是作为发起用户在单个 ManagementRun 内的受限代理；每次读取都绑定并复验 `userId + managementRunId` 的当前权限。
_Avoid_: global Server member、permanent worker identity、ambient authority。

## Managed content consent

用户开启 `managed` 即同意本次 ManagementRun 将完成任务所需的、其当前有权限看到的最小内容发送给 Server provider；该内容不因此成为长期 Memory，也不得扩散给无关 Agent。
_Avoid_: blanket consent、long-term retention、cross-scope broadcast。

## Managed unavailable

`managed` 请求在 Server provider/Worker 不可用时等待或失败，不自动切回 Device；placement 一旦确定，不能因故障改变隐私边界。
_Avoid_: silent fallback、cross-placement retry。

## Managed capacity

Server Worker 使用固定并发上限；容量满时 ManagementRun 排队，超过等待上限后失败，不进行动态成本或价格调度。
_Avoid_: unbounded queue、implicit cost optimization。

## Server Manager runtime

Server Worker 复用现有 PI management runtime，只提供模型协调与受控工具协议，不具备 shell、cwd、文件读写、浏览器或 Device 能力。
_Avoid_: second runtime、server shell、remote Device。

## Managed queue timeout

Server Worker 满载时，ManagedRun 最多等待 5 分钟；期间无可用 Worker 则失败并明确告知用户，不无限排队。
_Avoid_: infinite queue、silent drop。
