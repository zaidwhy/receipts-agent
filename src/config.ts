// All environment variables are read here, once, so the rest of the code takes plain values.
export type WebMode = "live" | "record" | "replay";

export interface Config {
  port: number;
  webMode: WebMode;
  tavilyApiKey: string | undefined;
  llmBaseUrl: string;
  llmApiKey: string | undefined;
  llmModel: string;
  dbPath: string;
  fixturesDir: string;
  speculativeSearch: boolean;
  compactPrompt: boolean;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const mode = clean(env.WEB_MODE) ?? "live";
  if (mode !== "live" && mode !== "record" && mode !== "replay") {
    throw new Error(`WEB_MODE must be live, record or replay, got "${mode}"`);
  }
  return {
    port: Number(clean(env.PORT) ?? 3000),
    webMode: mode,
    tavilyApiKey: clean(env.TAVILY_API_KEY),
    llmBaseUrl: clean(env.LLM_BASE_URL) ?? "https://openrouter.ai/api/v1",
    llmApiKey: clean(env.LLM_API_KEY),
    llmModel: clean(env.LLM_MODEL) ?? "nvidia/nemotron-3.5-super-vl:free",
    dbPath: clean(env.DB_PATH) ?? "data/agent.db",
    fixturesDir: clean(env.FIXTURES_DIR) ?? "fixtures/web",
    speculativeSearch: clean(env.SPECULATIVE_SEARCH) === "1",
    compactPrompt: clean(env.COMPACT_PROMPT) === "1",
  };
}

// Replay mode reads saved fixtures, so it does not need a Tavily key.
export function missingKeys(config: Config): string[] {
  const missing: string[] = [];
  if (config.webMode !== "replay" && !config.tavilyApiKey) missing.push("TAVILY_API_KEY");
  if (!config.llmApiKey) missing.push("LLM_API_KEY");
  return missing;
}
