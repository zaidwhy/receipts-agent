// Imported first by server.ts so a Node without node:sqlite fails with a clear
// message instead of a stack trace from db.ts.
import { isBuiltin } from "node:module";

if (!isBuiltin("node:sqlite")) {
  process.stderr.write(
    `This project needs Node 22.13 or newer because it uses the built-in node:sqlite module. You are running ${process.version}.\n`,
  );
  process.exit(1);
}
