import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

const THREAD_PANEL_WIDTH_KEY_PREFIX = 'agentbean:chat:thread-width:';

export const THREAD_PANEL_DEFAULT_WIDTH = 384;
export const THREAD_PANEL_MIN_WIDTH = 320;
export const THREAD_PANEL_MAX_WIDTH = 960;

export interface ThreadPanelWidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: ThreadPanelWidthStorage): ThreadPanelWidthStorage | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function threadPanelWidthStorageKey(routeTeamPath: string): string {
  return `${THREAD_PANEL_WIDTH_KEY_PREFIX}${routeTeamPath}`;
}

export function clampThreadPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return THREAD_PANEL_DEFAULT_WIDTH;
  return Math.min(THREAD_PANEL_MAX_WIDTH, Math.max(THREAD_PANEL_MIN_WIDTH, Math.round(width)));
}

export function loadThreadPanelWidth(routeTeamPath: string, storage?: ThreadPanelWidthStorage): number {
  const store = resolveStorage(storage);
  if (!store) return THREAD_PANEL_DEFAULT_WIDTH;
  const raw = store.getItem(threadPanelWidthStorageKey(routeTeamPath));
  if (!raw) return THREAD_PANEL_DEFAULT_WIDTH;
  return clampThreadPanelWidth(Number(raw));
}

export function saveThreadPanelWidth(routeTeamPath: string, width: number, storage?: ThreadPanelWidthStorage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  store.setItem(threadPanelWidthStorageKey(routeTeamPath), String(clampThreadPanelWidth(width)));
}

/**
 * 讨论串（最右面板）的拖拽调宽状态：按下分隔线后跟随 pointermove 更新宽度，
 * 松开后按团队路径持久化到 localStorage；宽度始终收敛在最小/最大值之间。
 */
export function useThreadPanelWidth(routeTeamPath: string) {
  // 初始值固定为默认宽度：SSR 与客户端 hydration 保持一致（避免 style/aria
  // 与服务端 HTML 不一致的警告），持久化值统一在挂载后读取。
  const [width, setWidth] = useState<number>(THREAD_PANEL_DEFAULT_WIDTH);
  const routeTeamPathRef = useRef(routeTeamPath);
  const widthRef = useRef(width);
  const stopDragRef = useRef<(() => void) | null>(null);

  routeTeamPathRef.current = routeTeamPath;
  widthRef.current = width;

  const persist = useCallback(() => {
    saveThreadPanelWidth(routeTeamPathRef.current, widthRef.current);
  }, []);

  useEffect(() => {
    setWidth(loadThreadPanelWidth(routeTeamPath));
  }, [routeTeamPath]);

  // 组件在拖动中卸载时也要解绑监听并落盘，避免 window 上残留监听器。
  useEffect(() => () => stopDragRef.current?.(), []);

  const onHandlePointerDown = useCallback((event: React.PointerEvent) => {
    if (stopDragRef.current) return;
    event.preventDefault();
    const startClientX = event.clientX;
    const startWidth = widthRef.current;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    const handleMove = (moveEvent: PointerEvent) => {
      // 分隔线左移（clientX 变小）→ 讨论串变宽；右移 → 变窄。
      setWidth(clampThreadPanelWidth(startWidth + (startClientX - moveEvent.clientX)));
    };
    const stop = () => {
      stopDragRef.current = null;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      persist();
    };

    stopDragRef.current = stop;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [persist]);

  const onHandleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = clampThreadPanelWidth(widthRef.current + (event.key === 'ArrowLeft' ? -16 : 16));
    setWidth(next);
    saveThreadPanelWidth(routeTeamPathRef.current, next);
  }, []);

  return { width, onHandlePointerDown, onHandleKeyDown };
}
