export type ChannelProjectWorkspaceRequestKind =
  | 'project-facts'
  | 'artifact-library'
  | 'document-bundles'
  | 'output-packages'
  | 'tasks';

export interface ChannelProjectWorkspaceRequestTicket {
  readonly kind: ChannelProjectWorkspaceRequestKind;
  readonly channelId: string;
  readonly revision: number;
}

export interface ChannelProjectWorkspaceRequestFence {
  begin(
    kind: ChannelProjectWorkspaceRequestKind,
    channelId: string,
  ): ChannelProjectWorkspaceRequestTicket;
  invalidate(kind: ChannelProjectWorkspaceRequestKind): void;
  isCurrent(
    ticket: ChannelProjectWorkspaceRequestTicket,
    renderedChannelId: string | null,
  ): boolean;
  reset(channelId: string | null): void;
}

const REQUEST_KINDS: readonly ChannelProjectWorkspaceRequestKind[] = [
  'project-facts',
  'artifact-library',
  'document-bundles',
  'output-packages',
  'tasks',
];

/**
 * Channel Project Workspace 的 request epoch coordinator。
 *
 * 每类读取拥有独立 revision；切换 Channel 时统一使全部 ticket 失效。
 * 只有生命周期调用的 reset 可以切换 active Channel；迟到闭包不得通过 begin 夺回 ownership。
 * renderedChannelId 额外覆盖 React effect 尚未提交 reset 的切换窗口。
 */
export function createChannelProjectWorkspaceRequestFence(): ChannelProjectWorkspaceRequestFence {
  let activeChannelId: string | null = null;
  const revisions = new Map<ChannelProjectWorkspaceRequestKind, number>(
    REQUEST_KINDS.map((kind) => [kind, 0]),
  );

  const invalidate = (kind: ChannelProjectWorkspaceRequestKind): void => {
    revisions.set(kind, (revisions.get(kind) ?? 0) + 1);
  };

  const reset = (channelId: string | null): void => {
    if (activeChannelId === channelId) return;
    activeChannelId = channelId;
    for (const kind of REQUEST_KINDS) invalidate(kind);
  };

  return {
    begin(kind, channelId) {
      if (activeChannelId !== channelId) {
        return {
          kind,
          channelId,
          revision: revisions.get(kind) ?? 0,
        };
      }
      invalidate(kind);
      return {
        kind,
        channelId,
        revision: revisions.get(kind) ?? 0,
      };
    },
    invalidate,
    isCurrent(ticket, renderedChannelId) {
      return activeChannelId === ticket.channelId
        && renderedChannelId === ticket.channelId
        && revisions.get(ticket.kind) === ticket.revision;
    },
    reset,
  };
}
