import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Building2, MapPin, BedDouble, Bath, Ruler, Waves, Star,
  CheckCircle2, XCircle, AlertTriangle, ChevronDown, ChevronUp,
  Info, TrendingUp, ArrowRight, Loader2, RefreshCw, RotateCcw,
  Tag, DollarSign, BarChart3, Building, ArrowLeftRight,
  CalendarClock, Crosshair, Link2, Sparkles,
} from "lucide-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";

// ── Unit system ────────────────────────────────────────────────────────────────
type UnitSystem = "imperial" | "metric";

// Convert user-facing distance → meters for API
function toMeters(val: number, units: UnitSystem) {
  return units === "imperial" ? Math.round(val * 0.3048) : Math.round(val);
}
// Convert user-facing size → sqft for API
function toSqft(val: number, units: UnitSystem) {
  return units === "imperial" ? Math.round(val) : Math.round(val * 10.764);
}

const BEACH_PRESETS_IMPERIAL = [
  { label: "Beachfront (≤150 ft)", ft: 50 },
  { label: "Beach block / steps (~150 ft)", ft: 150 },
  { label: "1–2 blocks (~300 ft)", ft: 300 },
  { label: "3–5 blocks (~600 ft)", ft: 600 },
  { label: "6–10 blocks (~1200 ft)", ft: 1200 },
];
const BEACH_PRESETS_METRIC = [
  { label: "Beachfront (≤50 m)", m: 15 },
  { label: "Beach block / steps (~50 m)", m: 50 },
  { label: "1–2 blocks (~100 m)", m: 100 },
  { label: "3–5 blocks (~200 m)", m: 200 },
  { label: "6–10 blocks (~400 m)", m: 400 },
];

// ── Types ──────────────────────────────────────────────────────────────────────
type Neighborhood =
  | "Zona Romantica" | "Amapas" | "Centro" | "Hotel Zone"
  | "5 de Diciembre" | "Old Town" | "Versalles" | "Marina Vallarta"
  | "Nuevo Vallarta" | "Bucerias" | "La Cruz de Huanacaxtle"
  | "Punta Mita" | "El Anclote" | "Sayulita" | "San Pancho" | "Mismaloya";

interface FormValues {
  neighborhood: Neighborhood;
  buildingName: string;
  crossStreet1: string;      // first cross street
  crossStreet2: string;      // second cross street
  buildingYear: string;      // approximate year built range
  listingUrl: string;        // Airbnb / VRBO / PVRPV link — future AI evaluation
  bedrooms: 1 | 2 | 3 | 4;
  bathrooms: number;
  size: string;       // sqft (imperial) or m² (metric) — display unit
  distance: string;   // ft (imperial) or m (metric) — display unit
  ratingOverall: string;
}

interface AmenityDef {
  amenity_key: string;
  display_label: string;
  display_label_es: string;
  category: string;
}

interface BuildingEntry {
  canonical_building_name: string;
  neighborhood_normalized: string;
  listing_count: number;
  median_price: number | null;
  thin_sample: boolean;
}

interface PrepareResult {
  ready_for_comps: boolean;
  building_resolution: {
    canonical_building_name: string | null;
    match_confidence: number | null;
    confidence_tier: "high" | "medium" | "low" | null;
    match_strategy: string | null;
    suggestions: { canonical: string; neighborhood: string; score: number }[];
    warning: string | null;
  } | null;
  amenity_validation: {
    accepted_keys: string[];
    rejected_keys: string[];
    suggested_corrections: { input: string; suggestion: string }[];
  };
  cleaned_input: {
    building_name: string | null;
    amenities_normalized: string[];
  };
  warnings: string[];
}

interface CompEntry {
  rank: number;
  external_id: string;
  source_url: string;
  neighborhood: string;
  bedrooms: number;
  bathrooms: number;
  sqft: number | null;
  distance_to_beach_m: number;
  beach_tier: string;
  nightly_price_usd: number;
  rating_overall: number | null;
  building_name: string | null;
  score: number;
  match_reasons: string[];
}

interface CompsResult {
  target_summary: {
    neighborhood: string;
    bedrooms: number;
    bathrooms: number;
    beach_tier: string;
    building_normalized: string | null;
    building_premium_pct: number | null;
    segment_median: number;
  };
  pool_size: number;
  thin_pool_warning: boolean;
  confidence_label: "high" | "medium" | "low" | "guidance_only";
  conservative_price: number;
  recommended_price: number;
  stretch_price: number;
  building_adjustment_pct: number | null;
  beach_tier_adjustment_pct: number | null;
  selected_comps: CompEntry[];
  top_drivers: string[];
  explanation: string;
  warnings: string[];
  model_limitations: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────
const BATH_OPTIONS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
const RATING_OPTIONS = Array.from({ length: 41 }, (_, i) =>
  parseFloat((1 + i * 0.1).toFixed(1))
);

const CONFIDENCE_CONFIG: Record<string, { label: string; labelEs: string; color: string; bg: string; border: string }> = {
  high:          { label: "High Confidence",   labelEs: "Alta Confianza",    color: "#00C2A8", bg: "rgba(0,194,168,0.12)",  border: "rgba(0,194,168,0.3)" },
  medium:        { label: "Medium Confidence", labelEs: "Confianza Media",   color: "#F59E0B", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)" },
  low:           { label: "Low Confidence",    labelEs: "Baja Confianza",    color: "#F97316", bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.3)" },
  guidance_only: { label: "Guidance Only",     labelEs: "Solo Orientativo",  color: "#EF4444", bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.3)" },
};

const DRIVER_LABELS: Record<string, { en: string; es: string }> = {
  beach_distance:   { en: "Beach Distance",  es: "Dist. a la playa" },
  sqft:             { en: "Square Footage",  es: "Metros cuadrados" },
  bathrooms:        { en: "Bathrooms",       es: "Baños" },
  amenities:        { en: "Amenities",       es: "Amenidades" },
  rating:           { en: "Guest Rating",    es: "Calificación" },
  beach_tier_match: { en: "Beach Tier",      es: "Categoría playa" },
  price_tier_match: { en: "Price Tier",      es: "Categoría precio" },
  building_match:   { en: "Same Building",   es: "Mismo edificio" },
};

// ── API helpers ────────────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message ?? `API error: HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "rgba(154,165,177,0.6)" }}>
      {children}
    </p>
  );
}

function FieldLabel({ children, optional }: { children: React.ReactNode; optional?: boolean }) {
  return (
    <label className="block text-sm font-medium text-foreground mb-1.5">
      {children}
      {optional && (
        <span className="ml-1.5 text-[10px] font-normal" style={{ color: "rgba(154,165,177,0.5)" }}>optional</span>
      )}
    </label>
  );
}

function StyledInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "w-full px-3 py-2.5 rounded-xl text-sm bg-[#163C4A] border border-white/8 text-foreground",
        "placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors",
        props.className,
      )}
    />
  );
}

function StyledSelect(props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      {...props}
      className={cn("w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50", props.className)}
    >
      {props.children}
    </select>
  );
}

// Unit toggle
function UnitToggle({ value, onChange }: { value: UnitSystem; onChange: (v: UnitSystem) => void }) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: "rgba(255,255,255,0.05)" }}>
      {(["imperial", "metric"] as UnitSystem[]).map(u => (
        <button
          key={u}
          type="button"
          onClick={() => onChange(u)}
          className="px-3 py-1 rounded-md text-xs font-semibold transition-all duration-150"
          style={{
            background: value === u ? "#163C4A" : "transparent",
            color: value === u ? "#00C2A8" : "rgba(154,165,177,0.6)",
            boxShadow: value === u ? "0 1px 4px rgba(0,0,0,0.3)" : "none",
          }}
        >
          {u === "imperial" ? "Imperial (ft / sqft)" : "Metric (m / m²)"}
        </button>
      ))}
    </div>
  );
}

// Building typeahead
function BuildingCombobox({ buildings, value, onChange, disabled }: {
  buildings: BuildingEntry[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  const filtered = query.trim().length === 0
    ? buildings
    : buildings.filter(b => b.canonical_building_name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Building className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: "rgba(154,165,177,0.5)" }} />
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={buildings.length > 0 ? `Search ${buildings.length} known buildings…` : "Type building name…"}
          disabled={disabled}
          className={cn(
            "w-full pl-8 pr-8 py-2.5 rounded-xl text-sm bg-[#163C4A] border border-white/8",
            "text-foreground placeholder:text-muted-foreground/40",
            "focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        />
        {query && (
          <button type="button" onClick={() => { setQuery(""); onChange(""); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <XCircle className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute z-50 w-full mt-1 rounded-xl overflow-hidden"
            style={{ background: "#0F2A36", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)", maxHeight: "220px", overflowY: "auto" }}
          >
            <div className="px-3 py-2 text-xs cursor-pointer hover:bg-white/5 transition-colors"
              style={{ color: "rgba(154,165,177,0.6)" }}
              onMouseDown={() => { onChange(""); setQuery(""); setOpen(false); }}>
              No specific building / skip
            </div>
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }} />
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No match — your text will be fuzzy-matched by the engine.
              </div>
            )}
            {filtered.map(b => (
              <div key={b.canonical_building_name}
                className="px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
                onMouseDown={() => { onChange(b.canonical_building_name); setQuery(b.canonical_building_name); setOpen(false); }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-foreground">{b.canonical_building_name}</span>
                  <span className="text-[10px] shrink-0" style={{ color: "rgba(154,165,177,0.5)" }}>
                    {b.listing_count} listings{b.median_price != null ? ` · ${formatCurrency(b.median_price)} med.` : ""}
                    {b.thin_sample ? " ⚠" : ""}
                  </span>
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Amenity multi-select
function AmenityPicker({ amenities, selected, onToggle }: {
  amenities: AmenityDef[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  const { t } = useLanguage();
  const grouped = amenities.reduce<Record<string, AmenityDef[]>>((acc, a) => {
    if (!acc[a.category]) acc[a.category] = [];
    acc[a.category].push(a);
    return acc;
  }, {});
  const order = ["beach", "climate", "view", "pool", "kitchen", "outdoor", "laundry", "connectivity", "workspace", "parking", "pet", "safety"];
  const sorted = order.filter(c => grouped[c]).concat(Object.keys(grouped).filter(c => !order.includes(c)));

  if (amenities.length === 0) {
    return <p className="text-xs text-muted-foreground">Loading amenities…</p>;
  }

  return (
    <div className="space-y-4">
      {sorted.map(cat => (
        <div key={cat}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-2 capitalize" style={{ color: "rgba(154,165,177,0.5)" }}>{cat}</p>
          <div className="flex flex-wrap gap-2">
            {(grouped[cat] ?? []).map(a => {
              const isOn = selected.includes(a.amenity_key);
              const label = t(a.display_label, a.display_label_es);
              return (
                <button key={a.amenity_key} type="button" onClick={() => onToggle(a.amenity_key)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-150 border"
                  style={{
                    background: isOn ? "rgba(0,194,168,0.15)" : "rgba(255,255,255,0.04)",
                    borderColor: isOn ? "rgba(0,194,168,0.5)" : "rgba(255,255,255,0.08)",
                    color: isOn ? "#00C2A8" : "rgba(245,247,250,0.6)",
                  }}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Street autocomplete (Photon / OpenStreetMap) ───────────────────────────────
const PV_LAT = 20.6534;
const PV_LON = -105.2253;
// OSM values that indicate a road/street (not POIs, parks, etc.)
const ROAD_TYPES = new Set([
  "primary", "secondary", "tertiary", "residential", "service",
  "unclassified", "pedestrian", "living_street", "footway", "path",
  "street", "road",
]);

interface StreetSuggestion {
  name: string;
  osmValue: string;
  coords: [number, number]; // [lon, lat]
}

function StreetAutocomplete({ placeholder, value, onChange, onSelectCoords, disabled }: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSelectCoords: (coords: [number, number] | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<StreetSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolved, setResolved] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local query in sync when parent resets value
  useEffect(() => {
    if (!value) { setQuery(""); setResolved(false); onSelectCoords(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  function handleChange(raw: string) {
    setQuery(raw);
    onChange(raw);
    setResolved(false);
    onSelectCoords(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (raw.trim().length < 2) { setSuggestions([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(raw + " Puerto Vallarta")}&lat=${PV_LAT}&lon=${PV_LON}&limit=10&lang=en`;
        const res = await fetch(url);
        const data = await res.json() as { features: { properties: { name: string; osm_value: string; city?: string; type?: string }; geometry: { coordinates: [number, number] } }[] };
        const filtered: StreetSuggestion[] = [];
        const seen = new Set<string>();
        for (const f of data.features) {
          const p = f.properties;
          const name = p.name?.trim();
          if (!name) continue;
          // Only include road types OR any result whose city is Puerto Vallarta
          const isRoad = ROAD_TYPES.has(p.osm_value);
          const inPV = p.city === "Puerto Vallarta";
          if (!isRoad && !inPV) continue;
          if (seen.has(name)) continue;
          seen.add(name);
          filtered.push({ name, osmValue: p.osm_value, coords: f.geometry.coordinates });
          if (filtered.length >= 6) break;
        }
        setSuggestions(filtered);
        setOpen(filtered.length > 0);
      } catch {
        // Silently degrade — user can still type freely
      } finally {
        setLoading(false);
      }
    }, 300);
  }

  function handleSelect(s: StreetSuggestion) {
    setQuery(s.name);
    onChange(s.name);
    onSelectCoords(s.coords);
    setResolved(true);
    setSuggestions([]);
    setOpen(false);
  }

  const roadTypeColor = useMemo(() => ({
    primary: "#F59E0B", secondary: "#F59E0B",
    tertiary: "#00C2A8", residential: "#6366F1",
  } as Record<string, string>), []);

  return (
    <div ref={containerRef} className="relative flex-1">
      <div className="relative">
        <input
          value={query}
          onChange={e => handleChange(e.target.value)}
          onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            "w-full px-3 py-2.5 pr-8 rounded-xl text-sm bg-[#163C4A] border text-foreground",
            "placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors",
            resolved ? "border-primary/40" : "border-white/8",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        />
        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
          {resolved && !loading && <MapPin className="w-3 h-3" style={{ color: "#00C2A8" }} />}
        </div>
      </div>
      <AnimatePresence>
        {open && suggestions.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.1 }}
            className="absolute z-50 w-full mt-1 rounded-xl overflow-hidden"
            style={{ background: "#0F2A36", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)", minWidth: "220px" }}
          >
            {suggestions.map((s, i) => (
              <div key={i} onMouseDown={() => handleSelect(s)}
                className="flex items-center justify-between gap-3 px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors">
                <span className="text-sm text-foreground">{s.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    color: roadTypeColor[s.osmValue] ?? "rgba(154,165,177,0.6)",
                  }}>
                  {s.osmValue}
                </span>
              </div>
            ))}
            <div className="px-3 py-1.5 flex items-center gap-1.5 border-t border-white/5">
              <span className="text-[10px]" style={{ color: "rgba(154,165,177,0.35)" }}>© OpenStreetMap</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ConfidenceBadge({ label }: { label: string }) {
  const cfg = CONFIDENCE_CONFIG[label] ?? CONFIDENCE_CONFIG.guidance_only;
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border"
      style={{ background: cfg.bg, borderColor: cfg.border, color: cfg.color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: cfg.color }} />
      {cfg.label}
    </span>
  );
}

function WarningRow({ text, level = "warn" }: { text: string; level?: "warn" | "info" }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs"
      style={{
        background: level === "warn" ? "rgba(245,158,11,0.08)" : "rgba(0,209,255,0.08)",
        border: `1px solid ${level === "warn" ? "rgba(245,158,11,0.2)" : "rgba(0,209,255,0.15)"}`,
      }}>
      {level === "warn" ? <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "#F59E0B" }} />
        : <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "#00D1FF" }} />}
      <span style={{ color: "rgba(245,247,250,0.8)" }}>{text}</span>
    </div>
  );
}

function PrimaryButton({ onClick, loading, disabled, children }: {
  onClick: () => void; loading?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || loading}
      className="flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        background: disabled || loading ? "rgba(0,194,168,0.4)" : "#00C2A8",
        color: "#0A1E27",
        boxShadow: disabled || loading ? "none" : "0 4px 16px rgba(0,194,168,0.3)",
      }}>
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
type Phase = "form" | "prepare_loading" | "prepared" | "comps_loading" | "results" | "error";

const DEFAULT_FORM: FormValues = {
  neighborhood: "Zona Romantica",
  buildingName: "",
  crossStreet1: "",
  crossStreet2: "",
  buildingYear: "",
  listingUrl: "",
  bedrooms: 1,
  bathrooms: 1,
  size: "",
  distance: "",
  ratingOverall: "",
};

export default function PricingTool() {
  const { t, lang } = useLanguage();
  const [units, setUnits] = useState<UnitSystem>("imperial");

  const [amenities, setAmenities] = useState<AmenityDef[]>([]);
  const [buildingsByNeighborhood, setBuildingsByNeighborhood] = useState<Record<string, BuildingEntry[]>>({});
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [form, setForm] = useState<FormValues>(DEFAULT_FORM);
  const [selectedAmenities, setSelectedAmenities] = useState<string[]>([]);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormValues, string>>>({});

  const [phase, setPhase] = useState<Phase>("form");
  const [prepareResult, setPrepareResult] = useState<PrepareResult | null>(null);
  const [compsResult, setCompsResult] = useState<CompsResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showLimitations, setShowLimitations] = useState(false);

  // Resolved GPS coordinates from OSM street autocomplete (for future geolocation use)
  const [street1Coords, setStreet1Coords] = useState<[number, number] | null>(null);
  const [street2Coords, setStreet2Coords] = useState<[number, number] | null>(null);

  const resultsRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const distanceRef = useRef<HTMLDivElement>(null);

  const buildings = buildingsByNeighborhood[form.neighborhood] ?? [];

  // Load amenities + buildings
  useEffect(() => {
    async function loadMeta() {
      try {
        const [amenitiesRes, allBuildingsRes] = await Promise.all([
          apiFetch<{ amenities: AmenityDef[] }>("/api/rental/amenities"),
          apiFetch<{ buildings: BuildingEntry[] }>("/api/rental/buildings"),
        ]);
        setAmenities(amenitiesRes.amenities);
        // Group all buildings by neighborhood for efficient lookup
        const grouped: Record<string, BuildingEntry[]> = {};
        for (const b of allBuildingsRes.buildings) {
          const nn = (b as BuildingEntry & { neighborhood_normalized?: string }).neighborhood_normalized ?? "Zona Romantica";
          if (!grouped[nn]) grouped[nn] = [];
          grouped[nn].push(b);
        }
        setBuildingsByNeighborhood(grouped);
      } catch (e) {
        setMetaError(e instanceof Error ? e.message : "Failed to load form data. Check your connection.");
      } finally {
        setLoadingMeta(false);
      }
    }
    loadMeta();
  }, []);

  // Reset building + results when neighborhood changes
  useEffect(() => {
    setForm(prev => ({ ...prev, buildingName: "" }));
    if (phase !== "form") { setPhase("form"); setPrepareResult(null); setCompsResult(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.neighborhood]);

  function setField<K extends keyof FormValues>(key: K, val: FormValues[K]) {
    setForm(prev => ({ ...prev, [key]: val }));
    setFormErrors(prev => ({ ...prev, [key]: undefined }));
    if (phase !== "form" && phase !== "prepare_loading") {
      setPhase("form"); setPrepareResult(null); setCompsResult(null);
    }
  }

  function toggleAmenity(key: string) {
    setSelectedAmenities(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
    if (phase !== "form" && phase !== "prepare_loading") {
      setPhase("form"); setPrepareResult(null); setCompsResult(null);
    }
  }

  function validate(): boolean {
    const errs: Partial<Record<keyof FormValues, string>> = {};
    if (!form.distance.trim() || isNaN(Number(form.distance)) || Number(form.distance) <= 0) {
      errs.distance = units === "imperial"
        ? "Required — enter distance in feet, or use the quick-select above."
        : "Required — enter distance in meters.";
    }
    if (form.size && (isNaN(Number(form.size)) || Number(form.size) <= 0)) {
      errs.size = `Enter a valid size in ${units === "imperial" ? "sq ft" : "m²"}.`;
    }
    if (form.ratingOverall && (isNaN(Number(form.ratingOverall)) || Number(form.ratingOverall) < 1 || Number(form.ratingOverall) > 5)) {
      errs.ratingOverall = "Rating must be 1.0 – 5.0.";
    }
    setFormErrors(errs);
    if (errs.distance) {
      setTimeout(() => distanceRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
    return Object.keys(errs).length === 0;
  }

  const handleValidate = useCallback(async () => {
    if (!validate()) return;
    setPhase("prepare_loading");
    setErrorMsg(null);
    try {
      const distanceM = toMeters(Number(form.distance), units);
      const sizeSqft = form.size ? toSqft(Number(form.size), units) : undefined;
      const body = {
        neighborhood_normalized: form.neighborhood,
        bedrooms: form.bedrooms,
        bathrooms: form.bathrooms,
        ...(sizeSqft ? { sqft: sizeSqft } : {}),
        distance_to_beach_m: distanceM,
        amenities_normalized: selectedAmenities,
        ...(form.ratingOverall ? { rating_overall: Number(form.ratingOverall) } : {}),
        ...(form.buildingName.trim() ? { building_name: form.buildingName.trim() } : {}),
      };
      const result = await apiFetch<PrepareResult>("/api/rental/comps/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setPrepareResult(result);
      setPhase("prepared");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Validation failed. Please try again.");
      setPhase("error");
      setTimeout(() => errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, selectedAmenities, units]);

  const handleGetPricing = useCallback(async () => {
    if (!prepareResult) return;
    setPhase("comps_loading");
    setErrorMsg(null);
    try {
      const distanceM = toMeters(Number(form.distance), units);
      const sizeSqft = form.size ? toSqft(Number(form.size), units) : undefined;
      const body = {
        neighborhood_normalized: form.neighborhood,
        bedrooms: form.bedrooms,
        bathrooms: form.bathrooms,
        ...(sizeSqft ? { sqft: sizeSqft } : {}),
        distance_to_beach_m: distanceM,
        amenities_normalized: prepareResult.cleaned_input.amenities_normalized,
        ...(form.ratingOverall ? { rating_overall: Number(form.ratingOverall) } : {}),
        ...(prepareResult.cleaned_input.building_name ? { building_name: prepareResult.cleaned_input.building_name } : {}),
      };
      const result = await apiFetch<CompsResult>("/api/rental/comps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setCompsResult(result);
      setPhase("results");
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to get pricing. Please try again.");
      setPhase("error");
      setTimeout(() => errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, prepareResult, units]);

  function handleReset() {
    setForm(DEFAULT_FORM);
    setSelectedAmenities([]);
    setFormErrors({});
    setPrepareResult(null);
    setCompsResult(null);
    setPhase("form");
    setErrorMsg(null);
    setShowLimitations(false);
    setStreet1Coords(null);
    setStreet2Coords(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const isLoading = phase === "prepare_loading" || phase === "comps_loading";
  const distLabel = units === "imperial" ? "ft" : "m";
  const sizeLabel = units === "imperial" ? "sq ft" : "m²";
  const beachPresets = units === "imperial" ? BEACH_PRESETS_IMPERIAL : BEACH_PRESETS_METRIC;

  return (
    <PageWrapper>
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-5 h-5" style={{ color: "#00C2A8" }} />
            <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
              {t("Rental Pricing Tool", "Herramienta de Precios")}
            </h1>
          </div>
          <p className="text-muted-foreground text-sm">
            {t("Comp-based nightly rate guidance for Puerto Vallarta & Riviera Nayarit — powered by 192+ multi-source listings.", "Guía de precios basada en comparables para Puerto Vallarta y Riviera Nayarit — más de 192 propiedades de múltiples fuentes.")}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <UnitToggle value={units} onChange={v => { setUnits(v); setField("distance", ""); setField("size", ""); }} />
          {phase !== "form" && (
            <button onClick={handleReset}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-muted-foreground hover:text-foreground border border-white/8 hover:border-white/16 transition-colors">
              <RotateCcw className="w-3 h-3" /> {t("Start over", "Comenzar")}
            </button>
          )}
        </div>
      </div>

      {/* Meta error */}
      {metaError && (
        <div className="mb-4 flex items-start gap-2 p-3 rounded-xl text-xs"
          style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#EF4444" }}>
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{metaError}</span>
        </div>
      )}

      <div className="space-y-5">

        {/* ── Form card ── */}
        <Card className="glass-card">
          <CardHeader>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Building2 className="w-4 h-4" style={{ color: "#00C2A8" }} />
              {t("Property Details", "Detalles de la Propiedad")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">

            {/* Neighborhood */}
            <div>
              <FieldLabel>{t("Neighborhood", "Colonia")}</FieldLabel>
              <StyledSelect value={form.neighborhood}
                onChange={e => setField("neighborhood", e.target.value as Neighborhood)} disabled={isLoading}>
                <optgroup label="Puerto Vallarta">
                  <option value="Zona Romantica">Zona Romántica</option>
                  <option value="Amapas">Amapas / Conchas Chinas</option>
                  <option value="Centro">Centro / Alta Vista</option>
                  <option value="Hotel Zone">Hotel Zone / Malecón</option>
                  <option value="5 de Diciembre">5 de Diciembre</option>
                  <option value="Old Town">Old Town (ambiguous side of river)</option>
                  <option value="Versalles">Versalles</option>
                  <option value="Marina Vallarta">Marina Vallarta</option>
                  <option value="Mismaloya">Mismaloya</option>
                </optgroup>
                <optgroup label="Riviera Nayarit">
                  <option value="Nuevo Vallarta">Nuevo Vallarta</option>
                  <option value="Bucerias">Bucerías</option>
                  <option value="La Cruz de Huanacaxtle">La Cruz de Huanacaxtle</option>
                  <option value="Punta Mita">Punta Mita</option>
                  <option value="El Anclote">El Anclote</option>
                  <option value="Sayulita">Sayulita</option>
                  <option value="San Pancho">San Pancho</option>
                </optgroup>
              </StyledSelect>
            </div>

            {/* Building */}
            <div>
              <FieldLabel optional>
                <Building className="inline w-3.5 h-3.5 mr-1" />
                {t("Property / Building Name", "Nombre de la Propiedad / Edificio")}
              </FieldLabel>
              {loadingMeta ? <Skeleton className="h-10 rounded-xl" /> : (
                <BuildingCombobox buildings={buildings} value={form.buildingName}
                  onChange={v => setField("buildingName", v)} disabled={isLoading} />
              )}
              <p className="text-[11px] mt-1.5" style={{ color: "rgba(154,165,177,0.45)" }}>
                {t("If your condo is part of a known complex, selecting it improves pricing accuracy. If not listed, type it or skip.",
                   "Si el condo pertenece a un complejo conocido, seleccionarlo mejora la precisión. Si no está, escríbelo u omítelo.")}
              </p>
            </div>

            {/* Cross streets — OSM autocomplete */}
            <div>
              <FieldLabel optional>
                <Crosshair className="inline w-3.5 h-3.5 mr-1" />
                {t("Nearest cross streets", "Calles cercanas")}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <StreetAutocomplete
                  placeholder={t("Street 1", "Calle 1")}
                  value={form.crossStreet1}
                  onChange={v => setField("crossStreet1", v)}
                  onSelectCoords={c => setStreet1Coords(c)}
                  disabled={isLoading}
                />
                <span className="text-muted-foreground font-medium text-sm shrink-0">×</span>
                <StreetAutocomplete
                  placeholder={t("Street 2", "Calle 2")}
                  value={form.crossStreet2}
                  onChange={v => setField("crossStreet2", v)}
                  onSelectCoords={c => setStreet2Coords(c)}
                  disabled={isLoading}
                />
              </div>
              <div className="flex items-center gap-3 mt-1.5">
                <p className="text-[11px]" style={{ color: "rgba(154,165,177,0.45)" }}>
                  {t("Helps locate the property when no building name is known.", "Ayuda a ubicar la propiedad si no se conoce el edificio.")}
                </p>
                {street1Coords && street2Coords && (
                  <span className="flex items-center gap-1 text-[10px] font-medium shrink-0"
                    style={{ color: "#00C2A8" }}>
                    <MapPin className="w-2.5 h-2.5" />
                    {t("Both streets located", "Ambas calles ubicadas")}
                  </span>
                )}
                {(street1Coords || street2Coords) && !(street1Coords && street2Coords) && (
                  <span className="flex items-center gap-1 text-[10px] shrink-0"
                    style={{ color: "rgba(245,158,11,0.8)" }}>
                    <MapPin className="w-2.5 h-2.5" />
                    {t("1 of 2 streets located", "1 de 2 calles ubicadas")}
                  </span>
                )}
              </div>
            </div>

            {/* Building year */}
            <div className="max-w-xs">
              <FieldLabel optional>
                <CalendarClock className="inline w-3.5 h-3.5 mr-1" />
                {t("Approx. year built", "Año de construcción aprox.")}
              </FieldLabel>
              <StyledSelect
                value={form.buildingYear}
                onChange={e => setField("buildingYear", e.target.value)}
                disabled={isLoading}
                style={{ background: "#163C4A", border: "1px solid rgba(255,255,255,0.08)", color: form.buildingYear ? "rgb(245,247,250)" : "rgba(154,165,177,0.4)" }}
              >
                <option value="">— Unknown —</option>
                <option value="2020+">2020 or later</option>
                <option value="2015-2019">2015–2019</option>
                <option value="2010-2014">2010–2014</option>
                <option value="2000-2009">2000–2009</option>
                <option value="1990-1999">1990–1999</option>
                <option value="pre-1990">pre-1990</option>
              </StyledSelect>
            </div>

            {/* Listing URL — AI evaluation (future) */}
            <div>
              <FieldLabel optional>
                <Link2 className="inline w-3.5 h-3.5 mr-1" />
                {t("Listing URL", "URL del Listado")}
                <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                  style={{ background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.25)", color: "#818CF8" }}>
                  <Sparkles className="w-2.5 h-2.5" />
                  {t("AI Evaluation — Coming Soon", "Evaluación IA — Próximamente")}
                </span>
              </FieldLabel>
              <StyledInput
                type="url"
                placeholder={t("e.g. https://www.airbnb.com/rooms/12345678 or PVRPV link", "e.g. enlace de Airbnb, VRBO o PVRPV")}
                value={form.listingUrl}
                onChange={e => setField("listingUrl", e.target.value)}
                disabled={isLoading}
              />
              <p className="text-[11px] mt-1.5" style={{ color: "rgba(154,165,177,0.45)" }}>
                {t("Paste your Airbnb, VRBO, or PVRPV listing link. A future AI feature will analyze your listing photos and description to refine the estimate.",
                   "Pega tu enlace de Airbnb, VRBO o PVRPV. Una futura función de IA analizará tus fotos y descripción para refinar la estimación.")}
              </p>
            </div>

            {/* Bedrooms + Bathrooms */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FieldLabel>{t("Bedrooms", "Recámaras")}</FieldLabel>
                <StyledSelect value={form.bedrooms}
                  onChange={e => setField("bedrooms", Number(e.target.value) as 1 | 2 | 3 | 4)} disabled={isLoading}>
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} {t("BR", "Rec.")}</option>)}
                </StyledSelect>
              </div>
              <div>
                <FieldLabel>{t("Bathrooms", "Baños")}</FieldLabel>
                <StyledSelect value={form.bathrooms}
                  onChange={e => setField("bathrooms", Number(e.target.value))} disabled={isLoading}>
                  {BATH_OPTIONS.map(n => <option key={n} value={n}>{n} {t("BA", "Baño")}</option>)}
                </StyledSelect>
              </div>
            </div>

            {/* Size + Beach distance */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <FieldLabel optional>
                  <Ruler className="inline w-3.5 h-3.5 mr-1" />
                  {t(`Unit size (${sizeLabel})`, `Tamaño (${sizeLabel})`)}
                </FieldLabel>
                <StyledInput type="number" min={0}
                  placeholder={units === "imperial" ? "e.g. 900" : "e.g. 84"}
                  value={form.size} onChange={e => setField("size", e.target.value)} disabled={isLoading} />
                {formErrors.size && <p className="text-xs mt-1 text-destructive">{formErrors.size}</p>}
              </div>

              <div ref={distanceRef}>
                <FieldLabel>
                  <Waves className="inline w-3.5 h-3.5 mr-1" />
                  {t(`Distance to beach (${distLabel})`, `Distancia a la playa (${distLabel})`)}
                </FieldLabel>
                {/* Quick-select presets */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {beachPresets.map(p => {
                    const val = String(units === "imperial" ? p.ft : p.m);
                    return (
                      <button key={p.label} type="button"
                        onClick={() => setField("distance", val)}
                        disabled={isLoading}
                        className="px-2 py-1 rounded-lg text-[11px] border transition-all"
                        style={{
                          background: form.distance === val ? "rgba(0,194,168,0.15)" : "rgba(255,255,255,0.04)",
                          borderColor: form.distance === val ? "rgba(0,194,168,0.4)" : "rgba(255,255,255,0.08)",
                          color: form.distance === val ? "#00C2A8" : "rgba(245,247,250,0.5)",
                        }}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <StyledInput type="number" min={0}
                  placeholder={units === "imperial" ? "or enter feet (e.g. 500)" : "or enter meters (e.g. 150)"}
                  value={form.distance} onChange={e => setField("distance", e.target.value)} disabled={isLoading} />
                {formErrors.distance && <p className="text-xs mt-1 text-destructive">{formErrors.distance}</p>}
              </div>
            </div>

            {/* Rating */}
            <div className="max-w-xs">
              <FieldLabel optional>
                <Star className="inline w-3.5 h-3.5 mr-1" />
                {t("Current guest rating", "Calificación de huéspedes")}
              </FieldLabel>
              <StyledSelect value={form.ratingOverall}
                onChange={e => setField("ratingOverall", e.target.value)} disabled={isLoading}>
                <option value="">— Not rated yet —</option>
                {RATING_OPTIONS.map(r => <option key={r} value={r}>{r.toFixed(1)} ★</option>)}
              </StyledSelect>
            </div>

            {/* Amenities */}
            <div>
              <FieldLabel optional>
                <Tag className="inline w-3.5 h-3.5 mr-1" />
                {t("Amenities", "Amenidades")}
                {selectedAmenities.length > 0 && (
                  <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold"
                    style={{ background: "rgba(0,194,168,0.15)", color: "#00C2A8" }}>
                    {selectedAmenities.length} {t("selected", "seleccionados")}
                  </span>
                )}
              </FieldLabel>
              {loadingMeta
                ? <div className="flex flex-wrap gap-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8 w-24 rounded-full" />)}</div>
                : <AmenityPicker amenities={amenities} selected={selectedAmenities} onToggle={toggleAmenity} />}
            </div>

            {/* Validate CTA */}
            <div className="flex items-center gap-4 pt-2 border-t border-white/5">
              <PrimaryButton onClick={handleValidate} loading={phase === "prepare_loading"} disabled={isLoading}>
                {phase === "prepare_loading" ? t("Validating…", "Validando…") : t("Validate & Continue", "Validar y Continuar")}
                {phase !== "prepare_loading" && <ArrowRight className="w-4 h-4" />}
              </PrimaryButton>
              {phase === "prepared" && (
                <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: "#00C2A8" }}>
                  <CheckCircle2 className="w-3.5 h-3.5" /> {t("Inputs validated", "Datos validados")}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Error panel ── */}
        <AnimatePresence>
          {phase === "error" && errorMsg && (
            <motion.div ref={errorRef} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex items-start gap-3 p-4 rounded-xl"
              style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)" }}>
              <XCircle className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "#EF4444" }} />
              <div>
                <p className="text-sm font-semibold text-foreground">{t("Something went wrong", "Algo salió mal")}</p>
                <p className="text-xs mt-1 text-muted-foreground">{errorMsg}</p>
                <button onClick={handleValidate}
                  className="mt-2 text-xs font-medium flex items-center gap-1" style={{ color: "#00C2A8" }}>
                  <RefreshCw className="w-3 h-3" /> {t("Try again", "Intentar de nuevo")}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Input Summary ── */}
        <AnimatePresence>
          {(phase === "prepared" || phase === "comps_loading" || phase === "results") && prepareResult && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" style={{ color: "#00C2A8" }} />
                    {t("Input Summary", "Resumen de Entrada")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Building resolution */}
                  <div>
                    <SectionLabel>{t("Building", "Edificio")}</SectionLabel>
                    {prepareResult.building_resolution?.canonical_building_name ? (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold">{prepareResult.building_resolution.canonical_building_name}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold border"
                          style={{
                            background: prepareResult.building_resolution.confidence_tier === "high" ? "rgba(0,194,168,0.12)" : "rgba(245,158,11,0.12)",
                            borderColor: prepareResult.building_resolution.confidence_tier === "high" ? "rgba(0,194,168,0.3)" : "rgba(245,158,11,0.3)",
                            color: prepareResult.building_resolution.confidence_tier === "high" ? "#00C2A8" : "#F59E0B",
                          }}>
                          {prepareResult.building_resolution.confidence_tier} match
                          {prepareResult.building_resolution.match_confidence != null
                            ? ` · ${Math.round(prepareResult.building_resolution.match_confidence * 100)}%` : ""}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-muted-foreground">{t("No building — general comps", "Sin edificio — comparables generales")}</span>
                        {(prepareResult.building_resolution?.suggestions?.length ?? 0) > 0 && (
                          <span className="text-[11px]" style={{ color: "#F59E0B" }}>
                            {t("Did you mean:", "¿Quisiste decir:")} <strong>{prepareResult.building_resolution!.suggestions[0]?.canonical}</strong>?
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Amenities */}
                  <div>
                    <SectionLabel>{t("Amenities accepted by engine", "Amenidades aceptadas")}</SectionLabel>
                    {prepareResult.amenity_validation.accepted_keys.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {prepareResult.amenity_validation.accepted_keys.map(k => (
                          <span key={k} className="px-2 py-0.5 rounded-full text-[11px] font-medium"
                            style={{ background: "rgba(0,194,168,0.1)", color: "#00C2A8" }}>
                            ✓ {k.replace(/_/g, " ")}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("None selected", "Ninguna seleccionada")}</p>
                    )}
                    {prepareResult.amenity_validation.rejected_keys.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {prepareResult.amenity_validation.rejected_keys.map(k => (
                          <span key={k} className="px-2 py-0.5 rounded-full text-[11px]"
                            style={{ background: "rgba(239,68,68,0.08)", color: "#EF4444" }}>✗ {k}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Warnings */}
                  {prepareResult.warnings.length > 0 && (
                    <div className="space-y-2">
                      {prepareResult.warnings.map((w, i) => <WarningRow key={i} text={w} />)}
                    </div>
                  )}

                  {/* Get Pricing CTA */}
                  <div className="pt-1 border-t border-white/5">
                    <PrimaryButton onClick={handleGetPricing} loading={phase === "comps_loading"} disabled={isLoading}>
                      {phase === "comps_loading" ? t("Running pricing engine…", "Ejecutando motor…") : t("Get Pricing Recommendation", "Obtener Recomendación")}
                      {phase !== "comps_loading" && <BarChart3 className="w-4 h-4" />}
                    </PrimaryButton>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Results ── */}
        <AnimatePresence>
          {phase === "results" && compsResult && (
            <motion.div ref={resultsRef} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.4 }} className="space-y-5">

              {/* Price hero */}
              <div className="rounded-2xl p-6"
                style={{
                  background: "linear-gradient(135deg, #0F2A36 0%, #163C4A 100%)",
                  border: "1px solid rgba(0,194,168,0.2)",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
                }}>
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: "rgba(0,194,168,0.7)" }}>
                      {t("Recommended Nightly Rate", "Tarifa Nocturna Recomendada")}
                    </p>
                    <div className="flex items-baseline gap-2">
                      <span className="text-6xl font-extrabold tracking-tight" style={{ color: "#00C2A8" }}>
                        {formatCurrency(compsResult.recommended_price)}
                      </span>
                      <span className="text-lg font-medium text-muted-foreground">/night</span>
                    </div>
                    <div className="flex items-center gap-6 mt-3">
                      <div>
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{t("Conservative", "Conservador")}</p>
                        <p className="text-xl font-bold">{formatCurrency(compsResult.conservative_price)}</p>
                      </div>
                      <ArrowLeftRight className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{t("Stretch", "Máximo")}</p>
                        <p className="text-xl font-bold">{formatCurrency(compsResult.stretch_price)}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 items-start md:items-end shrink-0">
                    <ConfidenceBadge label={compsResult.confidence_label} />
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <BarChart3 className="w-3.5 h-3.5" />
                      {compsResult.pool_size} {t("comparable listings", "comparables")}
                    </div>
                    {compsResult.thin_pool_warning && (
                      <div className="text-[11px] px-2 py-1 rounded-lg"
                        style={{ background: "rgba(249,115,22,0.12)", color: "#F97316", border: "1px solid rgba(249,115,22,0.2)" }}>
                        ⚠ {t("Thin pool — use the range", "Pocos comparables — use el rango")}
                      </div>
                    )}
                    <p className="text-[10px]" style={{ color: "rgba(154,165,177,0.35)" }}>Multi-source: PVRPV + Vacation Vallarta + Airbnb + VRBO</p>
                  </div>
                </div>
              </div>

              {/* Adjustments + Drivers */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="glass-card">
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <TrendingUp className="w-4 h-4" style={{ color: "#00C2A8" }} />
                      {t("Pricing Adjustments", "Ajustes de Precio")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-sm text-muted-foreground">{t("Segment P50", "Mediana del segmento")}</span>
                      <span className="text-sm font-semibold">{formatCurrency(compsResult.target_summary.segment_median)}</span>
                    </div>
                    {compsResult.building_adjustment_pct != null && (
                      <div className="flex justify-between py-1 px-2 rounded-lg"
                        style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.15)" }}>
                        <div>
                          <p className="text-sm">{compsResult.target_summary.building_normalized ?? t("Building", "Edificio")}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {compsResult.building_adjustment_pct > 40
                              ? t("Anchor mode", "Modo ancla")
                              : t("Premium applied", "Prima aplicada")}
                          </p>
                        </div>
                        <span className="text-sm font-bold" style={{ color: "#6366F1" }}>
                          {compsResult.building_adjustment_pct > 0 ? "+" : ""}{compsResult.building_adjustment_pct.toFixed(1)}%
                        </span>
                      </div>
                    )}
                    {compsResult.beach_tier_adjustment_pct != null && (
                      <div className="flex justify-between py-1 px-2 rounded-lg"
                        style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.12)" }}>
                        <div>
                          <p className="text-sm">{t("Beach tier", "Categoría playa")} ({compsResult.target_summary.beach_tier})</p>
                          <p className="text-[10px] text-muted-foreground">{t("Cross-tier adjustment", "Ajuste entre categorías")}</p>
                        </div>
                        <span className="text-sm font-bold" style={{ color: "#00D1FF" }}>
                          {compsResult.beach_tier_adjustment_pct > 0 ? "+" : ""}{compsResult.beach_tier_adjustment_pct.toFixed(1)}%
                        </span>
                      </div>
                    )}
                    {compsResult.building_adjustment_pct == null && compsResult.beach_tier_adjustment_pct == null && (
                      <p className="text-sm text-muted-foreground">{t("Direct comp-set median — no specific adjustments.", "Mediana directa de comparables.")}</p>
                    )}
                  </CardContent>
                </Card>

                <Card className="glass-card">
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <MapPin className="w-4 h-4" style={{ color: "#00C2A8" }} />
                      {t("Top Pricing Drivers", "Factores Clave")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {compsResult.top_drivers.slice(0, 5).map((d, i) => {
                        const lbl = DRIVER_LABELS[d];
                        return (
                          <div key={d} className="flex items-center gap-3">
                            <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                              style={{ background: "rgba(0,194,168,0.15)", color: "#00C2A8" }}>{i + 1}</span>
                            <span className="text-sm">{lbl ? (lang === "es" ? lbl.es : lbl.en) : d.replace(/_/g, " ")}</span>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Explanation */}
              <Card className="glass-card">
                <CardContent className="pt-5">
                  <div className="flex items-start gap-3">
                    <Info className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "#00D1FF" }} />
                    <p className="text-sm text-muted-foreground leading-relaxed">{compsResult.explanation}</p>
                  </div>
                </CardContent>
              </Card>

              {/* Warnings */}
              {compsResult.warnings.length > 0 && (
                <div className="space-y-2">
                  {compsResult.warnings.map((w, i) => <WarningRow key={i} text={w} />)}
                </div>
              )}

              {/* Comparable listings */}
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <BarChart3 className="w-4 h-4" style={{ color: "#00C2A8" }} />
                    {t("Comparable Listings", "Listados Comparables")}
                    <span className="text-[11px] font-normal px-2 py-0.5 rounded-full"
                      style={{ background: "rgba(0,194,168,0.1)", color: "#00C2A8" }}>
                      {compsResult.selected_comps.length} {t("comps", "comparables")}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {compsResult.selected_comps.map(comp => (
                      <div key={comp.external_id} className="flex flex-col sm:flex-row sm:items-start gap-3 p-3 rounded-xl"
                        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <div className="flex items-center gap-3 sm:flex-col sm:items-center sm:min-w-[56px]">
                          <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                            style={{ background: "rgba(0,194,168,0.15)", color: "#00C2A8" }}>#{comp.rank}</span>
                          <span className="text-base font-bold">{formatCurrency(comp.nightly_price_usd)}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <p className="text-sm font-semibold truncate">{comp.building_name ?? comp.external_id}</p>
                            <a href={comp.source_url} target="_blank" rel="noopener noreferrer"
                              className="text-[10px] underline shrink-0" style={{ color: "rgba(0,209,255,0.7)" }}>
                              PVRPV ↗
                            </a>
                          </div>
                          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground mb-2">
                            <span><BedDouble className="inline w-3 h-3 mr-0.5" />{comp.bedrooms}BR / {comp.bathrooms}BA</span>
                            {comp.sqft != null && <span><Ruler className="inline w-3 h-3 mr-0.5" />{comp.sqft.toLocaleString()} sqft</span>}
                            <span><Waves className="inline w-3 h-3 mr-0.5" />{comp.distance_to_beach_m}m · Tier {comp.beach_tier}</span>
                            {comp.rating_overall != null && <span><Star className="inline w-3 h-3 mr-0.5" />{comp.rating_overall}</span>}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {comp.match_reasons.slice(0, 4).map((r, i) => (
                              <span key={i} className="px-2 py-0.5 rounded-full text-[10px]"
                                style={{ background: "rgba(255,255,255,0.05)", color: "rgba(245,247,250,0.45)" }}>{r}</span>
                            ))}
                          </div>
                        </div>
                        <div className="sm:text-right shrink-0">
                          <p className="text-[10px] text-muted-foreground">{t("Score", "Puntaje")}</p>
                          <p className="text-lg font-bold" style={{ color: "#00C2A8" }}>{comp.score.toFixed(1)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Model limitations */}
              <div>
                <button type="button" onClick={() => setShowLimitations(v => !v)}
                  className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  {showLimitations ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  {t("Model limitations & data scope", "Limitaciones del modelo")}
                </button>
                <AnimatePresence>
                  {showLimitations && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                      <div className="mt-3 space-y-2">
                        {compsResult.model_limitations.map((lim, i) => <WarningRow key={i} text={lim} level="info" />)}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

            </motion.div>
          )}
        </AnimatePresence>

        {/* Empty state */}
        {phase === "form" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
            className="flex flex-col items-center py-12 text-center" style={{ color: "rgba(154,165,177,0.3)" }}>
            <BarChart3 className="w-10 h-10 mb-3" />
            <p className="text-sm max-w-sm">
              {t("Fill in your property details above and click Validate & Continue.", "Ingresa los detalles de la propiedad y haz clic en Validar y Continuar.")}
            </p>
          </motion.div>
        )}

      </div>
    </PageWrapper>
  );
}
