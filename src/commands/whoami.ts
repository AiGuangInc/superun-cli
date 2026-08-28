import type { Command } from "commander";
import { loadApp } from "../config/app.js";
import { decodeJwt, loadSession } from "../auth/session.js";

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("decode the JWT claims of the current session (decoded locally, signature not validated)")
    .option("--json", "machine-readable output")
    .action((opts) => {
      const app = loadApp();
      const s = loadSession(app.scopeId);
      if (!s) {
        console.log("Not logged in");
        process.exitCode = 1;
        return;
      }
      const claims = decodeJwt(s.access_token);
      if (opts.json) {
        console.log(JSON.stringify({ environment: app.environment, strategy: s.strategy, claims }, null, 2));
        return;
      }
      console.log(`environment: ${app.environment}`);
      console.log(`strategy:    ${s.strategy ?? "?"}`);
      console.log(`sub:      ${claims?.sub ?? "-"}`);
      console.log(`role:     ${claims?.role ?? "-"}`);
      console.log(`email:    ${claims?.email ?? "-"}`);
      if (claims?.exp) console.log(`exp:      ${new Date(claims.exp * 1000).toISOString()}`);
    });
}
