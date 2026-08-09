export type ChatMessageDecorationInput = {
  taskId: string | null;
  showTaskBadge: boolean;
  showReplyCount: boolean;
  replyCount: number;
  artifactCount: number;
  hasOutputPackage: boolean;
};

export type ChatMessageDecorationVisibility = {
  hasThreadSurface: boolean;
  showInlineTaskBadge: boolean;
  showInlineReplyBadge: boolean;
  showArtifactPreviews: boolean;
};

export function chatMessageDecorationVisibility({
  taskId,
  showTaskBadge,
  showReplyCount,
  replyCount,
  artifactCount,
  hasOutputPackage,
}: ChatMessageDecorationInput): ChatMessageDecorationVisibility {
  const hasThreadSurface = showReplyCount && (replyCount > 0 || Boolean(taskId));
  return {
    hasThreadSurface,
    showInlineTaskBadge: showTaskBadge && Boolean(taskId) && !hasThreadSurface,
    showInlineReplyBadge: showReplyCount && replyCount > 0 && !hasThreadSurface,
    showArtifactPreviews: artifactCount > 0 && !hasOutputPackage,
  };
}
