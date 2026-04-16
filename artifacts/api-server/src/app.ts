import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
// `CORS_ORIGINS` is a comma-separated allowlist of origins permitted to call
// the API.  Each entry is one of:
//
//   - an exact origin                e.g. https://www.vallartapulse.com
//   - a regex literal /…/[flags]     e.g. /^https:\/\/.*\.vercel\.app$/
//
// When unset (local single-origin dev, reverse-proxied deployments) the
// API echoes the request origin back, which mirrors the previous
// `cors()` default and keeps existing setups working.
const rawCorsEntries = (process.env["CORS_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const exactOrigins: string[] = [];
const originPatterns: RegExp[] = [];

for (const entry of rawCorsEntries) {
  const match = entry.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    try {
      originPatterns.push(new RegExp(match[1]!, match[2]!));
    } catch (err) {
      logger.error({ err, entry }, "Invalid CORS regex — ignoring");
    }
  } else {
    exactOrigins.push(entry);
  }
}

function isOriginAllowed(origin: string): boolean {
  if (exactOrigins.includes(origin)) return true;
  return originPatterns.some((re) => re.test(origin));
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      // Same-origin requests, curl, server-to-server, health checks: no Origin header.
      if (!origin) return callback(null, true);
      // No allowlist configured → permissive (matches previous behaviour).
      if (exactOrigins.length === 0 && originPatterns.length === 0) {
        return callback(null, true);
      }
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
