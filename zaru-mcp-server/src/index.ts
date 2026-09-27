// Load .env before any other module is evaluated: several modules read
// process.env at import time (auth.ts, the orchestrator clients).
import "dotenv/config";
import { app } from "./app.js";
import { logError, logInfo } from "./logging.js";

const PORT = process.env.PORT || 3000;
const startedAt = Date.now();

app.listen(PORT, () => {
  logInfo("server.startup", {
    port: Number(PORT),
    upstream_url: process.env.AEGIS_ORCHESTRATOR_URL ?? "http://localhost:8088",
    auth_mode: process.env.AEGIS_API_KEY_VALIDATION_URL ? "jwt+api_key" : "jwt",
    log_level: process.env.LOG_LEVEL ?? "info",
    node_version: process.version,
    pid: process.pid,
  });
});

function gracefulShutdown(signal: string): void {
  logInfo("server.shutdown", {
    signal,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
  });
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logError("server.crash", { reason: "uncaughtException", error: err });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logError("server.crash", {
    reason: "unhandledRejection",
    error: reason instanceof Error ? reason : { message: String(reason) },
  });
  process.exit(1);
});

export { app };
