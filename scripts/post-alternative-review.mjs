#!/usr/bin/env node
/**
 * 发布“替代 Codex Review”评论，供 Codex 额度不足时使用。
 *
 * 用法：
 *   node scripts/post-alternative-review.mjs <PR号> --provider local-codex --conclusion APPROVED [--note "…"]
 *
 * 评论格式与 scripts/check-pr-merge-readiness.mjs 的解析规则保持一致：
 * review-provider、Reviewed commit、结论 三个字段缺一不可。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONCLUSION_VALUES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'gh 执行失败');
  return result.stdout.trim();
}

function parseArgs(argv) {
  const options = {
    provider: null,
    conclusion: null,
    note: '',
    number: null,
    repo: process.env.GITHUB_REPOSITORY ?? null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--provider') options.provider = argv[++index];
    else if (value === '--conclusion') options.conclusion = argv[++index];
    else if (value === '--note') options.note = argv[++index];
    else if (value === '--repo') options.repo = argv[++index];
    else if (/^\d+$/.test(value)) options.number = Number(value);
    else throw new Error(`未知参数：${value}`);
  }
  if (!Number.isInteger(options.number) || options.number <= 0) {
    throw new Error(
      '用法：node scripts/post-alternative-review.mjs <PR号> --provider <名称> --conclusion APPROVED|CHANGES_REQUESTED|COMMENTED [--note "…"]',
    );
  }
  if (!options.provider) throw new Error('缺少 --provider（例如 local-codex、claude-code、manual）');
  if (!CONCLUSION_VALUES.has(options.conclusion)) {
    throw new Error(`--conclusion 必须是 ${[...CONCLUSION_VALUES].join('|')}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const nameWithOwner = options.repo || runGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
    const headSha = runGh(['api', `repos/${nameWithOwner}/pulls/${options.number}`, '--jq', '.head.sha']);
    const shortSha = headSha.slice(0, 10);
    const lines = [
      '## 替代 Codex Review',
      `review-provider: ${options.provider}`,
      `Reviewed commit: \`${shortSha}\``,
      `结论：${options.conclusion}`,
    ];
    if (options.note) lines.push('', options.note);
    const url = runGh(['pr', 'comment', String(options.number), '--repo', nameWithOwner, '--body', lines.join('\n')]);
    console.log(`已发布替代 review 评论（${options.provider}@${shortSha}，结论 ${options.conclusion}）：${url}`);
  } catch (error) {
    console.error(`POST_ALTERNATIVE_REVIEW_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
