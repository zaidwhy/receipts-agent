// `npm run seed`: puts the demo history into the database. Works offline: the archive captures
// behind it were recorded once and are committed in fixtures/seed/captures.json.
import { createClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { loadEnvIfPresent } from "../src/env.ts";
import { describeSeed, loadSeedFixture, seedDemoHistory } from "../src/seed.ts";

loadEnvIfPresent();
const config = loadConfig(process.env);
const timeZone = process.env.SEED_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const db = openDatabase(config.dbPath);
const report = seedDemoHistory(db, { fixture: loadSeedFixture(), now: createClock().now(), timeZone });
console.log(describeSeed(report));
console.log(`database: ${config.dbPath}  time zone: ${timeZone}`);
