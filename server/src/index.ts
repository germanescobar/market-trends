import { serve } from "@hono/node-server";
import { createProvider } from "./providers/index.js";
import { createStorage } from "./storage/index.js";
import { AnalyticsService } from "./analytics.js";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

// Load .env from the repo root, overriding any pre-existing shell values.
// This makes the local-dev story predictable even when the user's shell
// exports unrelated variables like PORT.
loadEnv("../.env", { override: true });

const port = Number(process.env.PORT ?? 8987);
const ttlSeconds = Number(process.env.CACHE_TTL_SECONDS ?? 3600);

const provider = createProvider();
const storage = createStorage();
const analytics = new AnalyticsService(provider, {
  ttlSeconds,
  defaultFrequency: "monthly",
  storage,
});

const app = buildApp({ storage, analytics });

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${info.port}`);
  // eslint-disable-next-line no-console
  console.log(`[server] provider: ${provider.name}`);
});
