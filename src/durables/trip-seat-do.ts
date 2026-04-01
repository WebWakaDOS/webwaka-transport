/**
 * P15-T2: TripSeatDO — Cloudflare Durable Object for real-time seat updates
 *
 * Maintains a WebSocket fan-out for a single trip's seat map.
 * Each trip gets its own DO instance keyed by tripId.
 *
 * Protocol:
 *   GET  /ws        — upgrade to WebSocket; receives seat_changed messages
 *   POST /broadcast — internal: broadcast a seat update to all connected clients
 *
 * Message format (broadcast → clients):
 *   { type: 'seat_changed', seat: { id, status, seat_number } }
 */
export class TripSeatDO implements DurableObject {
  private connections: Set<WebSocket> = new Set();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── WebSocket upgrade ──────────────────────────────────────
    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      server.accept();
      this.connections.add(server);

      server.addEventListener('close', () => {
        this.connections.delete(server);
      });
      server.addEventListener('error', () => {
        this.connections.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Internal broadcast ─────────────────────────────────────
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const data = await request.json() as { type: string; seat: unknown };
      const message = JSON.stringify(data);
      const dead: WebSocket[] = [];

      for (const ws of this.connections) {
        try {
          ws.send(message);
        } catch {
          dead.push(ws);
        }
      }

      for (const ws of dead) {
        this.connections.delete(ws);
      }

      return new Response('ok', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }
}
