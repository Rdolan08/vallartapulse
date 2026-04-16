import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import { API_BASE_URL } from "./lib/api-base";
import "./index.css";

// When the API lives on a different origin than the frontend (e.g. split
// Vercel + Railway deployment), prefix every generated client request with
// that origin.  When unset, the client falls back to same-origin requests
// which is what local dev and proxy-based deployments expect.
if (API_BASE_URL) {
  setBaseUrl(API_BASE_URL);
}

createRoot(document.getElementById("root")!).render(<App />);
