import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
// `CORS_ORIGINS` is a comma-separated allowlist of origins permitted to call
// the API.  Examples:
//
//   CORS_ORIGINS=https://www.vallartapulse.com,https://vallartapulse.com,\
//                https://vallartapulse.vercel.app,http://localhost:5173
//
// When unset (local single-origin dev, reverse-proxied deployments) the
// API echoes the request origin back, which mirrors the previous
// `cors()` default and keeps existing setups working.
const allowList = (process.env["CORS_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

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
      if (allowList.length === 0) return callback(null, true);
      if (allowList.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
