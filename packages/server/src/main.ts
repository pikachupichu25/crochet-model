// Starts the API server: `npm run server` (docs/SPEC.md §8). In development
// the Vite dev server proxies /api here, so the app and the API share an
// origin and the session cookie.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { createApp, jsonLogger } from "./app.ts";
import { createAuth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { ConsoleMailer } from "./mail.ts";
import { Store } from "./store.ts";

const config = loadConfig();
if (config.production) {
  // Verification and reset links must go by mail, not to the log (mail.ts).
  throw new Error("no mail transport is configured for production; see packages/server/src/mail.ts");
}

mkdirSync(dirname(config.databasePath), { recursive: true });
const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
const auth = await createAuth({ db, appOrigin: config.appOrigin, secret: config.authSecret, mailer: new ConsoleMailer() });
const store = new Store(db);
const app = createApp({ config, auth, store, log: jsonLogger() });

serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, ({ port }) => {
  console.log(`API on http://127.0.0.1:${port} for ${config.appOrigin}`);
});
