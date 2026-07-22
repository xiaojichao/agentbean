// AUTO-GENERATED from CHANGELOG.md by scripts/gen-changelog.ts — do not edit.
import type { Release } from './changelog';
export const releases: Release[] = [
  {
    "version": "Daily 2026-07-22",
    "date": "2026-07-22",
    "sections": [
      {
        "type": "Added",
        "items": [
          "实现 Team Agent Exposure 发布与消费（#710）",
          "【PI MVP 03】Provider 模型发现、生产同路径测试与发布"
        ]
      },
      {
        "type": "Changed",
        "items": [
          "提交 PI MVP 设计文档：架构决策与词汇表（#699）",
          "实现 PI 协调系统消息可操作字段（#708 切片 B 收尾）",
          "#707: 补全 Decision superseded 生命周期状态（AC#8）",
          "实现 Team PI 自动协调 Web 开关（#707）",
          "实现 Team PI 自动协调开关与完整 Decision Gate（#707 服务端核心）",
          "实现 Server Channel Coordinator 无副作用理解链路（#706）",
          "实现 Message 与 Coordination Job 原子入队（#705）",
          "实现全局 Active PI Model 与公开健康状态（#746）",
          "补充项目任务与文件管理架构设计",
          "记录 2026-07-21 每日更新日志"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "修复自更新回滚与 Device Service 恢复误判"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-21",
    "date": "2026-07-21",
    "sections": [
      {
        "type": "Changed",
        "items": [
          "为频道 Agent 失败/超时提供确定性中文提示",
          "记录 2026-07-20 每日更新日志"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-20",
    "date": "2026-07-20",
    "sections": [
      {
        "type": "Changed",
        "items": [
          "daemon 发版 0.3.16：对齐 pi-management-runtime 0.1.3 导出",
          "记录 2026-07-19 每日更新日志",
          "【PI MVP 02】系统管理员创建 PI Provider Card Draft"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "移除 update-cli 注释中的 PI 包名以通过边界检查",
          "agentbean update 不再 --ignore-scripts，修复 UPDATE_RECOVERY_REQUIRED",
          "探测 node 并注入 PATH，修复 pnpm codex exit 127",
          "LaunchAgent 下注入登录 shell PATH，修复 codex exit 127",
          "daemon 发版 0.3.15：将 #738/#739 修复推到 npm latest",
          "加固 codex PTY 对 node-pty #850 的恢复",
          "修复 Codex 缺失 CRS_OAI_KEY 等环境变量时的可操作失败提示",
          "修复 Phase 2/3 下普通 Agent 提及被误判为根任务",
          "修复频道提及 Agent 时的消息发送失败"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-19",
    "date": "2026-07-19",
    "sections": [
      {
        "type": "Added",
        "items": [
          "新增 macOS AgentBean 自更新命令（#698）"
        ]
      },
      {
        "type": "Changed",
        "items": [
          "【PI MVP 01】共享 OpenAI-compatible Management Model Adapter",
          "让 macOS 设备连接自动交接给 Device Service",
          "在设备页提供 macOS Daemon 升级命令提示（#726）",
          "收敛 macOS Device Service 最小可用版本",
          "实现 Linux systemd 用户级 Device Service",
          "实现 Legacy Daemon 显式迁移与运行时 fencing",
          "实现 macOS Device Service 幂等安装、卸载与数据保留",
          "实现统一 Device CLI 与 macOS LaunchAgent 适配器",
          "实现 Device Service Host 与两阶段排空",
          "冻结 Phase 5A Device Service 实现规格",
          "记录 2026-07-18 每日更新日志"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "完成 Phase 5A macOS 生命周期与恢复验收"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-18",
    "date": "2026-07-18",
    "sections": [
      {
        "type": "Changed",
        "items": [
          "Phase 4 第二阶段：Run 用量可见性（#649）",
          "记录 2026-07-18 每日更新日志",
          "Phase 4 第二阶段：Team 预算配置（#648）",
          "Phase 4 第二阶段：auto placement 决策（#647）",
          "daemon 发版 0.3.11：fs:list 目录浏览能力到达设备",
          "fs:list 目录浏览切片5：门控从身份切换到能力（#640）",
          "Phase 4 第二阶段：Web placement 配置面（#646）",
          "fs:list 目录浏览切片4：浏览器树形目录选择器（#639）",
          "docs：Phase 4 第二阶段 placement 策略规格草案（auto + 预算 + Web 配置面）",
          "记录 2026-07-17 每日更新日志"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "修复 auto placement 两条 follow-up（#657/#658）",
          "修复 Run 用量计数口径与 enforcement 对齐（#660/#661）"
        ]
      },
      {
        "type": "Security",
        "items": [
          "fs:list 目录浏览切片3：daemon 安全闸（#638）"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-17",
    "date": "2026-07-17",
    "sections": [
      {
        "type": "Changed",
        "items": [
          "fs:list 目录浏览切片2：授权收紧验收测试与错误码对齐（#637）",
          "fs:list 目录浏览切片1：端到端骨架（#636）",
          "Phase 4：Managed Worker 端到端收口 (#628)",
          "docs：Phase 4 协作执行上下文术语表",
          "Phase 4：实现跨 Host Recovery 与旧 Worker 隔离",
          "Phase 4：完成 Managed Placement Server 调度闭环",
          "记录 2026-07-16 每日更新日志",
          "Phase 4：实现 Server Worker 注册与固定容量（#630）"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "修复 handoff 结果与收尾边界"
        ]
      },
      {
        "type": "Security",
        "items": [
          "Phase 4：Server Worker 用户代理权限与私密 Scope 审计 (#626)"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-16",
    "date": "2026-07-16",
    "sections": [
      {
        "type": "Added",
        "items": [
          "发布：补发 V3 Worker 与 Memory tools npm 包",
          "Phase 3：补齐 P3-15 来源失效 E2E 闭环测试（spec §16.4）",
          "Phase 3：补齐 V3 capability 与工具协议门禁（P3-09 slice 2b）"
        ]
      },
      {
        "type": "Changed",
        "items": [
          "Phase 4：扩展 Manager lease 的 Device 与 Server Host 合同",
          "完成 Phase 3 生产验收证据收口",
          "docs：AGENTS.md 加 Codex PR review 节制契约",
          "docs：checklist 补 daemon --team-id（实战踩坑）",
          "收口 Phase 3 跨 Agent Memory 真实验收",
          "docs：Phase 3 环境验证 checklist（P3-17 真实 Agent + P3-18 生产 smoke）",
          "docs：归档 PR review/merge 周期分析（#607–#616）",
          "Phase 3：P3-17 跨 Agent Memory smoke 脚本（代码链路验证）",
          "交付协作与本地 Memory Web 治理面",
          "Phase 3：补全 propose_candidate 工具 run context（P3-09 slice 2c-step2 prep）",
          "Phase 3：闭合 handler 接线缺口并收紧来源授权（#609）",
          "优化 PR 快速收口并清理 OMX 文案",
          "合并 Server Capsule 与 Device 本地 Memory 运行时上下文",
          "Phase 3：Phase 3 Memory 工具请求合同层（P3-09 slice 2a）",
          "记录 2026-07-15 每日更新日志",
          "Phase 3：建立 Memory 工具定义与严格输入边界（#603）"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "Phase 3：接通 Capsule checkpoint 恢复校验并保留 Candidate 缺口",
          "修复：贯通 V3 Worker 与 Memory tools（#614）"
        ]
      },
      {
        "type": "Security",
        "items": [
          "Phase 3：贯通 worker Memory handler 与安全配置层",
          "修复 Memory 治理合并后的权限边界"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-15",
    "date": "2026-07-15",
    "sections": [
      {
        "type": "Added",
        "items": [
          "支持在讨论串中继续提及频道成员",
          "Phase 3：补齐剩余 Memory 来源失效入口",
          "实现 Phase 3 Server 持久化",
          "增加 PR 最新 Review 合并门禁"
        ]
      },
      {
        "type": "Changed",
        "items": [
          "Phase 3：完成 Capsule 与 Invocation/checkpoint 绑定（#602）",
          "Phase 3：实现并加固 Memory Candidate 生命周期（#583）",
          "实现串行多 Agent 协作与结构化交接",
          "Phase 3：建立 Candidate 持久化地基并收紧决策状态约束（#600）",
          "Phase 3：Capsule ref 持久化地基（P3-08 slice 1）",
          "Phase 3：实现 Capsule 注入复验并共享哈希源（P3-07）",
          "Phase 3：实现最小 Capsule 创建并收紧授权边界",
          "Phase 3：实现来源失效处理，收尾 Task 3",
          "Phase 3：实现协作 Memory 用例层（CRUD、状态机与显式共享）",
          "增加 Codex Session 级 Issue 认领门禁",
          "增加 Draft 稳定 Head Review 门禁",
          "记录 2026-07-14 每日更新日志",
          "冻结 Phase 2 最终 Green 验收",
          "将 Phase CI 收敛为单轮测试与构建"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "修复 Daemon 升级时的连接命令引导"
        ]
      },
      {
        "type": "Security",
        "items": [
          "Phase 3：实现 Device 本地 Memory 安全积累核心",
          "Phase 3：实现权限优先的 Memory 检索与排序",
          "Phase 3：冻结跨 Agent Memory 合同与权限边界"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-14",
    "date": "2026-07-14",
    "sections": [
      {
        "type": "Added",
        "items": [
          "发布包含 Phase 2 Worker runtime 的 daemon",
          "补齐 Phase 2 灰度策略与 Task DAG 界面",
          "接通 Phase 2 Invocation claim authority"
        ]
      },
      {
        "type": "Changed",
        "items": [
          "完成 Phase 2 双 Agent 垂直链路收口",
          "改名时迁移历史 @提及（旧消息跟随改名）",
          "结构化 @提及：改名后消息提及跟随显示新名（关联 agentId）",
          "实现子任务交付证据与经理验收闭环",
          "实现 Task Claim Broker 与开放认领协议",
          "记录 2026-07-13 每日更新日志",
          "实现 Phase 2 Task Coordination Kernel"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "修复生产浏览器烟测的频道状态时序",
          "修复结构化提及的身份与迁移边界",
          "让 Task DAG browser smoke 绑定默认频道",
          "统一 Dispatch 发射失败的恢复路径",
          "补齐 Phase 2 任务恢复与根汇总闭环",
          "修复 Agent 改名后频道消息仍显示旧名（#546）",
          "修复 Phase 2 Task 协调 review 问题",
          "恢复 Phase 1 Task graph 护栏",
          "实现 Phase 2 Task tools 与 Worker 恢复",
          "修复 AgentOS 托管型 Agent 改名后被扫描还原（#537）"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-13",
    "date": "2026-07-13",
    "sections": [
      {
        "type": "Added",
        "items": [
          "让 Device 发布物能够独立承载 Phase 1 PI runtime"
        ]
      },
      {
        "type": "Changed",
        "items": [
          "实现 Phase 2 Task coordination 持久化与原子事务",
          "冻结 Phase 2 Task DAG 与团队认领 Domain 规则",
          "建立 Phase 2 门禁与 V2 管理合同",
          "制定 Phase 2 Task DAG 与团队认领实施计划",
          "完成 Phase 1 Node 24 验证收口",
          "实现 Phase 1 managed 单 Agent 垂直链路",
          "实现 Phase 1 Team policy 与管理路由",
          "实现 Phase 1 Worker transport 与设备调度器",
          "实现 Phase 1 Invocation Gateway",
          "实现 Phase 1 Server Collaboration Kernel",
          "实现 Phase 1 management 原子持久化",
          "先冻结 Worker 租约协议以阻止旧管理进程越权",
          "记录 2026-07-12 每日更新日志"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "修复私有频道中文改名失效",
          "实现 Phase 1 Device WorkerHost 与持久恢复"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-12",
    "date": "2026-07-12",
    "sections": [
      {
        "type": "Added",
        "items": [
          "让主线只维护可验证发布的 AgentBean Next"
        ]
      },
      {
        "type": "Changed",
        "items": [
          "先冻结 Phase 1 的可靠调用边界再开放 managed",
          "固化 Phase 0 验收事实以允许进入 Phase 1",
          "Phase 0 PR 5：接入 root CI 聚合门禁",
          "Phase 0 PR 4：验证 PI Management Runtime 的三平台 SEA 兼容性",
          "守住 Phase 1 接线前的现有执行事实",
          "为 Phase 1 冻结可审计的管理边界",
          "让 AgentBean 按需使用工程技能而不增加默认流程负担",
          "让 Phase 0 先证明 PI 边界再进入运行时实现",
          "让 Phase -1 完成状态只由生产证据决定",
          "让工程 skills 遵循仓库统一协作约定",
          "统一连续消息的 15 秒批次与单次回复语义",
          "记录 2026-07-11 每日更新日志"
        ]
      },
      {
        "type": "Security",
        "items": [
          "让 PI 管理运行时先受安全边界约束",
          "补记 Release A 生产观察并收紧安全恢复合同（#480）"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-11",
    "date": "2026-07-11",
    "sections": [
      {
        "type": "Changed",
        "items": [
          "让 Release A 状态反映真实生产观察证据",
          "确保 Agent 连续消息在并发与交错场景下全部被消费",
          "阻止设置页把 Team 操作发送到旧上下文（#476）",
          "让 Release A 状态只由真实生产证据决定",
          "统一 Phase -1 Release A 的 Team 术语与迁移合同",
          "记录 2026-07-10 每日更新日志"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "避免频道创建落入旧 Team（#475）"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-10",
    "date": "2026-07-10",
    "sections": [
      {
        "type": "Added",
        "items": [
          "让阶段完成证据只能来自已经发布的事实"
        ]
      },
      {
        "type": "Changed",
        "items": [
          "让接管与修订始终复用不可变的管理意图",
          "先固定 Team 术语切换的实施与验收边界",
          "先清除术语债务再引入新的管理内核",
          "消除会误导后续实现的旧空间模型",
          "让连续补充消息在 dispatch 与时间线中按组处理",
          "放宽 Agent 连发消息的人工输入窗口",
          "记录 2026-07-09 每日更新日志"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "避免管理链路在陈旧状态或授权撤销后继续执行",
          "让管理运行在副作用、验收与恢复边界上可落地",
          "避免将内部管理推理与用户任务执行混为一体"
        ]
      }
    ]
  },
  {
    "version": "Daily 2026-07-09",
    "date": "2026-07-09",
    "sections": [
      {
        "type": "Added",
        "items": [
          "发布 daemon-next 0.3.4：透传 claude-code 失败时的 stderr",
          "发布包含 OpenClaw 失败诊断的 daemon 版本"
        ]
      },
      {
        "type": "Changed",
        "items": [
          "让连续消息赶上 Agent 派发窗口",
          "让 Agent 一次接住连续补充消息",
          "透传 claude-code 失败时的 stderr 到回复体",
          "让更新日志更贴近参考产品的可扫描形态",
          "阻止 OpenClaw 健康警告进入聊天回复",
          "让设置页更新日志每天自动刷新"
        ]
      },
      {
        "type": "Removed",
        "items": [
          "移除无本机设备身份的全局告警"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "防止远程设备触发本机专属操作",
          "防止 Agent 配置和 OpenClaw 失败隐藏真实错误"
        ]
      }
    ]
  },
  {
    "version": "0.2.0",
    "date": "2026-07-03",
    "sections": [
      {
        "type": "Added",
        "items": [
          "更新日志页动态化：版本记录改为由 CHANGELOG.md 驱动，自动按时间倒序展示，并区分新增/修复等分类。",
          "执行记录迁入设置页「执行记录诊断」tab：原侧边栏一级入口降级为设置页 tab，并修复执行记录列表无法滚动、不能翻页的问题。"
        ]
      },
      {
        "type": "Fixed",
        "items": [
          "修复已删除设备用旧凭证复活的问题。"
        ]
      }
    ]
  },
  {
    "version": "0.1.0",
    "date": "2026-05-05",
    "sections": [
      {
        "type": "Added",
        "items": [
          "初始版本，支持 Agent 管理、设备管理、聊天和任务看板。"
        ]
      }
    ]
  }
];
