/**
 * WebWaka Platform Event Bus — Outbox Pattern
 * Events are durably stored in D1 (platform_events) and processed asynchronously.
 * Invariants: Event-Driven, Build Once Use Infinitely, Nigeria-First
 */

export interface PlatformEvent {
  event_type: string;
  aggregate_id: string;
  aggregate_type: string;
  payload: Record<string, unknown>;
  tenant_id?: string;
  correlation_id?: string;
  timestamp: number;
}

/**
 * Publish an event to the platform Event Bus via the D1 outbox pattern.
 * The event is written atomically to the platform_events table.
 * A background Cloudflare Worker Cron (or Queues consumer) drains this outbox.
 */
export async function publishEvent(
  db: { prepare: (q: string) => { bind: (...args: unknown[]) => { run: () => Promise<unknown> } } },
  event: PlatformEvent
): Promise<void> {
  const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO platform_events
       (id, event_type, aggregate_id, aggregate_type, payload, tenant_id, correlation_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .bind(
      id,
      event.event_type,
      event.aggregate_id,
      event.aggregate_type,
      JSON.stringify(event.payload),
      event.tenant_id ?? null,
      event.correlation_id ?? null,
      event.timestamp
    )
    .run();
}
