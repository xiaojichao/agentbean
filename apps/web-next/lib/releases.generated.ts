// AUTO-GENERATED from CHANGELOG.md by scripts/gen-changelog.ts — do not edit.
import type { Release } from './changelog';
export const releases: Release[] = [
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
