import type { DaemonScanProvider, DaemonScanSnapshot } from './index.js';

const DEFAULT_RESCAN_INTERVAL_MS = 5 * 60 * 1000;

function signature(snap: DaemonScanSnapshot): string {
  const rt = [...snap.runtimes]
    .map((r) => `${r.adapterKind}|${r.name}|${r.command ?? ''}`)
    .sort()
    .join('\n');
  const ag = [...snap.agents]
    .map((a) => `${a.adapterKind}|${a.name}|${a.gatewayInstanceKey ?? ''}`)
    .sort()
    .join('\n');
  return `rt:\n${rt}\nag:\n${ag}`;
}

export function hasChanged(prev: DaemonScanSnapshot, next: DaemonScanSnapshot): boolean {
  return signature(prev) !== signature(next);
}

export interface RescanControllerOptions {
  scan: DaemonScanProvider;
  report: (snapshot: DaemonScanSnapshot) => Promise<void>;
  initial: DaemonScanSnapshot;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
}

export interface RescanController {
  start(): void;
  stop(): void;
  tickNow(): Promise<void>;
}

export function createRescanController(options: RescanControllerOptions): RescanController {
  const intervalMs = options.intervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  let last: DaemonScanSnapshot = options.initial;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function tick(): Promise<void> {
    try {
      const fresh = await options.scan();
      if (hasChanged(last, fresh)) {
        await options.report(fresh);
        last = fresh;
      }
    } catch {
      // best-effort; next tick retries
    }
  }

  return {
    start() {
      void tick();
      timer = setIntervalFn(() => { void tick(); }, intervalMs);
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tickNow: tick,
  };
}
