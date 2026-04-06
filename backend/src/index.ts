export interface Env {
  ROOM: DurableObjectNamespace;
}

// --- Worker entrypoint ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // WebSocket endpoint: /ws/:roomCode
    const wsMatch = url.pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
    if (wsMatch) {
      const roomCode = wsMatch[1].toUpperCase();
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
  name: string;
}

export class LocationRoom {
  private sessions: UserSession[] = [];
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    if (this.sessions.length >= 2) {
      return new Response("Room is full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleWebSocket(ws: WebSocket) {
    ws.accept();

    const session: UserSession = { ws, name: "anonymous" };
    this.sessions.push(session);

    // Notify both sides of current user count
    this.broadcast(JSON.stringify({ type: "users", count: this.sessions.length }));

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);

        if (data.lat !== undefined && data.lng !== undefined) {
          session.name = data.name || "anonymous";

          const msg = JSON.stringify({
            type: "location",
            lat: data.lat,
            lng: data.lng,
            name: session.name,
            timestamp: Date.now(),
          });

          // Send to the OTHER user only
          for (const s of this.sessions) {
            if (s !== session) {
              try {
                s.ws.send(msg);
              } catch {
                // connection dead, will be cleaned up on close
              }
            }
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.addEventListener("close", () => {
      this.sessions = this.sessions.filter((s) => s !== session);
      this.broadcast(JSON.stringify({ type: "users", count: this.sessions.length }));
    });

    ws.addEventListener("error", () => {
      this.sessions = this.sessions.filter((s) => s !== session);
      this.broadcast(JSON.stringify({ type: "users", count: this.sessions.length }));
    });
  }

  private broadcast(message: string) {
    for (const s of this.sessions) {
      try {
        s.ws.send(message);
      } catch {
        // ignore
      }
    }
  }
}
