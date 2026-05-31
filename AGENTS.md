# AgentBean Codex Operating Contract

This project inherits the global Codex/OMX operating contract.

## GitHub Language Contract

For this repository, all GitHub issue and pull request titles, descriptions, comments, review summaries, and publish/yeet-generated PR content authored by Codex must be written in Chinese.

Do not use English for Codex-authored GitHub issue or pull request content unless the user explicitly asks for English in that specific task. Branch names, code identifiers, package names, stack traces, file paths, command names, and external API names may remain in their original language.

Before creating, updating, commenting on, or reviewing a GitHub issue or pull request, verify that the title and body are Chinese. Do not rely on `gh pr create --fill` or connector-filled defaults without rewriting the generated title and body into Chinese.

When using the GitHub publish/yeet workflow, the PR title must be a natural Chinese summary, and the PR body must use Chinese section headings and Chinese prose for:

- 关联 Issue（必须包含 GitHub closing keyword，例如 `Closes #123`；跨仓库用 `Closes owner/repo#123`）
- 变更内容
- 变更原因
- 用户或开发者影响
- 根因分析（修复类 PR 必填）
- 验证结果
