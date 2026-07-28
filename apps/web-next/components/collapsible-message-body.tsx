'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  MESSAGE_COLLAPSE_LINE_THRESHOLD,
  messageBodyExceedsLineThreshold,
  messageCollapseMaxHeightCss,
} from '@/lib/message-collapse';

/**
 * 频道消息长内容折叠容器。
 * - 超过阈值（默认 10 行，或渲染高度等效）时默认折叠，显示「展开」
 * - 展开后按钮变为「折叠」
 * - 短内容不显示任何按钮
 */
export function CollapsibleMessageBody({
  body,
  children,
  enabled = true,
  className,
}: {
  body: string;
  children: ReactNode;
  enabled?: boolean;
  className?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(
    () => enabled && messageBodyExceedsLineThreshold(body),
  );

  useEffect(() => {
    setExpanded(false);
  }, [body]);

  useLayoutEffect(() => {
    if (!enabled) {
      setOverflows(false);
      return;
    }

    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      const lh = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 22.75;
      const thresholdPx = lh * MESSAGE_COLLAPSE_LINE_THRESHOLD;
      // scrollHeight 在 overflow:hidden + max-height 下仍为完整内容高度
      setOverflows(
        messageBodyExceedsLineThreshold(body) || el.scrollHeight > thresholdPx + 1,
      );
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [body, enabled, expanded]);

  if (!enabled) {
    return <div className={className}>{children}</div>;
  }

  const showToggle = overflows;
  const collapsed = showToggle && !expanded;

  return (
    <div className={className}>
      <div
        ref={contentRef}
        className={collapsed ? 'relative overflow-hidden' : undefined}
        style={collapsed ? { maxHeight: messageCollapseMaxHeightCss() } : undefined}
        data-message-collapse={collapsed ? 'collapsed' : expanded ? 'expanded' : 'none'}
      >
        {children}
      </div>
      {showToggle && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-xs font-medium text-sky-700 hover:text-sky-900 hover:underline"
          data-smoke="message-collapse-toggle"
          aria-expanded={expanded}
        >
          {expanded ? '折叠' : '展开'}
        </button>
      )}
    </div>
  );
}
