// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  THREAD_PANEL_DEFAULT_WIDTH,
  THREAD_PANEL_MAX_WIDTH,
  THREAD_PANEL_MIN_WIDTH,
  clampThreadPanelWidth,
  threadPanelWidthStorageKey,
  useThreadPanelWidth,
} from '../lib/thread-panel-resize';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function ResizeHarness({ teamPath }: { teamPath: string }) {
  const { width, onHandlePointerDown, onHandleKeyDown } = useThreadPanelWidth(teamPath);
  return (
    <div>
      <div data-testid="thread-panel" style={{ width }} />
      <div data-testid="resize-handle" onPointerDown={onHandlePointerDown} onKeyDown={onHandleKeyDown} />
    </div>
  );
}

function panelWidth(): number {
  const raw = screen.getByTestId('thread-panel').style.width;
  return Number(raw.replace('px', ''));
}

function dragBy(delta: number): void {
  fireEvent.pointerDown(screen.getByTestId('resize-handle'), { clientX: 800 });
  fireEvent.pointerMove(window, { clientX: 800 - delta });
  fireEvent.pointerUp(window);
}

describe('讨论串宽度拖拽调整', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  test('向左拖动分隔线会增大讨论串宽度', () => {
    render(<ResizeHarness teamPath="team-a" />);
    expect(panelWidth()).toBe(THREAD_PANEL_DEFAULT_WIDTH);
    dragBy(200);
    expect(panelWidth()).toBe(THREAD_PANEL_DEFAULT_WIDTH + 200);
  });

  test('宽度被限制在最小/最大值之间', () => {
    render(<ResizeHarness teamPath="team-a" />);
    dragBy(100000);
    expect(panelWidth()).toBe(THREAD_PANEL_MAX_WIDTH);
    dragBy(-100000);
    expect(panelWidth()).toBe(THREAD_PANEL_MIN_WIDTH);
  });

  test('拖动后的宽度会持久化，重新打开仍生效', () => {
    const { unmount } = render(<ResizeHarness teamPath="team-a" />);
    dragBy(150);
    const persisted = Number(window.localStorage.getItem(threadPanelWidthStorageKey('team-a')));
    expect(persisted).toBe(THREAD_PANEL_DEFAULT_WIDTH + 150);
    unmount();
    render(<ResizeHarness teamPath="team-a" />);
    expect(panelWidth()).toBe(THREAD_PANEL_DEFAULT_WIDTH + 150);
  });

  test('键盘方向键也能调整并持久化宽度', () => {
    render(<ResizeHarness teamPath="team-a" />);
    fireEvent.keyDown(screen.getByTestId('resize-handle'), { key: 'ArrowLeft' });
    expect(panelWidth()).toBe(THREAD_PANEL_DEFAULT_WIDTH - 16);
    fireEvent.keyDown(screen.getByTestId('resize-handle'), { key: 'ArrowRight' });
    expect(panelWidth()).toBe(THREAD_PANEL_DEFAULT_WIDTH);
    expect(window.localStorage.getItem(threadPanelWidthStorageKey('team-a')))
      .toBe(String(THREAD_PANEL_DEFAULT_WIDTH));
  });

  test('不同团队路径的宽度互不影响', () => {
    render(<ResizeHarness teamPath="team-a" />);
    dragBy(100);
    cleanup();
    render(<ResizeHarness teamPath="team-b" />);
    expect(panelWidth()).toBe(THREAD_PANEL_DEFAULT_WIDTH);
  });

  test('clampThreadPanelWidth 对非法值收敛到默认宽度', () => {
    expect(clampThreadPanelWidth(Number.NaN)).toBe(THREAD_PANEL_DEFAULT_WIDTH);
    expect(clampThreadPanelWidth(10)).toBe(THREAD_PANEL_MIN_WIDTH);
    expect(clampThreadPanelWidth(99999)).toBe(THREAD_PANEL_MAX_WIDTH);
  });
});
