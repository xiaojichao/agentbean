export interface AgentMetricEntry {
  agentId: string;
  requestId: string;
  startAt: number;
  endAt?: number;
  ok?: boolean;
  error?: string;
}

export interface AgentMetricsSummary {
  agentId: string;
  totalRequests: number;
  successCount: number;
  failCount: number;
  avgResponseMs: number;
  p95ResponseMs: number;
  lastError?: string;
  lastErrorAt?: number;
}

export class AgentMetricsCollector {
  private entries = new Map<string, AgentMetricEntry>();
  private maxSize = 1000;

  start(agentId: string, requestId: string) {
    this.entries.set(requestId, { agentId, requestId, startAt: Date.now() });
    this.trim();
  }

  resolve(requestId: string, ok: boolean, error?: string) {
    const e = this.entries.get(requestId);
    if (!e) return;
    e.endAt = Date.now();
    e.ok = ok;
    e.error = error;
  }

  private trim() {
    if (this.entries.size <= this.maxSize) return;
    const keys = [...this.entries.keys()];
    const toDelete = keys.slice(0, keys.length - this.maxSize);
    for (const k of toDelete) this.entries.delete(k);
  }

  summary(agentId?: string): AgentMetricsSummary[] {
    const byAgent = new Map<string, AgentMetricEntry[]>();
    for (const e of this.entries.values()) {
      if (agentId && e.agentId !== agentId) continue;
      const list = byAgent.get(e.agentId) ?? [];
      list.push(e);
      byAgent.set(e.agentId, list);
    }

    const results: AgentMetricsSummary[] = [];
    for (const [id, list] of byAgent) {
      const completed = list.filter((e) => e.endAt !== undefined && e.ok !== undefined);
      const latencies = completed.map((e) => e.endAt! - e.startAt).sort((a, b) => a - b);
      const totalRequests = list.length;
      const successCount = completed.filter((e) => e.ok).length;
      const failCount = completed.filter((e) => !e.ok).length;
      const avgResponseMs = latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;
      const p95Index = Math.floor(latencies.length * 0.95);
      const p95ResponseMs = latencies.length > 0 ? latencies[Math.min(p95Index, latencies.length - 1)]! : 0;
      const errors = list.filter((e) => e.error).sort((a, b) => (b.endAt ?? 0) - (a.endAt ?? 0));
      results.push({
        agentId: id,
        totalRequests,
        successCount,
        failCount,
        avgResponseMs,
        p95ResponseMs,
        lastError: errors[0]?.error,
        lastErrorAt: errors[0]?.endAt,
      });
    }
    return results;
  }

  all(): AgentMetricsSummary[] {
    return this.summary();
  }
}
