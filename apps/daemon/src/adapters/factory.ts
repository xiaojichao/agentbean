import { CodexAdapter } from './codex.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { OpenClawAdapter } from './openclaw.js';
import { HermesAdapter } from './hermes.js';
import type { CliAdapter } from './adapter.js';
import type { AgentConfigEntry } from '../config.js';

export function pickAdapter(cfg: AgentConfigEntry['adapter']): CliAdapter {
  switch (cfg.kind) {
    case 'codex':
      return new CodexAdapter({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        systemPrompt: cfg.systemPrompt,
      });
    case 'claude-code':
      return new ClaudeCodeAdapter({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        systemPrompt: cfg.systemPrompt,
      });
    case 'openclaw':
      return new OpenClawAdapter({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        systemPrompt: cfg.systemPrompt,
      });
    case 'hermes':
      return new HermesAdapter({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        systemPrompt: cfg.systemPrompt,
      });
    default:
      throw new Error(`adapter '${(cfg as any).kind}' not yet implemented`);
  }
}
