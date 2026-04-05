/**
 * WebWaka Transport — Platform Event Bus
 * Blueprint Reference: Part 5 (Platform Event Bus)
 *
 * Standardized to CF Queues producer pattern (matches commerce, professional, civic).
 * The TRANSPORT_EVENTS CF Queue binding was already declared in wrangler.toml.
 *
 *   Server-side: await publishEvent(c.env.TRANSPORT_EVENTS, event)
 *   Dev / tests:  falls back to in-memory eventBus
 *
 * The existing D1 platform_events outbox + drainEventBus() sweeper remains in
 * sweepers.ts for backward compatibility (seat cache, SMS, SOS routing).
 * New events published via this module go directly to CF Queues.
 */

export interface WebWakaEvent<T = Record<string, unknown>> {
  id: string;
  tenantId: string;
  type: string;
  sourceModule: string;
  timestamp: number;
  payload: T;
}

export interface EventQueue {
  send(message: WebWakaEvent): Promise<void>;
}

export type EventHandler = (event: WebWakaEvent) => Promise<void>;

// ─── CF Queues Producer ───────────────────────────────────────────────────────

export async function publishEvent(
  queue: EventQueue | null | undefined,
  event: WebWakaEvent,
): Promise<void> {
  if (queue) {
    await queue.send(event);
  } else {
    // Dev / local fallback
    console.warn("[event-bus] TRANSPORT_EVENTS queue not bound — in-memory fallback", event.type);
    await eventBus.publish(event);
  }
}

// ─── CF Queues Consumer Dispatcher ───────────────────────────────────────────

const consumerHandlers = new Map<string, EventHandler[]>();

export function registerHandler(eventType: string, handler: EventHandler): void {
  if (!consumerHandlers.has(eventType)) consumerHandlers.set(eventType, []);
  consumerHandlers.get(eventType)!.push(handler);
}

export function clearHandlers(): void { consumerHandlers.clear(); }

export async function dispatchEvent(event: WebWakaEvent): Promise<void> {
  const handlers = consumerHandlers.get(event.type) ?? [];
  await Promise.allSettled(handlers.map(h => h(event)));
}

// ─── In-Memory Bus (dev / tests) ─────────────────────────────────────────────

export class EventBusRegistry {
  private handlers: Map<string, EventHandler[]> = new Map();
  subscribe(eventType: string, handler: EventHandler): void {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, []);
    this.handlers.get(eventType)!.push(handler);
  }
  async publish(event: WebWakaEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    await Promise.allSettled(handlers.map(h => h(event)));
  }
}

export const eventBus = new EventBusRegistry();

// ─── Event factory ────────────────────────────────────────────────────────────

export type TransportEventType =
  | "booking.created"
  | "booking.confirmed"
  | "booking.cancelled"
  | "booking.abandoned"
  | "trip.created"
  | "trip.departed"
  | "trip.completed"
  | "trip.cancelled"
  | "trip.cargo_loaded"
  | "trip.cargo_unloaded"
  | "trip.state_changed"
  | "trip.sos_activated"
  | "seat.reserved"
  | "seat.reservation_expired"
  | "payment.confirmed"
  | "payment.failed"
  | "payment.amount_mismatch"
  | "operator.onboarded"
  | "driver.verified";

export function createTransportEvent<T = Record<string, unknown>>(
  tenantId: string,
  type: TransportEventType,
  payload: T,
): WebWakaEvent<T> {
  return {
    id: `evt_trn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    tenantId,
    type,
    sourceModule: "transport",
    timestamp: Date.now(),
    payload,
  };
}
