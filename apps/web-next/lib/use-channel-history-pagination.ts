'use client';

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ChannelHistoryPaginationDto } from '@agentbean/contracts';
import type { ChatMessage } from './schema';
import type { ChannelHistoryAck } from './socket';

interface Options {
  channelId: string | null;
  teamId: string;
  enabled: boolean;
  messages: ChatMessage[];
  pagination?: ChannelHistoryPaginationDto;
  listRef: RefObject<HTMLDivElement | null>;
  endRef: RefObject<HTMLDivElement | null>;
  loadPage: (teamId: string, channelId: string, cursor: string) => Promise<ChannelHistoryAck>;
  prepend: (channelId: string, messages: ChatMessage[], pagination: ChannelHistoryPaginationDto) => void;
}

interface ScrollAnchor {
  element: Element | null;
  top: number;
  height: number;
  scrollTop: number;
}

export function useChannelHistoryPagination(options: Options) {
  const { channelId, teamId, enabled, messages, pagination, listRef, endRef, loadPage, prepend } = options;
  const key = `${teamId}:${channelId ?? ''}`;
  const generation = useRef(0);
  const busy = useRef(false);
  const pendingAnchor = useRef<ScrollAnchor | null>(null);
  const nearBottom = useRef(true);
  const previous = useRef<{ key: string; count: number } | null>(null);
  const [state, setState] = useState({ key, loading: false, error: false });
  const [showBackToBottom, setShowBackToBottom] = useState(false);

  useLayoutEffect(() => {
    generation.current += 1;
    busy.current = false;
    pendingAnchor.current = null;
    previous.current = null;
    nearBottom.current = true;
    setState({ key, loading: false, error: false });
    setShowBackToBottom(false);
    return () => { generation.current += 1; };
  }, [key, enabled]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!enabled || !list) return;
    const anchor = pendingAnchor.current;
    if (anchor) {
      pendingAnchor.current = null;
      if (anchor.element?.isConnected && list.contains(anchor.element)) {
        list.scrollTop += anchor.element.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.top;
      } else {
        list.scrollTop = anchor.scrollTop + list.scrollHeight - anchor.height;
      }
    } else if (!previous.current || previous.current.key !== key || previous.current.count === 0 || nearBottom.current) {
      endRef.current?.scrollIntoView({ behavior: previous.current?.count ? 'smooth' : 'auto' });
    }
    previous.current = { key, count: messages.length };
    nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 160;
    setShowBackToBottom(!nearBottom.current);
  }, [key, enabled, messages, listRef, endRef]);

  const loadOlder = useCallback(async () => {
    const cursor = pagination?.nextBeforeMessageId;
    if (!enabled || !channelId || !pagination?.hasMore || !cursor || busy.current) return;
    const requestGeneration = generation.current;
    busy.current = true;
    setState({ key, loading: true, error: false });
    try {
      const page = await loadPage(teamId, channelId, cursor);
      if (generation.current !== requestGeneration) return;
      if (!page.ok || !page.messages || typeof page.hasMore !== 'boolean'
        || (page.hasMore && (!page.nextBeforeMessageId || page.nextBeforeMessageId === cursor))) {
        throw new Error('History page unavailable');
      }
      const list = listRef.current;
      if (list) {
        const top = list.getBoundingClientRect().top;
        const element = Array.from(list.querySelectorAll('[id^="message-"]'))
          .find((item) => item.getBoundingClientRect().bottom > top) ?? null;
        pendingAnchor.current = {
          element, top: element ? element.getBoundingClientRect().top - top : 0,
          height: list.scrollHeight, scrollTop: list.scrollTop,
        };
      }
      prepend(channelId, page.messages, { hasMore: page.hasMore, nextBeforeMessageId: page.nextBeforeMessageId ?? null });
      setState({ key, loading: false, error: false });
    } catch {
      if (generation.current === requestGeneration) setState({ key, loading: false, error: true });
    } finally {
      if (generation.current === requestGeneration) busy.current = false;
    }
  }, [channelId, teamId, key, enabled, pagination, loadPage, prepend, listRef]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 160;
    setShowBackToBottom(!nearBottom.current);
    if (list.scrollTop <= 24 && !(state.key === key && state.error)) void loadOlder();
  }, [listRef, loadOlder, state.key, state.error, key]);

  return {
    onScroll, loadOlder, showBackToBottom,
    loading: state.key === key && state.loading,
    error: state.key === key && state.error,
    hasMore: pagination?.hasMore ?? false,
  };
}
