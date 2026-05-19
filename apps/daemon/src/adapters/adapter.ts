export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  speaker: string;
  body: string;
  at: number;
}

export interface AskInput {
  prompt: string;
  history: ChatTurn[];
  systemPrompt?: string;
  workspace?: string;
  sandboxProfilePath?: string;
  env?: Record<string, string>;
}

export interface CliAdapter {
  readonly kind: 'codex' | 'claude-code' | 'openclaw' | 'hermes';
  ask(input: AskInput, signal: AbortSignal): Promise<string>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class StubAdapter implements CliAdapter {
  readonly kind = 'codex' as const;
  async ask(): Promise<string> {
    throw new Error('stub adapter: real adapter wiring lands in M2');
  }
  async health() {
    return { ok: false, detail: 'stub adapter — connect a real CLI in M2' };
  }
}
