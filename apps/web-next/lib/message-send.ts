export interface MessageSendFailure {
  error?: string;
  message?: unknown;
}

export interface ComposerKeyEvent {
  key: string;
  shiftKey?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
}

export function createClientMessageId(scope = 'web'): string {
  return `${scope}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function messageSendFailureText(response?: MessageSendFailure): string {
  const diagnostic = typeof response?.message === 'string' ? response.message.trim() : '';
  return `发送失败：${diagnostic || response?.error || 'unknown'}`;
}

export function shouldSubmitComposerKey(event: ComposerKeyEvent): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.nativeEvent?.isComposing
    && event.nativeEvent?.keyCode !== 229;
}
