export interface Env {
  ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // WebSocket: GET /ws/:roomCode?userId=xxx
    const wsMatch = url.pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
    if (wsMatch) {
      const roomCode = wsMatch[1].toUpperCase();
      const id = env.ROOM.idFromName(roomCode);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    // HTTP POST: /api/location/:roomCode (for background location updates)
    const apiMatch = url.pathname.match(/^\/api\/location\/([a-zA-Z0-9_-]+)$/);
    if (apiMatch && request.method === "POST") {
      const roomCode = apiMatch[1].toUpperCase();
      const id = env.ROOM.idFromName(roomCode);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

// --- Durable Object: LocationRoom ---

interface UserSession {
  ws: WebSocket;
  userId: string;
  name: string;
  lastLat?: number;
  lastLng?: number;
  lastTimestamp?: number;
}

export class LocationRoom {
  private sessions: UserSession[] = [];
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // HTTP POST location update (from background tasks)
    if (request.method === "POST" && url.pathname.startsWith("/api/location/")) {
      return this.handleHttpLocation(request);
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    // Client sends userId as query param
    const clientUserId = url.searchParams.get("userId");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleWebSocket(server, clientUserId);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleHttpLocation(request: Request): Promise<Response> {
    try {
      const data = await request.json() as any;
      if (data.lat === undefined || data.lng === undefined) {
        return new Response("Missing lat/lng", { status: 400 });
      }

      const userId = data.userId || `http-${data.name || "anon"}`;

      // Update existing session's location if it matches userId
      for (const s of this.sessions) {
        if (s.userId === userId) {
          s.lastLat = data.lat;
          s.lastLng = data.lng;
          s.lastTimestamp = Date.now();
          s.name = data.name || s.name;
        }
      }

      const msg = JSON.stringify({
        type: "location",
        userId,
        lat: data.lat,
        lng: data.lng,
        name: data.name || "Anonim",
        timestamp: Date.now(),
      });

      for (const s of this.sessions) {
        if (s.userId !== userId) {
          try { s.ws.send(msg); } catch {}
        }
      }

      return new Response("ok", {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  }

  private handleWebSocket(ws: WebSocket, clientUserId: string | null) {
    ws.accept();

    const userId = clientUserId || crypto.randomUUID();

    // If this userId already has a session, close the old one silently
    const oldSession = this.sessions.find((s) => s.userId === userId);
    if (oldSession) {
      try { oldSession.ws.close(1000, "replaced"); } catch {}
      this.sessions = this.sessions.filter((s) => s !== oldSession);
    }

    const session: UserSession = { ws, userId, name: "anonymous" };
    this.sessions.push(session);

    // Confirm userId to client
    ws.send(JSON.stringify({ type: "welcome", userId }));

    this.broadcastUserCount();

    // Send existing users' last locations to the new client
    for (const s of this.sessions) {
      if (s !== session && s.lastLat !== undefined && s.lastLng !== undefined) {
        ws.send(JSON.stringify({
          type: "location",
          userId: s.userId,
          lat: s.lastLat,
          lng: s.lastLng,
          name: s.name,
          timestamp: s.lastTimestamp || Date.now(),
        }));
      }
    }

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);

        if (data.lat !== undefined && data.lng !== undefined) {
          session.name = data.name || "anonymous";
          session.lastLat = data.lat;
          session.lastLng = data.lng;
          session.lastTimestamp = Date.now();

          const msg = JSON.stringify({
            type: "location",
            userId: session.userId,
            lat: data.lat,
            lng: data.lng,
            name: session.name,
            timestamp: session.lastTimestamp,
          });

          for (const s of this.sessions) {
            if (s !== session) {
              try { s.ws.send(msg); } catch {}
            }
          }
        }
      } catch {}
    });

    ws.addEventListener("close", () => {
      this.removeSession(session);
    });

    ws.addEventListener("error", () => {
      this.removeSession(session);
    });
  }

  private removeSession(session: UserSession) {
    this.sessions = this.sessions.filter((s) => s !== session);
    this.broadcast(JSON.stringify({ type: "user_left", userId: session.userId, name: session.name }));
    this.broadcastUserCount();
  }

  private broadcastUserCount() {
    this.broadcast(JSON.stringify({ type: "users", count: this.sessions.length }));
  }

  private broadcast(message: string) {
    for (const s of this.sessions) {
      try { s.ws.send(message); } catch {}
    }
  }
}
