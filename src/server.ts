// Entry point for `npm run dev`: read config, wire the parts together, listen.
import "./runtime-check.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { createClock } from "./clock.ts";
import { loadConfig, missingKeys } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createLlmClient } from "./llm.ts";
import { createLogger } from "./log.ts";
import { createReader } from "./reader.ts";
import { createSearch } from "./search.ts";

const log = createLogger("server");

if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig(process.env);
const webOptions = { mode: config.webMode, tavilyApiKey: config.tavilyApiKey, fixturesDir: config.fixturesDir };

const app = createApp({
  config,
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  conversation: {
    llm: createLlmClient({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel }),
    search: createSearch(webOptions),
    reader: createReader(webOptions),
    db: openDatabase(config.dbPath),
    clock: createClock(),
  },
});

app.listen(config.port, "127.0.0.1", () => {
  const missing = missingKeys(config);
  log.info(`listening on http://127.0.0.1:${config.port}`, { mode: config.webMode });
  if (missing.length > 0) log.warn(`missing ${missing.join(", ")}; the page will say so`);
});
