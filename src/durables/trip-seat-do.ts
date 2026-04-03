/**
 * TripSeatDO — Cloudflare Durable Object for per-trip seat serialization
 *
 * T-TRN-01: Multi-Seat Atomic Reservation Engine
 *
 * Each trip gets its own DO instance keyed by tripId via `idFromName(tripId)`.
 * Because Durable Objects run on a single-threaded JS event loop, all requests
 * to the same instance are serialized automatically — eliminating double-booking
 * races that D1 optimistic locking alone cannot prevent across multiple Workers.
 *
 * In-memory state:
 *   heldSeats: Map<seatId, HeldSeat> — fast conflict check without D1 read
 *
 * D1 is always the source of truth; the DO writes through on every reservation.
 * In-memory state is re-hydrated from D1 on the first request after hibernation.
 *
 * Endpoints:
 *   POST /reserve-seats  — atomically reserve N seats for a trip
 *   POST /release-seats  — release previously held seats (token-verified)
 *   GET  /ws             — WebSocket upgrade for real-time seat fan-out
 *   POST /broadcast      — internal: fan-out a seat_changed message to WS clients
 */
import type { Env } from '../api/types.js';

interface HeldSeat {
  token: string;
  expiresAt: number;
  userId: string;
}

interface ReserveSeatsBody {
  seat_ids: string[];
  user_id: string;
  ttl_ms: number;
  trip_id: string;
  tokens: Record<string, string>;
}

interface ReleaseSeatsBody {
  seat_ids: string[];
  tokens: Record<string, string>;
  trip_id: string;
}

export class TripSeatDO implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  private heldSeats: Map<string, HeldSeat> = new Map();
  private hydrated = false;
  private connections: Set<WebSocket> = new Set();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── WebSocket upgrade ──────────────────────────────────────────────────
    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      server.accept();
      this.connections.add(server);

      server.addEventListener('close', () => { this.connections.delete(server); });
      server.addEventListener('error', () => { this.connections.delete(server); });

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Internal fan-out ───────────────────────────────────────────────────
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const data = await request.json() as { type: string; seat: unknown };
      const message = JSON.stringify(data);
      const dead: WebSocket[] = [];

      for (const ws of this.connections) {
        try { ws.send(message); } catch { dead.push(ws); }
      }
      for (const ws of dead) { this.connections.delete(ws); }

      return new Response('ok', { status: 200 });
    }

    // ── T-TRN-01: Atomic multi-seat reservation ────────────────────────────
    if (url.pathname === '/reserve-seats' && request.method === 'POST') {
      return this.handleReserveSeats(request);
    }

    // ── T-TRN-01: Token-verified seat release ──────────────────────────────
    if (url.pathname === '/release-seats' && request.method === 'POST') {
      return this.handleReleaseSeats(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  // ── Private: sweep expired holds from in-memory map ─────────────────────
  private sweepExpired(): void {
    const now = Date.now();
    for (const [seatId, held] of this.heldSeats) {
      if (held.expiresAt <= now) {
        this.heldSeats.delete(seatId);
      }
    }
  }

  // ── Private: load active reservations from D1 on cold-start / hibernation
  private async hydrate(tripId: string): Promise<void> {
    if (this.hydrated) return;
    const db = this.env.DB;
    if (!db) { this.hydrated = true; return; }

    const now = Date.now();
    try {
      const result = await db.prepare(
        `SELECT id, reservation_token, reservation_expires_at, reserved_by
         FROM seats
         WHERE trip_id = ? AND status = 'reserved' AND reservation_expires_at > ?`
      ).bind(tripId, now).all<{
        id: string;
        reservation_token: string | null;
        reservation_expires_at: number;
        reserved_by: string | null;
      }>();

      for (const seat of result.results) {
        if (seat.reservation_token) {
          this.heldSeats.set(seat.id, {
            token: seat.reservation_token,
            expiresAt: seat.reservation_expires_at,
            userId: seat.reserved_by ?? '',
          });
        }
      }
    } catch {
      // Non-fatal: proceed without hydration; D1 WHERE clause is the true guard
    }
    this.hydrated = true;
  }

  // ── POST /reserve-seats ───────────────────────────────────────────────────
  // Because this DO is single-threaded, concurrent callers queue behind this
  // await chain. The in-memory check is a fast early-reject; the D1 write
  // with WHERE status = 'available' is the authoritative atomic gate.
  private async handleReserveSeats(request: Request): Promise<Response> {
    let body: ReserveSeatsBody;
    try {
      body = await request.json() as ReserveSeatsBody;
    } catch {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const { seat_ids, user_id, ttl_ms, trip_id, tokens } = body;

    if (!Array.isArray(seat_ids) || seat_ids.length === 0) {
      return Response.json({ success: false, error: 'seat_ids must be a non-empty array' }, { status: 400 });
    }
    if (!trip_id || !user_id) {
      return Response.json({ success: false, error: 'trip_id and user_id are required' }, { status: 400 });
    }

    // 1. Hydrate from D1 if this DO just woke from hibernation
    await this.hydrate(trip_id);

    // 2. Sweep expired holds from in-memory state before checking
    this.sweepExpired();

    // 3. Fast-path: check in-memory held set for conflicts
    const conflicted = seat_ids.filter(id => this.heldSeats.has(id));
    if (conflicted.length > 0) {
      return Response.json({
        success: false,
        error: 'seat_unavailable',
        conflicted_seats: conflicted,
        message: 'One or more seats are not available',
      }, { status: 409 });
    }

    // 4. Write through to D1 — the WHERE clause is the ultimate atomic guard
    const now = Date.now();
    const expiresAt = now + ttl_ms;
    const db = this.env.DB;

    const updateStmts = seat_ids.map(seatId =>
      db.prepare(
        `UPDATE seats
         SET status = 'reserved', reserved_by = ?, reservation_token = ?,
             reservation_expires_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND trip_id = ? AND status = 'available'`
      ).bind(user_id, tokens[seatId], expiresAt, now, seatId, trip_id)
    );

    let batchResults: Array<{ meta?: { changes?: number } }> = [];
    try {
      batchResults = await db.batch(updateStmts) as Array<{ meta?: { changes?: number } }>;
    } catch {
      return Response.json({ success: false, error: 'Failed to write reservation to database' }, { status: 500 });
    }

    // 5. Detect any seats that didn't update (status was not 'available' in D1)
    const failedIds = seat_ids.filter((_, i) => (batchResults[i]?.meta?.changes ?? 0) === 0);

    if (failedIds.length > 0) {
      // Compensating transaction: release any seats that DID succeed
      const successIds = seat_ids.filter((_, i) => (batchResults[i]?.meta?.changes ?? 0) > 0);
      if (successIds.length > 0) {
        db.batch(
          successIds.map(seatId =>
            db.prepare(
              `UPDATE seats
               SET status = 'available', reserved_by = NULL, reservation_token = NULL,
                   reservation_expires_at = NULL, updated_at = ?
               WHERE id = ? AND reservation_token = ?`
            ).bind(now, seatId, tokens[seatId])
          )
        ).catch(() => {});
      }
      return Response.json({
        success: false,
        error: 'concurrent_conflict',
        message: 'Seat taken by another agent — please retry',
      }, { status: 409 });
    }

    // 6. Update in-memory state — now the DO knows these seats are held
    for (const seatId of seat_ids) {
      this.heldSeats.set(seatId, {
        token: tokens[seatId]!,
        expiresAt,
        userId: user_id,
      });
    }

    return Response.json({
      success: true,
      data: {
        tokens: seat_ids.map(seatId => ({
          seat_id: seatId,
          token: tokens[seatId],
          expires_at: expiresAt,
        })),
        expires_at: expiresAt,
      },
    }, { status: 200 });
  }

  // ── POST /release-seats ───────────────────────────────────────────────────
  // Token-verified release: removes from in-memory map AND updates D1.
  // Called by the HTTP release endpoint so DO state stays consistent.
  private async handleReleaseSeats(request: Request): Promise<Response> {
    let body: ReleaseSeatsBody;
    try {
      body = await request.json() as ReleaseSeatsBody;
    } catch {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const { seat_ids, tokens, trip_id } = body;

    if (!Array.isArray(seat_ids) || seat_ids.length === 0) {
      return Response.json({ success: false, error: 'seat_ids must be a non-empty array' }, { status: 400 });
    }

    const now = Date.now();
    const db = this.env.DB;

    // Release in D1 — only if the token matches (prevents unauthorized release)
    db.batch(
      seat_ids.map(seatId =>
        db.prepare(
          `UPDATE seats
           SET status = 'available', reserved_by = NULL, reservation_token = NULL,
               reservation_expires_at = NULL, updated_at = ?
           WHERE id = ? AND trip_id = ? AND reservation_token = ?`
        ).bind(now, seatId, trip_id, tokens[seatId])
      )
    ).catch(() => {});

    // Update in-memory state
    for (const seatId of seat_ids) {
      this.heldSeats.delete(seatId);
    }

    return Response.json({ success: true });
  }
}
