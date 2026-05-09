export function introPrompt(input: { channelName: string; role: string }): string {
  return [
    `你刚被加入频道「${input.channelName}」。`,
    `请用 1-2 句中文自我介绍,说清你的角色「${input.role}」与你最擅长的事。`,
    '不要讨好,不要表情。',
  ].join('\n');
}
