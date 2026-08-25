# 实施计划

1. 在 browser smoke 脚本中加入 wait timeout 结构化上下文与失败 JSON，扩展目标测试。
2. 将 CI browser retry 拆为显式 attempt steps，隔离目录并生成 outcome JSON，补 workflow/readiness 合同测试。
3. 扩展 SDLC flow metrics 的 jobs 收集与 retry outcome 分类，更新 JSON、人类报告、数据质量测试和文档。
4. 使用 Node 24 安装当前 worktree 依赖，运行 browser 脚本测试、metrics 测试、readiness、changed preflight 计划与适用构建。
5. 运行一次真实 browser smoke，检查成功 artifact；对失败上下文使用受控测试验证，不人为制造远端 flaky。
6. 检查 diff，中文提交并创建 Draft PR；CI 绿后过 review-readiness，转 Ready，完成最新 head review、merge-readiness、合并与 main/生产验真。

## 回滚点

- 若显式 step 不能保持首次失败原始 outcome，则停止并恢复 CI 单 step，不发布不可靠指标。
- 若拉取全部 first-pass jobs 使周报超过 10 分钟，则保留 CI/artifact 改进，metrics 先只输出数据质量告警并拆后续 Issue。
