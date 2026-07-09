// AUTO-GENERATED from CHANGELOG.md by scripts/gen-changelog.ts — do not edit.
import type { Release } from './changelog';
export const releases: Release[] = [
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
