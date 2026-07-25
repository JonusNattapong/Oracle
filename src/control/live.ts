import WebSocket from "ws";
import type { ConnectionStatus } from "./ink-state.js";

export interface LiveUpdateOptions {
  url: string;
  onEvent: () => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

const RECONNECT_DELAYS = [2000, 5000, 10_000];
const POLL_FALLBACK_MS = 10_000;
const DEBOUNCE_MS = 250;

export interface LiveConnection {
  status: ConnectionStatus;
  dispose: () => void;
  lastEventAt: number;
}

export function connectLiveUpdates(options: LiveUpdateOptions): LiveConnection {
  const state: LiveConnection = {
    status: "offline",
    dispose: () => { /* placeholder — replaced below */ },
    lastEventAt: 0
  };

  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let socket: WebSocket | undefined;

  function debouncedEvent() {
    state.lastEventAt = Date.now();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!closed) options.onEvent();
    }, DEBOUNCE_MS);
  }

  function startPollFallback() {
    clearInterval(pollTimer as unknown as number);
    pollTimer = setInterval(() => {
      if (!closed) options.onEvent();
    }, POLL_FALLBACK_MS);
    (pollTimer as unknown as ReturnType<typeof setTimeout>).unref?.();
  }

  function stopPollFallback() {
    clearInterval(pollTimer as unknown as number);
    pollTimer = undefined;
  }

  function setStatus(status: ConnectionStatus) {
    state.status = status;
    options.onStatusChange(status);
  }

  function connect() {
    if (closed) return;
    try {
      socket = new WebSocket(options.url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.on("open", () => {
      reconnectAttempt = 0;
      setStatus("live");
      stopPollFallback();
      // refresh immediately on connect to catch up
      options.onEvent();
    });

    socket.on("message", () => {
      debouncedEvent();
    });

    socket.on("close", () => {
      socket = undefined;
      if (closed) return;
      setStatus("polling");
      startPollFallback();
      scheduleReconnect();
    });

    socket.on("error", () => {
      // close event follows error, so cleanup happens there
      socket?.close();
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      if (!closed) connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  connect();

  state.dispose = () => {
    closed = true;
    clearTimeout(reconnectTimer);
    clearTimeout(debounceTimer);
    stopPollFallback();
    socket?.close();
    socket = undefined;
  };

  return state;
}
