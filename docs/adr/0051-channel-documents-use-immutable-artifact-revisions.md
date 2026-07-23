---
status: accepted
---

# 频道文档使用不可变附件版本

可编辑的 Markdown 在频道文件视图中表示为 Channel document，但消息、讨论串和 Agent 交付始终引用发布当时不可变的 Message artifact revision。保存编辑会为同一 Channel document 创建新 revision，文件视图默认展示最新版；另行上传或交付的同名文件是新的 Channel document，不能按文件名自动合并。

这一合同选择“逻辑文档 + 不可变版本链”，而不是原地覆盖历史附件或按文件名推断文档身份。它保留了消息和执行证据的可追溯性，同时允许有频道访问权的人类成员持续协作编辑；频道归档后文档只读。

版本历史允许预览和下载任一 revision。恢复历史内容时，系统复制该内容并创建新的最新版，不能移动版本指针、删除后续 revision 或改变历史消息引用；首版不引入内容 diff 或版本分支。

Markdown revision 中指向同目录图片、视频或文件的相对路径，在保存时解析并记录为指向具体不可变 Artifact revision 的 Document resource reference。历史预览使用保存时的 reference，不能因同名路径后来出现新文件而漂移；路径规范化不得越过所属 Artifact source root，无法解析的引用必须显式显示缺失状态。

用户编辑只读 Run artifact 中的 Markdown 时，首次保存会在“频道文档”空间创建新的 Channel document，并保留来源任务、Run、原 Artifact revision 和原始相对路径；系统不能回写或伪装修改历史运行目录。默认逻辑路径保留任务与原相对子树，同路径已有文档时必须要求改名或显式选择目标，不能按文件名自动合并。
