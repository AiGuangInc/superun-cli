import type { Command } from "commander";
import { loadApp } from "../config/app.js";
import { clearSession, saveSession, type Session } from "../auth/session.js";
import { loginWithBrowser, loginWithPassword, loginWithToken, notImplemented } from "../auth/strategies.js";

const BROWSER_CONTRACT = `
Browser login uses the Supabase project's built-in OAuth 2.1 authorization server (RFC 6749 §4.1 /
RFC 7636 PKCE / OIDC discovery / RFC 7591 Dynamic Client Registration). superun automatically:
  reads /auth/v1/.well-known/openid-configuration -> obtains a client_id -> exchanges an Authorization Code + PKCE for a token (Supabase serves the consent page).
client_id resolution order: --oauth-client-id / configured oauthClientId  ->  local cache  ->  Dynamic Client Registration (DCR).

Enable on the backend (platform side, in this project's Auth/GoTrue env):
  GOTRUE_OAUTH_SERVER_ENABLED=true
  GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION=true   # only if using DCR; see the security note below

WARNING - Security: enabling DCR lets anyone register a client with a custom redirect_uri, which amplifies
  consent phishing (a user is tricked into approving a spoofed client -> the authorization code is sent to an
  attacker's server -> leak).
  Safer: pre-register a superun client with the redirect locked to http://localhost, keep DCR disabled, and
  configure the client_id for the CLI:
      superun app set --oauth-client-id <id>

To use a non-Supabase OAuth authorization server, override the endpoints with --authorize-url / --token-url.
`;

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Log in and create a session (token / password / browser; otp and custom are not yet implemented)")
    .option("--token <jwt>", "supply an access token manually (a fallback that works with any app)")
    .option("--refresh <jwt>", "optional refresh token")
    .option("--password", "log in with a GoTrue email and password")
    .option("--email <email>", "use with --password")
    .option("--pass <password>", "use with --password")
    .option("--browser", "browser login (project OAuth 2.1 server, Authorization Code + PKCE; see help below for the contract)")
    .option("--oauth-client-id <id>", "pre-registered OAuth client_id (overrides config; falls back to cache/DCR if omitted)")
    .option("--authorize-url <url>", "override the authorization endpoint (when using your own OAuth AS)")
    .option("--token-url <url>", "override the token endpoint (when using your own OAuth AS)")
    .option("--port <n>", "local callback port for browser login (default 8976)")
    .option("--otp", "email one-time code (not yet implemented)")
    .option("--custom", "the app's own login endpoint (not yet implemented)")
    .addHelpText("after", BROWSER_CONTRACT)
    .action(async (opts) => {
      const app = loadApp();
      let session: Session;
      if (opts.token) {
        session = loginWithToken(opts.token, opts.refresh);
      } else if (opts.password) {
        if (!opts.email || !opts.pass) throw new Error("--password requires --email and --pass");
        session = await loginWithPassword(app, opts.email, opts.pass);
      } else if (opts.browser) {
        session = await loginWithBrowser(app, {
          port: opts.port ? Number(opts.port) : 8976,
          authorizeUrl: opts.authorizeUrl ?? app.authorizeUrl,
          tokenUrl: opts.tokenUrl ?? app.tokenUrl,
          clientId: opts.oauthClientId ?? app.oauthClientId,
        });
      } else if (opts.otp) {
        notImplemented("otp");
      } else if (opts.custom) {
        notImplemented("custom");
      } else {
        throw new Error("Specify a login method: --token / --password / --browser (see `superun login --help`)");
      }
      saveSession(app.id, session);
      console.log(`Logged in (strategy=${session.strategy}). Session saved; subsequent commands will use it automatically.`);
    });

  program
    .command("logout")
    .description("clear the local session")
    .action(() => {
      const app = loadApp();
      clearSession(app.id);
      console.log("Logged out");
    });
}
