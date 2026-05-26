// Browser-side API client for the QuestGame SPA. Built on
// @karyl-chan/plugin-sdk/web's `bootstrapPluginSession` orchestrator —
// JWT decode, manage exchange, refresh, sessionStorage restore and
// the authed fetch wrapper all live inside the SessionHandle owned by
// `use-app-session.ts`. This module exposes the typed feature
// endpoints; it receives the `PluginApi` via `setApi` once bootstrap
// resolves and the game-board session ids via `setGameSession`.

import {
  API_BASE,
  type PluginApi,
} from "@karyl-chan/plugin-sdk/web";

import type { GameSnapshotView, ManualData } from "./game-types";

// ── Auth + bootstrap handles ──────────────────────────────────────────
// Wired at bootstrap time from `use-app-session.ts` — `setApi` from
// `bootstrap.api`, and `setGameSession` from the URL params the
// bootstrap stripped. Both throw on access before bootstrap resolves
// (boot bug — bootstrap must finish before any view consumes them).

let _api: PluginApi | null = null;

export function setApi(api: PluginApi): void {
  _api = api;
}

function api(): PluginApi {
  if (!_api) {
    throw new Error("quest-game api used before bootstrapPluginSession resolved");
  }
  return _api;
}

interface GameSession {
  channelId: string;
  /** Empty for legacy links issued before sessionId routing. */
  sessionId: string;
}

let _game: GameSession | null = null;

export function setGameSession(s: GameSession): void {
  _game = s;
}

export function currentChannelId(): string | null {
  return _game?.channelId ?? null;
}

export function currentSessionId(): string {
  return _game?.sessionId ?? "";
}

export { API_BASE };

// ── Errors ─────────────────────────────────────────────────────────────
// PluginApi.request rejects with a plain Error on non-2xx; callers that
// need the HTTP status (404 vs 500 etc.) can still narrow via the
// message text. `HttpError` is preserved for legacy callers that read
// the optional `.status` field.

/** An Error carrying the HTTP status that produced it. */
export interface HttpError extends Error {
  status?: number;
}

// ── Manage surface (auto access/refresh handled by SDK) ──────────────

export function manageDelete(path: string): Promise<void> {
  return api().request<void>("DELETE", path);
}

export function manageGet<T>(path: string): Promise<T> {
  return api().request<T>("GET", path);
}

export function managePost<T>(path: string, body?: unknown): Promise<T> {
  return api().request<T>("POST", path, body);
}

export function manageUpload<T>(path: string, file: File): Promise<T> {
  return api().upload<T>(path, file);
}

// ── Game-board surface ────────────────────────────────────────────────
// Same `api()` handle — the SDK's auth state holds the session JWT
// after bootstrap, so every `request` carries the right bearer
// regardless of mode. Helpers below preserve the previous call-site
// shape so use-game-board.ts / GameBoardView.vue don't have to learn
// the new wire format.

export function gameApi<T>(path: string): Promise<T> {
  return api().request<T>("GET", path);
}

/**
 * Hard timeout for a player-driven action. A stuck connection must
 * surface as a failed action the player can retry, never an action
 * button frozen forever.
 */
const GAME_ACTION_TIMEOUT_MS = 12_000;

export async function postGameAction(
  action: string,
  extra: { seat?: number; vote?: string },
): Promise<GameSnapshotView> {
  if (!_game) {
    const err: HttpError = new Error("no game session");
    err.status = 401;
    throw err;
  }
  // PluginApi.request doesn't expose abort, so race the timeout at
  // this layer — the rejection surfaces to the UI; the underlying
  // fetch is left to settle in the background (it'll either succeed
  // silently or hit fetch's own ceiling).
  const request = api().request<GameSnapshotView>("POST", "/api/game/action", {
    channel: _game.channelId,
    session: _game.sessionId,
    action,
    ...extra,
  });
  return Promise.race([
    request,
    new Promise<GameSnapshotView>((_, reject) =>
      setTimeout(() => reject(new Error("Action timed out — please retry.")), GAME_ACTION_TIMEOUT_MS),
    ),
  ]);
}

/** Mint a short-lived SSE ticket (EventSource can't send headers). */
export async function mintSseTicket(): Promise<string> {
  const body = await api().request<{ ticket?: string }>(
    "POST",
    "/api/game/sse-ticket",
  );
  if (typeof body?.ticket !== "string") {
    throw new Error("malformed ticket response");
  }
  return body.ticket;
}

export function gameSseUrl(
  channelId: string,
  sessionId: string,
  ticket: string,
): string {
  return (
    `${API_BASE}/api/game/events` +
    `?channel=${encodeURIComponent(channelId)}` +
    `&session=${encodeURIComponent(sessionId)}` +
    `&ticket=${encodeURIComponent(ticket)}`
  );
}

// ── Legacy aliases ────────────────────────────────────────────────────
// Existing call sites (use-art.ts, use-games-poll.ts) imported `api` /
// `apiUpload` as named functions. Keep the names so the migration
// touches a single layer.

export function api_<T>(method: string, path: string, body?: unknown): Promise<T> {
  return api().request<T>(method, path, body);
}
export { api_ as api };

export function apiUpload<T>(path: string, file: File): Promise<T> {
  return api().upload<T>(path, file);
}

// ── Public manual (unauthenticated reference content) ────────────────

export async function getManual(): Promise<ManualData> {
  const res = await fetch(`${API_BASE}/api/manual`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ManualData>;
}

declare global {
  interface Window {
    __PLUGIN_BASE__?: string;
  }
}
