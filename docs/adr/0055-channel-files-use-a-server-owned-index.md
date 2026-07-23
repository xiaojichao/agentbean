---
status: accepted
---

# 频道文件使用 Server 权威索引

频道文件视图不能继续从浏览器当前已加载的频道消息汇总附件，而由 Server 维护 Channel file index。索引统一投影公开消息和讨论串附件、Channel document 当前最新版、明确交付物，以及允许频道成员查看但未发布为消息的 Run artifact；它保留来源消息、任务、Run、Agent、Artifact role、Artifact source root、相对路径和文档版本信息。

索引排除内部运行日志、Artifact preview derivative、只应出现在文档版本历史中的旧 revision、未交付到当前频道根任务的内部调用产物，以及已删除消息中不再公开的普通附件。目录查询、分页、搜索、角色筛选和稳定排序由 Server 提供，文件是否可见不能取决于客户端加载了多少聊天历史。

历史迁移采用保守且幂等的投影：现有消息附件归为普通附件；每个 Markdown 消息附件独立建立只有初始 revision 的 Channel document；带 Workspace Run 和相对路径的文件按 Run 隔离到合成来源根“历史运行产物”。缺失来源信息时放在对应分组根目录，不猜测设备路径、Artifact role、交付物或最终版，不重新扫描 Agent 设备旧目录；Artifact preview derivative 通过低优先级后台任务或访问时逐步补齐。
