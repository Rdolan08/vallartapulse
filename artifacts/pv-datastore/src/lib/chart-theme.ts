/**
 * chart-theme.ts
 *
 * Single source of truth for all Recharts tooltip styling across the app.
 * Import CHART_TOOLTIP (spread onto <Tooltip>) and TOOLTIP_CURSOR (add to bar
 * and area-chart <Tooltip> so the hover rectangle is invisible).
 *
 * Design intent: clean, Tableau-inspired — dark glass panel, tight padding,
 * muted uppercase label, bright value text, no distracting chrome.
 */

import type { CSSProperties } from "react";

export const TOOLTIP_CONTENT_STYLE: CSSProperties = {
  background: "#0F2A36",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "10px",
  boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
  padding: "10px 14px",
  fontSize: 13,
  color: "#F5F7FA",
  fontFamily: "inherit",
};

export const TOOLTIP_LABEL_STYLE: CSSProperties = {
  color: "#9AA5B1",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 4,
  padding: 0,
};

export const TOOLTIP_ITEM_STYLE: CSSProperties = {
  color: "#F5F7FA",
  fontSize: 13,
  padding: "1px 0",
};

/**
 * Transparent hover rectangle — prevents the distracting white pill
 * that Recharts renders by default on bar and area charts.
 * Pass as: <Tooltip cursor={TOOLTIP_CURSOR} ... />
 */
export const TOOLTIP_CURSOR = { fill: "rgba(255,255,255,0.04)" };

/**
 * Convenience spread for all standard Recharts <Tooltip> style props.
 *
 * Usage:
 *   <Tooltip {...CHART_TOOLTIP} formatter={...} />
 *
 * For bar / area charts also add:
 *   <Tooltip {...CHART_TOOLTIP} cursor={TOOLTIP_CURSOR} formatter={...} />
 */
export const CHART_TOOLTIP = {
  contentStyle: TOOLTIP_CONTENT_STYLE,
  labelStyle:   TOOLTIP_LABEL_STYLE,
  itemStyle:    TOOLTIP_ITEM_STYLE,
} as const;
