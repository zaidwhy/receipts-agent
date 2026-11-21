// Loads the local environment file when there is one. A fresh clone has none, and that is fine:
// the server then boots and says which keys are missing.
import { existsSync } from "node:fs";

export function loadEnvIfPresent(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
