import type { RuntimeError, WsMessage } from "../types/index.js";

type OnMsg = (msg: WsMessage) => void;
type OnErr = (e: RuntimeError, detail?: unknown) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private url = "";
  private retry = 0;
  private retryTimer = 0;
  private alive = false;

  constructor(private onMsg: OnMsg, private onErr: OnErr) {}

  connect(url: string): void {
    this.url = url;
    this.alive = true;
    this.open();
  }

  disconnect(): void {
    this.alive = false;
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = 0;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  send(msg: WsMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private open(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.onErr("WEBSOCKET_DISCONNECTED", e);
      return this.scheduleReconnect();
    }
    this.ws.onopen = () => {
      this.retry = 0;
    };
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsMessage;
        this.onMsg(msg);
      } catch (e) {
        // ignore malformed payloads — they just shouldn't be applied
        console.warn("[WsClient] bad payload", e);
      }
    };
    this.ws.onerror = (e) => {
      this.onErr("WEBSOCKET_DISCONNECTED", e);
    };
    this.ws.onclose = () => {
      this.ws = null;
      if (this.alive) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.retry++;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.retry, 6));
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }
}
