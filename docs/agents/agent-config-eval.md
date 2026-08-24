# Agent 配置评测

AgentBean 用两层离线评测防止 Coding Agent 的规则、Skill、Hook、Trellis workflow 和交付门禁发生静默漂移：

1. `skill-routing-eval.md` 保留 20 条人工可读的路由矩阵，是完整工程决策权威；
2. `agent-config-eval-cases.json` 固化 10 条近期高风险场景的预期 route、必要/禁止动作、证据、策略锚点和现有回归脚本。

评测不调用在线模型，也不把模型输出写进仓库。默认检查仓库契约是否仍完整：20 条路由编号、6 条高信号路由、10 条高风险场景、策略原文锚点与 `package.json` 回归入口。

```bash
npm run eval:agent-config
npm run check:agent-config-eval -- --json
```

## 平台观察

Codex、Claude Code 或其他平台升级后，可以把同一批 prompt 的结构化观察结果交给检查器精确评分：

```json
{
  "schemaVersion": 1,
  "platform": "codex",
  "observations": [
    {
      "id": "latest-head-review",
      "route": "pr_merge_gate",
      "capabilities": [],
      "actions": ["verify_latest_head_review"],
      "evidence": ["reviewed_head_sha"]
    }
  ]
}
```

实际评分文件必须覆盖全部 10 条场景；缺失、重复、未知场景，错误 route，缺少必要项或出现禁止项都会 fail closed：

```bash
npm run check:agent-config-eval -- --observations /absolute/path/to/observations.json
```

观察文件只描述平台已经采取的决策，不授权检查器执行 commit、push、review、rerun、merge、deploy 或生产 mutation。

## CI 触发范围

CI 只在以下配置面变化时运行这组评测：

- `AGENTS.md`、`CLAUDE.md`、`.agents/skills/` 与 `.claude/`、`.codex/`、`.cursor/` 平台配置 / Hook；
- `docs/agents/harness.md`、路由矩阵、评测 fixture 和本说明；
- `.trellis/workflow.md`、`.trellis/config.yaml` 与 Trellis 上下文入口；
- Issue Claim、PR merge readiness、closeout observer、CI failure diagnosis、Maintain signal observer 等核心门禁；
- `package.json` 和 `ci-cd.yml` 本身。

普通业务代码和无关文档不会单独触发 Agent 配置评测。评测仅依赖 Node.js 内置模块，所以 CI 无需为 eval-only 变更安装 workspace dependencies。
