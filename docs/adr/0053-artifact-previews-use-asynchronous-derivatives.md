---
status: accepted
---

# 文件卡片使用异步预览衍生资源

AgentBean 不在频道文件卡片和目录封面中直接加载完整原文件，而是为每个不可变 Artifact revision 异步生成受限尺寸的 Artifact preview derivative。文件上传或 Agent 交付不等待衍生资源完成；生成期间显示占位状态，失败时降级为通用文件卡片，原文件预览、下载和 Markdown 编辑仍可继续。

图片、视频首帧和 PDF 首页统一生成可缓存的 WebP 预览；GIF 与 SVG 的卡片只使用静态安全缩略图，音频优先使用内嵌封面并在缺失时使用通用音频卡片。衍生资源与具体 revision 绑定，不进入频道文件目录、版本历史、Agent 输入或用户交付物；新 revision 必须生成自己的预览资源。

规范衍生资源由 Server 侧文件生命周期统一拥有，并在原文件持久化后创建幂等后台任务；浏览器或 Daemon 只能提供上传期间的临时本地预览。任务采用有限重试和可诊断降级，未来即使把处理器拆到独立 Worker，任务身份、状态和缓存归属仍由 Server 管理。

首版处理器采用外部命令 adapter，默认调用部署环境提供的 `ffmpeg`，不随 AgentBean
分发媒体二进制。Node 24 在 macOS 开发环境与 Linux 生产环境都通过参数数组直接
`spawn`，不经过 shell；部署方负责选择符合自身许可证策略的 ffmpeg 构建。adapter
固定单线程、单帧、受限输出尺寸与单次内存分配，并由 Server 设置硬超时、输入和输出
字节上限。处理器不存在、超时、异常退出或音频无内嵌封面都只改变 derivative 状态，
不得影响原 Artifact。
