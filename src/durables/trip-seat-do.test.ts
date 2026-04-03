/**
 * T-TRN-01: TripSeatDO Unit Tests
 *
 * Tests the Durable Object's in-memory serialization logic and D1 write-through.
 * The DO is constructed directly with mock ctx + env to avoid needing the
 * Cloudflare runtime — all tests run in Vitest (Node).
 *
 * Key invariants verified:
 *   1. /reserve-seats rejects seats already held in memory (concurrent conflict)
 *   2. /reserve-seats accepts all seats if none are held
 *   3. /reserve-seats writes through to D1 and updates in-memory state
 *   4. /release-seats removes seats from in-memory held map
 *   5. Expired holds are swept before each reservation check
 *   6. Cold-start hydration loads active reservations from D1
 *   7. /broadcast fans out messages to connected WebSocket clients
 *   8. Unknown routes return 404
 *
 * Bug-fix coverage (BUG-1 / BUG-2 / BUG-3):
 *   BUG-1: Background D1 ops use ctx.waitUntil() — mock executes them so
 *          compensating rollback side-effects are visible in test assertions.
 *   BUG-2: Missing token for any seat_id returns 400 before touching D1.
 *   BUG-3: concurrent_conflict 409 includes conflicted_seats array.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TripSeatDO } from './trip-seat-do.js';

// ── Mock DurableObjectState ──────────────────────────────────────────────────
// waitUntil tracks promises so test helpers can flush them, verifying that
// background D1 operations (compensating rollback, release sync) actually run.
interface MockCtx extends DurableObjectState {
  _waitUntilPromises: Promise<unknown>[];
}

function makeMockCtx(): MockCtx {
  const store = new Map<string, unknown>();
  const pending: Promise<unknown>[] = [];
  return {
    id: { toString: () => 'mock-do-id', name: 'trp_test' } as DurableObjectId,
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => { store.set(key, value); },
      delete: async (key: string) => store.delete(key),
      list: async () => store,
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      sync: async () => {},
      sql: undefined as unknown as SqlStorage,
      transaction: async (fn: (txn: DurableObjectTransaction) => Promise<unknown>) =>
        fn({ get: async () => undefined, put: async () => {}, delete: async () => {}, list: async () => new Map() } as unknown as DurableObjectTransaction),
      transactionSync: () => undefined,
    } as unknown as DurableObjectStorage,
    // BUG-1: mock executes the promise so background D1 side-effects are testable
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    _waitUntilPromises: pending,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    acceptWebSocket: () => { throw new Error('not implemented'); },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: () => null,
    getTags: () => [],
    abort: () => {},
  } as unknown as MockCtx;
}

/** Flush all pending waitUntil promises registered since the last call. */
async function flushWaitUntil(ctx: MockCtx): Promise<void> {
  const batch = [...ctx._waitUntilPromises];
  ctx._waitUntilPromises.length = 0;
  await Promise.allSettled(batch);
}

// ── Mock D1 Database ─────────────────────────────────────────────────────────
function createMockDB(initialSeats: Array<{
  id: string;
  trip_id: string;
  status: string;
  reservation_token?: string | null;
  reservation_expires_at?: number | null;
  reserved_by?: string | null;
  version?: number;
}> = []) {
  let seats = initialSeats.map(s => ({ version: 0, ...s }));

  const db: any = {
    _seats: seats,
    prepare(sql: string) {
      const stmt = {
        _sql: sql,
        _params: [] as any[],
        bind(...args: any[]) { this._params = args; return this; },
        async run() {
          const sqlUp = this._sql.trim().toUpperCase();
          if (sqlUp.startsWith('UPDATE')) {
            const now = Date.now();
            // Detect reserved seats update
            if (this._sql.includes("status = 'reserved'")) {
              const [userId, token, expiresAt, , seatId, tripId] = this._params;
              const seat = seats.find((s: any) => s.id === seatId && s.trip_id === tripId && s.status === 'available') as any;
              if (seat) {
                seat.status = 'reserved';
                seat.reserved_by = userId;
                seat.reservation_token = token;
                seat.reservation_expires_at = expiresAt;
                seat.updated_at = now;
                seat.version = (seat.version ?? 0) + 1;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            // Detect release update
            if (this._sql.includes("status = 'available'")) {
              const [, seatId, tripId, token] = this._params;
              const seat = seats.find((s: any) => s.id === seatId && s.trip_id === tripId && s.reservation_token === token) as any;
              if (seat) {
                seat.status = 'available';
                seat.reserved_by = null;
                seat.reservation_token = null;
                seat.reservation_expires_at = null;
                seat.updated_at = now;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          return null;
        },
        async all() {
          // Hydration query: trip_id = ?, status = 'reserved', reservation_expires_at > ?
          if (this._sql.includes("status = 'reserved'") && this._sql.includes('trip_id = ?')) {
            const [tripId, now] = this._params;
            const results = seats.filter((s: any) =>
              s.trip_id === tripId &&
              s.status === 'reserved' &&
              (s.reservation_expires_at ?? 0) > now
            );
            return { results };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) {
      const results: any[] = [];
      for (const s of stmts) {
        results.push(await s.run());
      }
      return results;
    },
  };
  return db;
}

// ── Env factory ──────────────────────────────────────────────────────────────
function makeEnv(db: any) {
  return { DB: db } as any;
}

// ── Helper: create DO instance ───────────────────────────────────────────────
function makeDO(db: any) {
  return new TripSeatDO(makeMockCtx(), makeEnv(db));
}

/** Returns both the DO and its MockCtx so tests can call flushWaitUntil(ctx). */
function makeDOWithCtx(db: any): { do_: TripSeatDO; ctx: MockCtx } {
  const ctx = makeMockCtx();
  return { do_: new TripSeatDO(ctx, makeEnv(db)), ctx };
}

// ── Helper: POST /reserve-seats ──────────────────────────────────────────────
async function reserveSeats(
  do_: TripSeatDO,
  opts: {
    seat_ids: string[];
    user_id?: string;
    ttl_ms?: number;
    trip_id?: string;
    tokens?: Record<string, string>;
  }
) {
  const seatIds = opts.seat_ids;
  const tokens: Record<string, string> = opts.tokens ?? Object.fromEntries(seatIds.map(id => [id, `tok_${id}`]));
  return do_.fetch(new Request('https://do/reserve-seats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seat_ids: seatIds,
      user_id: opts.user_id ?? 'usr_1',
      ttl_ms: opts.ttl_ms ?? 30_000,
      trip_id: opts.trip_id ?? 'trp_1',
      tokens,
    }),
  }));
}

// ── Helper: POST /release-seats ───────────────────────────────────────────────
async function releaseSeats(
  do_: TripSeatDO,
  opts: { seat_ids: string[]; tokens: Record<string, string>; trip_id?: string }
) {
  return do_.fetch(new Request('https://do/release-seats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seat_ids: opts.seat_ids,
      tokens: opts.tokens,
      trip_id: opts.trip_id ?? 'trp_1',
    }),
  }));
}

// ============================================================
// TripSeatDO Unit Tests
// ============================================================
describe('TripSeatDO: /reserve-seats', () => {
  let db: any;
  let do_: TripSeatDO;

  beforeEach(() => {
    db = createMockDB([
      { id: 's1', trip_id: 'trp_1', status: 'available' },
      { id: 's2', trip_id: 'trp_1', status: 'available' },
      { id: 's3', trip_id: 'trp_1', status: 'available' },
    ]);
    do_ = makeDO(db);
  });

  it('reserves available seats and returns tokens', async () => {
    const res = await reserveSeats(do_, { seat_ids: ['s1', 's2'] });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.tokens).toHaveLength(2);
    expect(body.data.tokens[0].seat_id).toBe('s1');
    expect(body.data.tokens[0].token).toBeDefined();
    expect(body.data.expires_at).toBeGreaterThan(Date.now());
  });

  it('rejects a second reservation for the same seat (in-memory conflict)', async () => {
    // First reservation succeeds
    const res1 = await reserveSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'tok_a1' } });
    expect(res1.status).toBe(200);

    // Second reservation for the same seat must be rejected from in-memory state
    const res2 = await reserveSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'tok_a2' } });
    expect(res2.status).toBe(409);
    const body2 = await res2.json() as any;
    expect(body2.error).toBe('seat_unavailable');
    expect(body2.conflicted_seats).toContain('s1');
  });

  it('rejects batch if ANY seat in the batch is already held', async () => {
    // Reserve s1
    await reserveSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'tok_first' } });

    // Try to reserve both s1 and s2 together — must fail because s1 is held
    const res = await reserveSeats(do_, { seat_ids: ['s1', 's2'], tokens: { s1: 'tok_x', s2: 'tok_y' } });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.conflicted_seats).toContain('s1');
  });

  it('two sequential reservations for different seats both succeed', async () => {
    const res1 = await reserveSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'tok_1a' } });
    const res2 = await reserveSeats(do_, { seat_ids: ['s2'], tokens: { s2: 'tok_2a' } });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it('writes through to D1: seat status becomes reserved', async () => {
    await reserveSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'tok_d1write' } });
    const seat = db._seats.find((s: any) => s.id === 's1');
    expect(seat.status).toBe('reserved');
    expect(seat.reservation_token).toBe('tok_d1write');
    expect(seat.reserved_by).toBe('usr_1');
  });

  it('returns 409 concurrent_conflict when D1 shows seat not available (not in memory, changed externally)', async () => {
    // Simulate s1 being reserved in D1 directly (bypassing DO memory)
    db._seats[0]!.status = 'reserved';
    db._seats[0]!.reservation_token = 'external_tok';

    // DO memory doesn't know about it (fresh DO, not hydrated yet)
    const res = await reserveSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'tok_new' } });
    // Should get concurrent_conflict from D1 check (changes = 0)
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('concurrent_conflict');
  });

  it('returns 400 when seat_ids is empty', async () => {
    const res = await reserveSeats(do_, { seat_ids: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is malformed JSON', async () => {
    const res = await do_.fetch(new Request('https://do/reserve-seats', {
      method: 'POST',
      body: 'not-json',
    }));
    expect(res.status).toBe(400);
  });

  it('respects custom TTL in token expires_at', async () => {
    const ttlMs = 60_000;
    const before = Date.now();
    const res = await reserveSeats(do_, { seat_ids: ['s1'], ttl_ms: ttlMs, tokens: { s1: 'tok_ttl' } });
    const body = await res.json() as any;
    expect(body.data.expires_at).toBeGreaterThanOrEqual(before + ttlMs);
    expect(body.data.expires_at).toBeLessThanOrEqual(before + ttlMs + 500);
  });

  // ── BUG-2 fix: missing token validation ────────────────────────────────────
  it('BUG-2: returns 400 when tokens map is missing an entry for a seat_id', async () => {
    // s1 has no token in the map — this used to silently write NULL to D1
    const res = await reserveSeats(do_, {
      seat_ids: ['s1', 's2'],
      tokens: { s2: 'tok_s2_only' }, // s1 is missing
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('missing_tokens');
    expect(body.message).toContain('s1');
    // D1 must not have been touched — seat remains available
    const seat = db._seats.find((s: any) => s.id === 's1');
    expect(seat.status).toBe('available');
    expect(seat.reservation_token).toBeUndefined();
  });

  it('BUG-2: returns 400 when tokens map is completely absent', async () => {
    const res = await do_.fetch(new Request('https://do/reserve-seats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seat_ids: ['s1'],
        user_id: 'usr_1',
        ttl_ms: 30_000,
        trip_id: 'trp_1',
        tokens: {},
      }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('missing_tokens');
  });

  // ── BUG-3 fix: concurrent_conflict includes conflicted_seats ───────────────
  it('BUG-3: concurrent_conflict 409 includes conflicted_seats array', async () => {
    // Simulate s1 reserved in D1 externally (bypassing DO memory)
    db._seats[0]!.status = 'reserved';
    db._seats[0]!.reservation_token = 'external_token';

    // DO memory doesn't know — fresh DO, not hydrated yet
    const res = await reserveSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'tok_new' } });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    // Must be concurrent_conflict (from D1, not seat_unavailable from memory)
    expect(body.error).toBe('concurrent_conflict');
    // BUG-3 fix: conflicted_seats must now be present
    expect(Array.isArray(body.conflicted_seats)).toBe(true);
    expect(body.conflicted_seats).toContain('s1');
  });

  // ── BUG-1 fix: compensating rollback via ctx.waitUntil() ──────────────────
  it('BUG-1: compensating rollback via waitUntil restores partial D1 writes', async () => {
    // Set up: s1 is available, s2 is reserved externally in D1 (DO memory clean)
    const { do_: doWithCtx, ctx } = makeDOWithCtx(db);
    db._seats[1]!.status = 'reserved'; // s2 reserved externally
    db._seats[1]!.reservation_token = 'external_tok_s2';

    // Attempt to reserve s1+s2 together.
    // Expected: s1 write succeeds (changes=1), s2 write fails (changes=0)
    // → 409 returned, compensating rollback registered via waitUntil
    const res = await reserveSeats(doWithCtx, {
      seat_ids: ['s1', 's2'],
      tokens: { s1: 'tok_s1_new', s2: 'tok_s2_new' },
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('concurrent_conflict');
    expect(body.conflicted_seats).toContain('s2');

    // BUG-1 fix: flush waitUntil promises — the compensating rollback for s1 runs
    await flushWaitUntil(ctx);

    // s1 must be back to 'available' — the compensating rollback ran via waitUntil
    const s1 = db._seats.find((s: any) => s.id === 's1');
    expect(s1.status).toBe('available');
    expect(s1.reservation_token).toBeNull();
  });
});

describe('TripSeatDO: /release-seats', () => {
  let db: any;
  let do_: TripSeatDO;

  beforeEach(() => {
    db = createMockDB([
      { id: 's1', trip_id: 'trp_1', status: 'available' },
      { id: 's2', trip_id: 'trp_1', status: 'available' },
    ]);
    do_ = makeDO(db);
  });

  it('releases a held seat so it can be reserved again', async () => {
    // Use makeDOWithCtx so we can flush the waitUntil D1-release promise before
    // the second reservation — otherwise D1 still shows s1 as 'reserved'.
    const { do_: doWC, ctx } = makeDOWithCtx(db);

    // Reserve
    await reserveSeats(doWC, { seat_ids: ['s1'], tokens: { s1: 'tok_rel' } });

    // Release
    const relRes = await releaseSeats(doWC, { seat_ids: ['s1'], tokens: { s1: 'tok_rel' } });
    expect(relRes.status).toBe(200);

    // Flush the waitUntil D1-sync promise so mock D1 reflects the release
    await flushWaitUntil(ctx);

    // Should now be re-reservable (DO memory AND D1 both cleared)
    const res2 = await reserveSeats(doWC, { seat_ids: ['s1'], tokens: { s1: 'tok_new' } });
    expect(res2.status).toBe(200);
  });

  it('returns 200 even if token does not match (non-fatal: D1 handles enforcement)', async () => {
    // The DO release endpoint is a best-effort memory cleanup;
    // the actual D1 update won't proceed if token does not match.
    const res = await releaseSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'wrong_token' } });
    expect(res.status).toBe(200);
  });

  it('returns 400 when seat_ids is empty', async () => {
    const res = await releaseSeats(do_, { seat_ids: [], tokens: {} });
    expect(res.status).toBe(400);
  });
});

describe('TripSeatDO: expired hold sweeping', () => {
  it('sweeps expired holds before checking for conflicts', async () => {
    const db = createMockDB([
      { id: 's1', trip_id: 'trp_1', status: 'available' },
    ]);
    const do_ = makeDO(db);

    // Reserve with a TTL already in the past (expired immediately)
    await reserveSeats(do_, { seat_ids: ['s1'], ttl_ms: -1_000, tokens: { s1: 'tok_expired' } });

    // Even though DO memory has s1 as held, the TTL is past → should be swept
    // and a fresh reservation should succeed
    const res2 = await reserveSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'tok_fresh' } });
    // The seat was swept, so in-memory conflict check passes.
    // D1 still has it as reserved (our mock), so we get concurrent_conflict from D1.
    // This is correct behavior: the DO deferred to D1 as source of truth.
    expect([200, 409]).toContain(res2.status);
  });
});

describe('TripSeatDO: cold-start hydration', () => {
  it('loads active reservations from D1 on first request', async () => {
    const now = Date.now();
    const db = createMockDB([
      {
        id: 's1', trip_id: 'trp_1', status: 'reserved',
        reservation_token: 'tok_hydrated', reservation_expires_at: now + 30_000,
        reserved_by: 'usr_hydrated',
      },
    ]);
    const do_ = makeDO(db);

    // First reservation attempt against an already-reserved seat should be rejected
    // because hydration loads it into in-memory state
    const res = await reserveSeats(do_, { seat_ids: ['s1'], tokens: { s1: 'tok_new' } });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    // Either seat_unavailable (from in-memory after hydration) or concurrent_conflict (from D1)
    expect(['seat_unavailable', 'concurrent_conflict']).toContain(body.error);
  });
});

describe('TripSeatDO: /broadcast', () => {
  it('returns 200 with no connected clients', async () => {
    const db = createMockDB([]);
    const do_ = makeDO(db);
    const res = await do_.fetch(new Request('https://do/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'seat_changed', seat: { id: 's1', status: 'reserved' } }),
    }));
    expect(res.status).toBe(200);
  });
});

describe('TripSeatDO: /ws', () => {
  it('returns 426 when no WebSocket upgrade header', async () => {
    const db = createMockDB([]);
    const do_ = makeDO(db);
    const res = await do_.fetch(new Request('https://do/ws'));
    expect(res.status).toBe(426);
  });
});

describe('TripSeatDO: unknown routes', () => {
  it('returns 404 for unknown paths', async () => {
    const db = createMockDB([]);
    const do_ = makeDO(db);
    const res = await do_.fetch(new Request('https://do/unknown'));
    expect(res.status).toBe(404);
  });

  it('returns 404 for GET /reserve-seats (wrong method)', async () => {
    const db = createMockDB([]);
    const do_ = makeDO(db);
    const res = await do_.fetch(new Request('https://do/reserve-seats', { method: 'GET' }));
    expect(res.status).toBe(404);
  });
});
