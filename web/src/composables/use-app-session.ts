import { ref } from "vue";
import {
  bootstrapPluginSession,
  decodeJwt,
  type SessionHandle,
} from "@karyl-chan/plugin-sdk/web";
import { setApi, setGameSession } from "../api";

/**
 * App-level routing between the QuestGame WebUI surfaces:
 *
 *  - `manage` — admin panel (`/quest-game manage`): a capability-
 *    bearing bot JWT, exchanged by the SDK for a plugin-issued
 *    access/refresh pair.
 *  - `game`   — per-player board (`/quest-game webui`): a
 *    capability-less session JWT plus `?c=<channelId>` + `?s=<sessionId>`.
 *  - `manual` — public reference content; pure path-based, no JWT.
 *
 * The QuestGame bot CLI emits a single `?token=…` link for both
 * surfaces (no `?surface=` query param), so we lean on the SDK's
 * `surfaceFromClaims` resolver (0.5+) to derive surface from the
 * token's capabilities. Tab reload restores from sessionStorage
 * automatically.
 */
export type AppMode = "loading" | "denied" | "manage" | "game" | "manual";

const PLUGIN_KEY = "karyl-quest-game";
const MANAGE_CAP_TOKEN = `plugin:${PLUGIN_KEY}:manage`;

const mode = ref<AppMode>("loading");
const deniedMessage = ref<string | null>(null);

let sessionHandle: SessionHandle | null = null;

function deny(message: string): void {
  deniedMessage.value = message;
  mode.value = "denied";
}

function hasManageCaps(claims: { capabilities?: unknown } | null): boolean {
  const caps = Array.isArray(claims?.capabilities)
    ? (claims!.capabilities as string[])
    : [];
  return caps.includes("admin") || caps.includes(MANAGE_CAP_TOKEN);
}

export async function bootstrapApp(): Promise<void> {
  // The /manual route is public reference content — no token, no
  // session; the SPA routes to it purely on the path.
  if (window.location.pathname.replace(/\/+$/, "").endsWith("/manual")) {
    mode.value = "manual";
    return;
  }

  // Quest-game's link URLs don't carry `?surface=` — the bot CLI
  // emits `/?token=…&c=…&s=…`. Peek at the URL token's capabilities
  // ourselves to decide whether to ask the SDK for the JWT-exchange
  // flow (manage tier, refreshable pair) or the direct-bearer flow
  // (game tier, single JWT used as Bearer).
  const urlToken = new URLSearchParams(window.location.search).get("token");
  const urlClaims = urlToken ? decodeJwt(urlToken) : null;
  const wantsExchange = urlClaims ? hasManageCaps(urlClaims) : false;

  const handle = await bootstrapPluginSession({
    pluginKey: PLUGIN_KEY,
    exchangeJwt: wantsExchange,
    extraUrlParams: ["c", "s"],
    onAccessDenied: (msg) =>
      deny(msg || "存取遭拒，請重新取得連結。"),
  });
  sessionHandle = handle;
  setApi(handle.api);

  if (handle.denied) {
    if (mode.value !== "denied") {
      deny(handle.deniedReason ?? "存取遭拒，請重新取得連結。");
    }
    return;
  }

  if (!handle.isAuthenticated) {
    deny("請在 Discord 內透過 /quest-game webui 或 /quest-game manage 取得連結。");
    return;
  }

  // Tab reload — SDK restored the auth state from sessionStorage but
  // has no decoded claims for us. Manage tier resumes cleanly (the
  // pair survived); game tier needs `?c=` / `?s=` which were stripped,
  // so re-prompt the user.
  if (!handle.claims) {
    if (handle.hasRefreshPair) {
      mode.value = "manage";
      return;
    }
    deny("瀏覽器重新整理遺失頻道資訊，請重新執行 /quest-game webui。");
    return;
  }

  // Fresh URL token — we already decoded its caps above to pick the
  // flow. Branch on the same signal so the routing decision matches
  // what the SDK actually did.
  if (wantsExchange) {
    mode.value = "manage";
    return;
  }

  // Game-board tier — needs `?c=<channelId>` from the link.
  const channelId = handle.urlParams["c"];
  if (!channelId) {
    deny("遊戲板連結缺少頻道資訊，請重新執行 /quest-game webui。");
    return;
  }
  setGameSession({
    channelId,
    sessionId: handle.urlParams["s"] ?? "",
  });
  mode.value = "game";
}

export function useAppSession() {
  return {
    mode,
    deniedMessage,
    bootstrap: bootstrapApp,
    /** Underlying SDK handle for advanced consumers. */
    handle: (): SessionHandle | null => sessionHandle,
  };
}
