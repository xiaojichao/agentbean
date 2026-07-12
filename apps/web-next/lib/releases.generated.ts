// AUTO-GENERATED from CHANGELOG.md by scripts/gen-changelog.ts — do not edit.
import type { Release } from './changelog';
export const releases: Release[] = [
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
