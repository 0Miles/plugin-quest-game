import { buildPlugin } from "./plugin.js";
import { wireRuntime } from "./flow/dispatcher.js";
import {
  effectiveBase,
  setQuestGamePublicBaseUrl,
  setQuestGameSessionVerifyKey,
} from "./web-routes.js";

const started = await buildPlugin().start();
// Hand the live bot RPC + logger into the component dispatcher — the
// individual flow files share them via a single module-level handle so
// they don't all have to thread `started` through every call site.
wireRuntime({
  botRpc: started.botRpc,
  discord: started.discord,
  voice: started.voice,
  log: {
    info: (msg, meta) => started.server.log.info(meta ?? {}, msg),
    warn: (msg, meta) => started.server.log.warn(meta ?? {}, msg),
    error: (msg, meta) => started.server.log.error(meta ?? {}, msg),
  },
  publicBaseUrl: effectiveBase,
});
// Web-routes' auth needs the bot's Ed25519 public key + the
// publicBaseUrl, both of which only exist after start() resolves —
// wire them here so subsequent /api/manage/* calls can verify the
// SPA's bot-session JWT.
setQuestGameSessionVerifyKey(() => started.getSessionVerifyPublicKey());
setQuestGamePublicBaseUrl(() => started.getPublicBaseUrl());
