import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Building2, MapPin, BedDouble, Bath, Waves, Star,
  CheckCircle2, XCircle, AlertTriangle, ChevronDown, ChevronUp,
  Info, TrendingUp, ArrowRight, Loader2, RefreshCw,
  DollarSign, BarChart3, Building, ArrowLeftRight,
  CalendarClock, Link2, Sparkles, Flame, Calendar,
  Layers, TrendingDown, Minus, Home, Droplets, Sun, Wind,
  Dumbbell, ParkingSquare, Wifi, ChefHat, PawPrint, Users,
} from "lucide-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

type Neighborhood =
  | "Zona Romantica" | "Amapas" | "Centro" | "Hotel Zone"
  | "5 de Diciembre" | "Old Town" | "Versalles" | "Marina Vallarta"
  | "Nuevo Vallarta" | "Bucerias" | "La Cruz de Huanacaxtle"
  | "Punta Mita" | "El Anclote" | "Sayulita" | "San Pancho" | "Mismaloya";

type ViewType = "ocean" | "partial" | "city" | "garden" | "none";
type FinishQuality = "standard" | "upgraded" | "premium";

interface FormValues {
  neighborhood: Neighborhood;
  buildingName: string;
  bedrooms: 0 | 1 | 2 | 3 | 4;
  bathrooms: 1 | 2 | 3;          // 1 / 2 / 3+
  month: number;
  // Premium features
  viewType: ViewType;
  finishQuality: FinishQuality;
  rooftopPool: boolean;
  privatePlungePool: boolean;
  largeTerrace: boolean;
  beachfront: boolean;
  // Location
  distanceCustom: string;         // custom override ft string (imperial)
  // Secondary amenities
  secondaryAmenities: string[];
  // Optional
  size: string;
  ratingOverall: string;
  buildingYear: string;
  listingUrl: string;
  crossStreet1: string;
  crossStreet2: string;
}

interface BuildingEntry {
  canonical_building_name: string;
  neighborhood_normalized: string;
  listing_count: number;
  median_price: number | null;
  thin_sample: boolean;
}

interface PricingLayer {
  layer: string;
  label: string;
  factor: number | null;
  adjustment_pct: number | null;
  cumulative_price: number;
  applied: boolean;
  note: string;
}

interface SeasonalSweep {
  low: number;
  shoulder: number;
  high: number;
  peak: number;
}

interface BuildingContext {
  matched: boolean;
  building_name: string;
  comp_count: number;
  median_price: number;
  range_low: number;
  range_high: number;
  positioning: "underpriced" | "aligned" | "premium";
  positioning_statement: string;
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
    month: number;
    view_type: ViewType;
    rooftop_pool: boolean;
    finish_quality: FinishQuality;
    private_plunge_pool: boolean;
    large_terrace: boolean;
  };
  pool_size: number;
  thin_pool_warning: boolean;
  confidence_label: "high" | "medium" | "low" | "guidance_only";
  conservative_price: number;
  recommended_price: number;
  stretch_price: number;
  base_comp_median: number;
  building_adjustment_pct: number | null;
  pricing_breakdown: PricingLayer[];
  total_adjustment_multiplier: number;
  seasonal: {
    month: number;
    month_name: string;
    season: "peak" | "high" | "shoulder" | "low";
    monthly_multiplier: number;
    monthly_note: string;
    event_name: string | null;
    event_premium_pct: number | null;
    total_multiplier: number;
    display_label: string;
  };
  seasonal_sweep: SeasonalSweep | null;
  building_context: BuildingContext | null;
  positioning_statement: string | null;
  selected_comps: CompEntry[];
  top_drivers: string[];
  explanation: string;
  warnings: string[];
  model_limitations: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const BR_OPTIONS = [
  { value: 0, label: "Studio" },
  { value: 1, label: "1 BR" },
  { value: 2, label: "2 BR" },
  { value: 3, label: "3 BR" },
  { value: 4, label: "4+ BR" },
] as const;

const BATH_OPTIONS = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3+" },
] as const;

const MONTHS = [
  { n: 1,  abbr: "Jan", full: "January",   season: "high"     },
  { n: 2,  abbr: "Feb", full: "February",  season: "peak"     },
  { n: 3,  abbr: "Mar", full: "March",     season: "peak"     },
  { n: 4,  abbr: "Apr", full: "April",     season: "high"     },
  { n: 5,  abbr: "May", full: "May",       season: "shoulder" },
  { n: 6,  abbr: "Jun", full: "June",      season: "low"      },
  { n: 7,  abbr: "Jul", full: "July",      season: "low"      },
  { n: 8,  abbr: "Aug", full: "August",    season: "low"      },
  { n: 9,  abbr: "Sep", full: "September", season: "low"      },
  { n: 10, abbr: "Oct", full: "October",   season: "shoulder" },
  { n: 11, abbr: "Nov", full: "November",  season: "high"     },
  { n: 12, abbr: "Dec", full: "December",  season: "peak"     },
] as const;

const SEASON_LABEL: Record<string, string> = {
  peak: "Peak", high: "High", shoulder: "Shoulder", low: "Low",
};

const SEASON_COLOR: Record<string, { text: string; bg: string; border: string }> = {
  peak:     { text: "#3B82F6", bg: "rgba(59,130,246,0.15)",  border: "rgba(59,130,246,0.35)"  },
  high:     { text: "#00C2A8", bg: "rgba(0,194,168,0.15)",   border: "rgba(0,194,168,0.35)"   },
  shoulder: { text: "#F59E0B", bg: "rgba(245,158,11,0.15)",  border: "rgba(245,158,11,0.35)"  },
  low:      { text: "#F97316", bg: "rgba(249,115,22,0.15)",  border: "rgba(249,115,22,0.35)"  },
};

const VIEW_OPTIONS: { value: ViewType; label: string; labelEs: string; icon: string; pct: string }[] = [
  { value: "ocean",   label: "Ocean",   labelEs: "Océano",  icon: "🌊", pct: "+20%" },
  { value: "partial", label: "Partial", labelEs: "Parcial", icon: "🌤",  pct: "+10%" },
  { value: "city",    label: "City",    labelEs: "Ciudad",  icon: "🏙️", pct: "+2%"  },
  { value: "garden",  label: "Garden",  labelEs: "Jardín",  icon: "🌿", pct: "0%"   },
  { value: "none",    label: "None",    labelEs: "Ninguna", icon: "◻",  pct: "−2%"  },
];

const FINISH_OPTIONS: { value: FinishQuality; label: string; labelEs: string; desc: string; pct: string }[] = [
  { value: "standard", label: "Standard",  labelEs: "Estándar", desc: "Older / basic interiors",         pct: "baseline" },
  { value: "upgraded", label: "Upgraded",  labelEs: "Mejorado", desc: "Updated, above-average finish",   pct: "+10%"     },
  { value: "premium",  label: "Premium",   labelEs: "Premium",  desc: "Luxury-level design & furnishings", pct: "+22%"   },
];

// Secondary amenities — compact checkbox grid
const SECONDARY_AMENITY_OPTS = [
  { key: "gym",            label: "Gym / Fitness",    labelEs: "Gimnasio"           },
  { key: "hot_tub",        label: "Hot Tub / Jacuzzi",labelEs: "Jacuzzi"            },
  { key: "parking",        label: "Parking",           labelEs: "Estacionamiento"   },
  { key: "elevator",       label: "Elevator",          labelEs: "Elevador"          },
  { key: "laundry",        label: "In-Unit Laundry",   labelEs: "Lavandería"        },
  { key: "workspace",      label: "Workspace",         labelEs: "Área de trabajo"   },
  { key: "full_kitchen",   label: "Full Kitchen",      labelEs: "Cocina completa"   },
  { key: "pet_friendly",   label: "Pet Friendly",      labelEs: "Acepta mascotas"   },
  { key: "family_friendly",label: "Family Friendly",   labelEs: "Familiar"          },
];

// Beach distance presets
const BEACH_PRESETS = [
  { label: "Beachfront (≤150 ft)", m: 15 },
  { label: "Beach block (~150 ft)", m: 50 },
  { label: "1–2 blocks (~300 ft)", m: 100 },
  { label: "3–5 blocks (~600 ft)", m: 200 },
  { label: "6–10 blocks", m: 400 },
];

const CONFIDENCE_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  high:          { label: "High Confidence",   color: "#00C2A8", bg: "rgba(0,194,168,0.12)",  border: "rgba(0,194,168,0.3)" },
  medium:        { label: "Medium Confidence", color: "#F59E0B", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)" },
  low:           { label: "Low Confidence",    color: "#F97316", bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.3)" },
  guidance_only: { label: "Guidance Only",     color: "#EF4444", bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.3)" },
};

// ── API helpers ────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  const res = await fetch(`${base}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message ?? `API error: HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[10px] font-semibold uppercase tracking-widest mb-3", className)}
      style={{ color: "rgba(154,165,177,0.55)" }}>
      {children}
    </p>
  );
}

function FieldLabel({ children, optional }: { children: React.ReactNode; optional?: boolean }) {
  return (
    <label className="block text-sm font-medium text-foreground mb-1.5">
      {children}
      {optional && <span className="ml-1.5 text-[10px] font-normal" style={{ color: "rgba(154,165,177,0.45)" }}>optional</span>}
    </label>
  );
}

function StyledInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props}
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
    <select {...props}
      className={cn("w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50", props.className)}
      style={{ background: "#163C4A", border: "1px solid rgba(255,255,255,0.08)", color: "rgb(245,247,250)", ...props.style }}
    >
      {props.children}
    </select>
  );
}

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onChange} disabled={disabled}
      className="relative w-9 h-5 rounded-full transition-all duration-200 shrink-0"
      style={{ background: value ? "#00C2A8" : "rgba(255,255,255,0.1)" }}>
      <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200"
        style={{ left: value ? "calc(100% - 18px)" : "2px" }} />
    </button>
  );
}

function PrimaryButton({ onClick, loading, disabled, children }: {
  onClick: () => void; loading?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || loading}
      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm transition-all duration-200"
      style={{
        background: disabled || loading ? "rgba(0,194,168,0.3)" : "linear-gradient(135deg, #00C2A8 0%, #00D1FF 100%)",
        color: disabled || loading ? "rgba(255,255,255,0.5)" : "#0F2A36",
        boxShadow: disabled || loading ? "none" : "0 4px 16px rgba(0,194,168,0.35)",
        cursor: disabled || loading ? "not-allowed" : "pointer",
      }}>
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}

// ── Building combobox ─────────────────────────────────────────────────────────

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
        <input value={query}
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
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute z-50 w-full mt-1 rounded-xl overflow-hidden"
            style={{ background: "#0F2A36", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)", maxHeight: "200px", overflowY: "auto" }}>
            <div className="px-3 py-2 text-xs cursor-pointer hover:bg-white/5 transition-colors"
              style={{ color: "rgba(154,165,177,0.6)" }}
              onMouseDown={() => { onChange(""); setQuery(""); setOpen(false); }}>
              No specific building / skip
            </div>
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }} />
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">No match — your text will be fuzzy-matched by the engine.</div>
            )}
            {filtered.map(b => (
              <div key={b.canonical_building_name} className="px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
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

// ── Street autocomplete (light wrapper) ───────────────────────────────────────

function StreetAutocomplete({ placeholder, value, onChange, disabled }: {
  placeholder: string; value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <StyledInput
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
    />
  );
}

// ── Confidence badge ──────────────────────────────────────────────────────────

function ConfidenceBadge({ label }: { label: string }) {
  const cfg = CONFIDENCE_CONFIG[label] ?? CONFIDENCE_CONFIG.guidance_only;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border"
      style={{ background: cfg.bg, borderColor: cfg.border, color: cfg.color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: cfg.color }} />
      {cfg.label}
    </span>
  );
}

// ── Positioning badge ─────────────────────────────────────────────────────────

function PositioningBadge({ positioning }: { positioning: "underpriced" | "aligned" | "premium" }) {
  const configs = {
    underpriced: { icon: TrendingDown, label: "Underpriced", color: "#F59E0B", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)" },
    aligned:     { icon: Minus,        label: "Aligned",     color: "#00C2A8", bg: "rgba(0,194,168,0.12)",  border: "rgba(0,194,168,0.3)"  },
    premium:     { icon: TrendingUp,   label: "Top Tier",    color: "#3B82F6", bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.3)" },
  };
  const cfg = configs[positioning];
  const Icon = cfg.icon;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border"
      style={{ background: cfg.bg, borderColor: cfg.border, color: cfg.color }}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

// ── Layer color map ───────────────────────────────────────────────────────────

const LAYER_COLORS: Record<string, string> = {
  base_comp_median:  "#94A3B8",
  building_anchor:   "#00C2A8",
  beach_tier:        "#00D1FF",
  seasonal:          "#F59E0B",
  view_premium:      "#6366F1",
  rooftop_pool:      "#3B82F6",
  finish_quality:    "#8B5CF6",
  private_plunge_pool: "#EC4899",
  large_terrace:     "#10B981",
  quality:           "#F97316",
  guardrails:        "#64748B",
};

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PricingToolPage() {
  const { t } = useLanguage();

  // ── State ──
  const currentMonth = new Date().getMonth() + 1;

  const [form, setForm] = useState<FormValues>({
    neighborhood: "Zona Romantica",
    buildingName: "",
    bedrooms: 1,
    bathrooms: 1,
    month: currentMonth,
    viewType: "none",
    finishQuality: "standard",
    rooftopPool: false,
    privatePlungePool: false,
    largeTerrace: false,
    beachfront: false,
    distanceCustom: "",
    secondaryAmenities: [],
    size: "",
    ratingOverall: "",
    buildingYear: "",
    listingUrl: "",
    crossStreet1: "",
    crossStreet2: "",
  });

  const [beachPresetM, setBeachPresetM] = useState<number | null>(null);
  const [buildings, setBuildings] = useState<BuildingEntry[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [phase, setPhase] = useState<"idle" | "results" | "error">("idle");
  const [compsResult, setCompsResult] = useState<CompsResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showComps, setShowComps] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const setField = useCallback(<K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  }, []);

  // ── Load meta ──
  useEffect(() => {
    (async () => {
      try {
        const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
        const bRes = await fetch(`${base}/api/rental/buildings`);
        if (bRes.ok) {
          const bData = await bRes.json() as { buildings: BuildingEntry[] };
          setBuildings(bData.buildings ?? []);
        }
      } catch { /* silent */ } finally {
        setLoadingMeta(false);
      }
    })();
  }, []);

  // Auto-set distance when beachfront toggled
  useEffect(() => {
    if (form.beachfront) setBeachPresetM(15);
  }, [form.beachfront]);

  // Derived distance in meters
  const distanceM = useMemo(() => {
    if (form.beachfront) return 15;
    if (beachPresetM !== null) return beachPresetM;
    if (form.distanceCustom) {
      // treat as feet → convert to meters
      const ft = parseFloat(form.distanceCustom);
      if (!isNaN(ft) && ft >= 0) return Math.round(ft * 0.3048);
    }
    return null;
  }, [form.beachfront, beachPresetM, form.distanceCustom]);

  // Scroll to results
  useEffect(() => {
    if (phase === "results" && resultsRef.current) {
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    }
    if (phase === "error" && errorRef.current) {
      setTimeout(() => errorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    }
  }, [phase]);

  // ── Handle Get Price ──
  const handleGetPrice = useCallback(async () => {
    if (distanceM === null) {
      alert(t("Please select a beach distance.", "Por favor seleccione la distancia a la playa."));
      return;
    }
    if (form.bedrooms === 0) {
      // Studio → send as 1BR for engine
    }

    setIsLoading(true);
    setPhase("idle");
    setErrorMsg(null);

    // Build amenities from secondary selections + premium feature keys
    const amenities: string[] = [...form.secondaryAmenities];
    if (form.rooftopPool) amenities.push("rooftop_pool");
    if (form.privatePlungePool) amenities.push("private_pool");
    if (form.largeTerrace) amenities.push("outdoor_space");
    if (form.beachfront) amenities.push("beachfront");

    const payload = {
      neighborhood_normalized: form.neighborhood,
      bedrooms: Math.max(1, form.bedrooms),
      bathrooms: form.bathrooms,
      sqft: form.size ? parseFloat(form.size) : null,
      distance_to_beach_m: distanceM,
      amenities_normalized: amenities,
      rating_overall: form.ratingOverall ? parseFloat(form.ratingOverall) : null,
      building_name: form.buildingName || null,
      month: form.month,
      view_type: form.viewType,
      rooftop_pool: form.rooftopPool,
      year_built: form.buildingYear || "",
      finish_quality: form.finishQuality,
      private_plunge_pool: form.privatePlungePool,
      large_terrace: form.largeTerrace,
    };

    try {
      const result = await apiFetch<CompsResult>("/api/rental/comps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setCompsResult(result);
      setPhase("results");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    } finally {
      setIsLoading(false);
    }
  }, [form, distanceM, t]);

  // ── Secondary amenity toggle ──
  const toggleSecondary = useCallback((key: string) => {
    setForm(prev => {
      const has = prev.secondaryAmenities.includes(key);
      return { ...prev, secondaryAmenities: has ? prev.secondaryAmenities.filter(k => k !== key) : [...prev.secondaryAmenities, key] };
    });
  }, []);

  const selectedMonth = MONTHS.find(m => m.n === form.month)!;

  // ── Pricing bullets from breakdown ──
  const pricingBullets = useMemo(() => {
    if (!compsResult) return [];
    return compsResult.pricing_breakdown
      .filter(l => l.applied && l.adjustment_pct !== null && l.layer !== "base_comp_median" && l.layer !== "guardrails")
      .map(l => ({
        positive: (l.adjustment_pct ?? 0) >= 0,
        label: l.label,
        pct: l.adjustment_pct!,
        note: l.note,
      }));
  }, [compsResult]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <PageWrapper
      title={t("Pricing Tool", "Herramienta de Precios")}
      description={t(
        "Market intelligence engine for Puerto Vallarta vacation rentals.",
        "Motor de inteligencia de mercado para rentas vacacionales en Puerto Vallarta."
      )}
    >
      <div className="space-y-5">

        {/* ═══════════════════ FORM CARD ═══════════════════ */}
        <Card className="glass-card">
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Building2 className="w-4 h-4" style={{ color: "#00C2A8" }} />
              {t("Property Details", "Detalles de la Propiedad")}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("We analyze your building, unit, and the PV market to recommend your ideal rate.", "Analizamos tu edificio, unidad y el mercado de PV para recomendar tu precio ideal.")}
            </p>
          </CardHeader>

          <CardContent className="space-y-0">

            {/* ══ Section A: Property Basics ══ */}
            <div className="pb-5 space-y-4">
              <SectionLabel>{t("Property Basics", "Datos Básicos")}</SectionLabel>

              {/* Month */}
              <div>
                <FieldLabel>{t("Pricing month", "Mes de referencia")}</FieldLabel>
                <div className="flex items-center gap-3">
                  <StyledSelect value={form.month}
                    onChange={e => setField("month", Number(e.target.value) as typeof form.month)}
                    disabled={isLoading} className="max-w-[160px]">
                    {MONTHS.map(m => <option key={m.n} value={m.n}>{m.full}</option>)}
                  </StyledSelect>
                  {(() => {
                    const sc = SEASON_COLOR[selectedMonth.season];
                    return (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border shrink-0"
                        style={{ background: sc.bg, borderColor: sc.border, color: sc.text }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: sc.text }} />
                        {SEASON_LABEL[selectedMonth.season]} Season
                      </span>
                    );
                  })()}
                </div>
              </div>

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
                    <option value="Old Town">Old Town</option>
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
                <FieldLabel optional>{t("Property / Building Name", "Nombre del Edificio")}</FieldLabel>
                {loadingMeta
                  ? <Skeleton className="h-10 rounded-xl" />
                  : <BuildingCombobox buildings={buildings} value={form.buildingName}
                      onChange={v => setField("buildingName", v)} disabled={isLoading} />}
                <p className="text-[11px] mt-1" style={{ color: "rgba(154,165,177,0.4)" }}>
                  {t("Selecting a known building dramatically improves accuracy.", "Seleccionarlo mejora drásticamente la precisión.")}
                </p>
              </div>

              {/* Bedrooms + Bathrooms */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel>{t("Bedrooms", "Recámaras")}</FieldLabel>
                  <div className="flex gap-1.5 flex-wrap">
                    {BR_OPTIONS.map(o => (
                      <button key={o.value} type="button"
                        onClick={() => setField("bedrooms", o.value as typeof form.bedrooms)}
                        disabled={isLoading}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium border transition-all"
                        style={{
                          background: form.bedrooms === o.value ? "rgba(0,194,168,0.15)" : "rgba(255,255,255,0.04)",
                          borderColor: form.bedrooms === o.value ? "rgba(0,194,168,0.5)" : "rgba(255,255,255,0.08)",
                          color: form.bedrooms === o.value ? "#00C2A8" : "rgba(154,165,177,0.7)",
                        }}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <FieldLabel>{t("Bathrooms", "Baños")}</FieldLabel>
                  <div className="flex gap-1.5">
                    {BATH_OPTIONS.map(o => (
                      <button key={o.value} type="button"
                        onClick={() => setField("bathrooms", o.value as typeof form.bathrooms)}
                        disabled={isLoading}
                        className="flex-1 py-1.5 rounded-lg text-sm font-medium border transition-all"
                        style={{
                          background: form.bathrooms === o.value ? "rgba(0,194,168,0.15)" : "rgba(255,255,255,0.04)",
                          borderColor: form.bathrooms === o.value ? "rgba(0,194,168,0.5)" : "rgba(255,255,255,0.08)",
                          color: form.bathrooms === o.value ? "#00C2A8" : "rgba(154,165,177,0.7)",
                        }}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ══ Section B: Premium Features ══ */}
            <div className="py-5 space-y-4 border-t border-white/5">
              <SectionLabel>{t("Premium Features", "Características Premium")}</SectionLabel>

              {/* View */}
              <div>
                <FieldLabel>{t("View", "Vista")}</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  {VIEW_OPTIONS.map(v => (
                    <button key={v.value} type="button"
                      onClick={() => setField("viewType", v.value)}
                      disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all"
                      style={{
                        background: form.viewType === v.value ? "rgba(0,194,168,0.15)" : "rgba(255,255,255,0.04)",
                        borderColor: form.viewType === v.value ? "rgba(0,194,168,0.5)" : "rgba(255,255,255,0.08)",
                        color: form.viewType === v.value ? "#00C2A8" : "rgba(154,165,177,0.7)",
                      }}>
                      <span>{v.icon}</span>
                      <span>{t(v.label, v.labelEs)}</span>
                      <span className="text-[10px] opacity-60">{v.pct}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Finish quality */}
              <div>
                <FieldLabel>{t("Interior / Finish Quality", "Calidad de Interiores")}</FieldLabel>
                <div className="grid grid-cols-3 gap-2">
                  {FINISH_OPTIONS.map(f => (
                    <button key={f.value} type="button"
                      onClick={() => setField("finishQuality", f.value)}
                      disabled={isLoading}
                      className="flex flex-col items-start p-3 rounded-xl border transition-all text-left"
                      style={{
                        background: form.finishQuality === f.value ? "rgba(0,194,168,0.1)" : "rgba(255,255,255,0.03)",
                        borderColor: form.finishQuality === f.value ? "rgba(0,194,168,0.45)" : "rgba(255,255,255,0.07)",
                      }}>
                      <span className="text-sm font-semibold" style={{ color: form.finishQuality === f.value ? "#00C2A8" : "rgba(245,247,250,0.85)" }}>
                        {t(f.label, f.labelEs)}
                      </span>
                      <span className="text-[10px] mt-0.5" style={{ color: "rgba(154,165,177,0.5)" }}>{f.desc}</span>
                      <span className="text-[10px] font-semibold mt-1" style={{ color: form.finishQuality === f.value ? "#00C2A8" : "rgba(154,165,177,0.4)" }}>{f.pct}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Premium toggles */}
              <div className="space-y-2">
                {[
                  {
                    key: "rooftopPool" as keyof FormValues,
                    label: t("Rooftop Pool", "Alberca en Azotea"),
                    desc: "+15–18% — scarcest lifestyle premium in PV",
                    value: form.rooftopPool,
                  },
                  {
                    key: "privatePlungePool" as keyof FormValues,
                    label: t("Private Pool / Plunge Pool", "Alberca / Jacuzzi Privado"),
                    desc: "+12% — rare in ZR/Amapas; strong unit-level premium",
                    value: form.privatePlungePool,
                  },
                  {
                    key: "largeTerrace" as keyof FormValues,
                    label: t("Large Terrace / Outdoor Living", "Terraza Grande / Sala Exterior"),
                    desc: "+8% — indoor-outdoor lifestyle is the primary PV demand driver",
                    value: form.largeTerrace,
                  },
                  {
                    key: "beachfront" as keyof FormValues,
                    label: t("Beachfront / Direct Beach Access", "Frente a la Playa"),
                    desc: "Sets distance to ≤50 ft — treated as Tier A beach proximity",
                    value: form.beachfront,
                  },
                ].map(item => (
                  <div key={item.key}
                    className="flex items-center justify-between py-2.5 px-3 rounded-xl border transition-all"
                    style={{
                      background: (item.value as boolean) ? "rgba(0,194,168,0.06)" : "rgba(255,255,255,0.02)",
                      borderColor: (item.value as boolean) ? "rgba(0,194,168,0.22)" : "rgba(255,255,255,0.06)",
                    }}>
                    <div>
                      <p className="text-sm font-medium">{item.label}</p>
                      <p className="text-[11px]" style={{ color: "rgba(154,165,177,0.5)" }}>{item.desc}</p>
                    </div>
                    <Toggle value={item.value as boolean}
                      onChange={() => setField(item.key, !(item.value as boolean) as FormValues[typeof item.key])}
                      disabled={isLoading} />
                  </div>
                ))}
              </div>
            </div>

            {/* ══ Section C: Beach Distance ══ */}
            <div className="py-5 border-t border-white/5 space-y-3">
              <SectionLabel>{t("Beach Distance", "Distancia a la Playa")}</SectionLabel>
              {form.beachfront ? (
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl"
                  style={{ background: "rgba(0,194,168,0.08)", border: "1px solid rgba(0,194,168,0.2)" }}>
                  <Waves className="w-3.5 h-3.5" style={{ color: "#00C2A8" }} />
                  <span className="text-sm" style={{ color: "#00C2A8" }}>
                    {t("Beachfront selected — distance set to ≤50 ft", "Frente a playa seleccionado — distancia ≤50 ft")}
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {BEACH_PRESETS.map(p => {
                      const isSelected = beachPresetM === p.m && !form.distanceCustom;
                      return (
                        <button key={p.m} type="button"
                          onClick={() => { setBeachPresetM(p.m); setField("distanceCustom", ""); }}
                          disabled={isLoading}
                          className="px-2.5 py-1 rounded-lg text-[11px] border transition-all"
                          style={{
                            background: isSelected ? "rgba(0,194,168,0.15)" : "rgba(255,255,255,0.04)",
                            borderColor: isSelected ? "rgba(0,194,168,0.4)" : "rgba(255,255,255,0.08)",
                            color: isSelected ? "#00C2A8" : "rgba(245,247,250,0.5)",
                          }}>
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                  <StyledInput type="number" min={0} placeholder="Or enter distance in feet (e.g. 500)"
                    value={form.distanceCustom}
                    onChange={e => { setField("distanceCustom", e.target.value); setBeachPresetM(null); }}
                    disabled={isLoading} className="max-w-[280px]" />
                  {distanceM === null && (
                    <p className="text-xs" style={{ color: "#F59E0B" }}>
                      {t("Please select or enter a beach distance before getting your price.", "Por favor seleccione la distancia a la playa.")}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* ══ Section D: Secondary Amenities ══ */}
            <div className="py-5 border-t border-white/5 space-y-3">
              <SectionLabel>{t("Secondary Features", "Características Secundarias")}</SectionLabel>
              <div className="grid grid-cols-2 gap-1.5">
                {SECONDARY_AMENITY_OPTS.map(a => {
                  const isOn = form.secondaryAmenities.includes(a.key);
                  return (
                    <button key={a.key} type="button"
                      onClick={() => toggleSecondary(a.key)} disabled={isLoading}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-all"
                      style={{
                        background: isOn ? "rgba(0,194,168,0.08)" : "rgba(255,255,255,0.03)",
                        borderColor: isOn ? "rgba(0,194,168,0.3)" : "rgba(255,255,255,0.06)",
                      }}>
                      <span className="w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 border transition-colors"
                        style={{
                          background: isOn ? "rgba(0,194,168,0.2)" : "transparent",
                          borderColor: isOn ? "rgba(0,194,168,0.6)" : "rgba(255,255,255,0.15)",
                        }}>
                        {isOn && <CheckCircle2 className="w-2.5 h-2.5" style={{ color: "#00C2A8" }} />}
                      </span>
                      <span className="text-xs" style={{ color: isOn ? "#00C2A8" : "rgba(245,247,250,0.65)" }}>
                        {t(a.label, a.labelEs)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ══ Section E: Optional (collapsed) ══ */}
            <div className="pt-4 border-t border-white/5">
              <button type="button" onClick={() => setShowAdvanced(v => !v)} disabled={isLoading}
                className="flex items-center gap-1.5 text-xs transition-colors"
                style={{ color: "rgba(154,165,177,0.45)" }}>
                {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {t("More details", "Más detalles")}
                <span style={{ color: "rgba(154,165,177,0.3)" }}>
                  · {t("size · rating · year · location hint · URL", "tamaño · rating · año · referencia · URL")}
                </span>
              </button>
              <AnimatePresence>
                {showAdvanced && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
                    <div className="space-y-3 pt-4">

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <FieldLabel optional>{t("Unit size (sqft)", "Tamaño (sqft)")}</FieldLabel>
                          <StyledInput type="number" min={0} placeholder="e.g. 900"
                            value={form.size} onChange={e => setField("size", e.target.value)} disabled={isLoading} />
                        </div>
                        <div>
                          <FieldLabel optional>{t("Guest rating", "Calificación")}</FieldLabel>
                          <StyledSelect value={form.ratingOverall}
                            onChange={e => setField("ratingOverall", e.target.value)} disabled={isLoading}>
                            <option value="">— Not yet rated —</option>
                            {Array.from({ length: 41 }, (_, i) => parseFloat((5.0 - i * 0.1).toFixed(1))).map(r => (
                              <option key={r} value={r}>{r.toFixed(1)} ★</option>
                            ))}
                          </StyledSelect>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <FieldLabel optional>{t("Year built", "Año de construcción")}</FieldLabel>
                          <StyledSelect value={form.buildingYear}
                            onChange={e => setField("buildingYear", e.target.value)} disabled={isLoading}>
                            <option value="">— Unknown —</option>
                            <option value="2020+">2020 or later</option>
                            <option value="2015-2019">2015–2019</option>
                            <option value="2010-2014">2010–2014</option>
                            <option value="2000-2009">2000–2009</option>
                            <option value="1990-1999">1990–1999</option>
                            <option value="pre-1990">pre-1990</option>
                          </StyledSelect>
                        </div>
                        <div>
                          <FieldLabel optional>
                            {t("Listing URL", "URL del Listado")}
                            <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold"
                              style={{ background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.25)", color: "#818CF8" }}>
                              <Sparkles className="w-2 h-2" /> AI soon
                            </span>
                          </FieldLabel>
                          <StyledInput type="url" placeholder="airbnb.com/rooms/…"
                            value={form.listingUrl} onChange={e => setField("listingUrl", e.target.value)} disabled={isLoading} />
                        </div>
                      </div>

                      <div>
                        <FieldLabel optional>{t("Location hint", "Referencia de ubicación")}</FieldLabel>
                        <div className="flex items-center gap-2">
                          <StreetAutocomplete placeholder={t("Cross street or landmark", "Calle o referencia")}
                            value={form.crossStreet1} onChange={v => setField("crossStreet1", v)} disabled={isLoading} />
                          <span className="text-muted-foreground text-sm shrink-0">×</span>
                          <StreetAutocomplete placeholder={t("2nd street (optional)", "2ª calle")}
                            value={form.crossStreet2} onChange={v => setField("crossStreet2", v)} disabled={isLoading} />
                        </div>
                      </div>

                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* ── CTA ── */}
            <div className="pt-5">
              <PrimaryButton onClick={handleGetPrice} loading={isLoading} disabled={isLoading || distanceM === null}>
                {isLoading
                  ? t("Analyzing your property…", "Analizando tu propiedad…")
                  : t("Get My Market Price", "Obtener Mi Precio de Mercado")}
                {!isLoading && <BarChart3 className="w-4 h-4" />}
              </PrimaryButton>
            </div>

          </CardContent>
        </Card>

        {/* ═══════════════════ ERROR ═══════════════════ */}
        <AnimatePresence>
          {phase === "error" && errorMsg && (
            <motion.div ref={errorRef} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex items-start gap-3 p-4 rounded-xl"
              style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)" }}>
              <XCircle className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "#EF4444" }} />
              <div>
                <p className="text-sm font-semibold">{t("Something went wrong", "Algo salió mal")}</p>
                <p className="text-xs mt-1 text-muted-foreground">{errorMsg}</p>
                <button onClick={handleGetPrice} className="mt-2 text-xs font-medium flex items-center gap-1" style={{ color: "#00C2A8" }}>
                  <RefreshCw className="w-3 h-3" /> {t("Try again", "Intentar de nuevo")}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ═══════════════════ RESULTS ═══════════════════ */}
        <AnimatePresence>
          {phase === "results" && compsResult && (
            <motion.div ref={resultsRef} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.4 }} className="space-y-4">

              {/* ── Hero: Recommended price + positioning ── */}
              <div className="rounded-2xl p-6"
                style={{
                  background: "linear-gradient(135deg, #0F2A36 0%, #163C4A 100%)",
                  border: "1px solid rgba(0,194,168,0.2)",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
                }}>

                {/* Positioning statement */}
                {compsResult.positioning_statement && (
                  <div className="flex items-start gap-2 mb-4 pb-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    <Info className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "rgba(0,194,168,0.7)" }} />
                    <p className="text-sm" style={{ color: "rgba(245,247,250,0.8)" }}>
                      {compsResult.positioning_statement}
                    </p>
                  </div>
                )}

                <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
                  {/* Price */}
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: "rgba(0,194,168,0.7)" }}>
                      {t("Recommended Nightly Rate", "Tarifa Nocturna Recomendada")}
                    </p>
                    <div className="flex items-baseline gap-2">
                      <span className="text-6xl font-extrabold tracking-tight" style={{ color: "#00C2A8" }}>
                        {compsResult.recommended_price ? formatCurrency(compsResult.recommended_price) : "—"}
                      </span>
                      <span className="text-lg font-medium text-muted-foreground">/night</span>
                    </div>
                    <p className="text-xs mt-1.5" style={{ color: "rgba(154,165,177,0.6)" }}>
                      {compsResult.seasonal.display_label}
                    </p>
                    {compsResult.recommended_price && (
                      <div className="flex items-center gap-5 mt-3">
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
                    )}
                  </div>

                  {/* Confidence + comps */}
                  <div className="flex flex-col gap-2 items-start md:items-end shrink-0">
                    <ConfidenceBadge label={compsResult.confidence_label} />
                    {compsResult.building_context && (
                      <PositioningBadge positioning={compsResult.building_context.positioning} />
                    )}
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
                    <p className="text-[10px] text-right" style={{ color: "rgba(154,165,177,0.35)" }}>
                      PVRPV + Vacation Vallarta + Airbnb + VRBO
                    </p>
                  </div>
                </div>
              </div>

              {/* ── Building context ── */}
              {compsResult.building_context && (
                <Card className="glass-card">
                  <CardContent className="pt-5 pb-4">
                    <div className="flex items-center gap-2 mb-4">
                      <Building className="w-4 h-4" style={{ color: "#00C2A8" }} />
                      <span className="text-sm font-semibold">{compsResult.building_context.building_name}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: "rgba(0,194,168,0.1)", color: "#00C2A8" }}>
                        Building Intelligence
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="text-center py-3 px-2 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{t("Building Median", "Mediana del edificio")}</p>
                        <p className="text-xl font-bold">{formatCurrency(compsResult.building_context.median_price)}</p>
                      </div>
                      <div className="text-center py-3 px-2 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{t("Lower Range", "Rango bajo")}</p>
                        <p className="text-xl font-bold">{formatCurrency(compsResult.building_context.range_low)}</p>
                      </div>
                      <div className="text-center py-3 px-2 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{t("Upper Range", "Rango alto")}</p>
                        <p className="text-xl font-bold">{formatCurrency(compsResult.building_context.range_high)}</p>
                      </div>
                    </div>
                    <p className="text-[11px] mt-2.5 text-center" style={{ color: "rgba(154,165,177,0.45)" }}>
                      {t(`Based on ${compsResult.building_context.comp_count} listings from this building in the comp set · Adjusted to ${compsResult.seasonal.month_name} pricing`,
                         `Basado en ${compsResult.building_context.comp_count} listados de este edificio · Ajustado a ${compsResult.seasonal.month_name}`)}
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* ── Seasonal pricing sweep ── */}
              {compsResult.seasonal_sweep && (
                <Card className="glass-card">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Calendar className="w-4 h-4" style={{ color: "#F59E0B" }} />
                      {t("Seasonal Pricing Guide", "Guía de Precios por Temporada")}
                    </CardTitle>
                    <p className="text-[11px] text-muted-foreground">
                      {t("Same property — same features — different months", "Misma propiedad, mismas características, distintos meses")}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      {[
                        { key: "low" as const,      label: t("Low Season", "Temporada Baja"),     sublabel: "Jun–Sep",        season: "low"      },
                        { key: "shoulder" as const,  label: t("Shoulder", "Temporada Media"),      sublabel: "May, Oct",       season: "shoulder" },
                        { key: "high" as const,      label: t("High Season", "Temporada Alta"),    sublabel: "Nov, Jan, Apr",  season: "high"     },
                        { key: "peak" as const,      label: t("Peak Season", "Temporada Pico"),    sublabel: "Feb, Mar, Dec",  season: "peak"     },
                      ].map(({ key, label, sublabel, season }) => {
                        const price = compsResult.seasonal_sweep![key];
                        const sc = SEASON_COLOR[season];
                        const isCurrent = compsResult.seasonal.season === season;
                        return (
                          <div key={key} className="flex flex-col items-center py-4 px-3 rounded-xl text-center transition-all"
                            style={{
                              background: isCurrent ? sc.bg : "rgba(255,255,255,0.03)",
                              border: `1px solid ${isCurrent ? sc.border : "rgba(255,255,255,0.06)"}`,
                            }}>
                            {isCurrent && (
                              <span className="text-[9px] font-bold uppercase tracking-widest mb-1.5"
                                style={{ color: sc.text }}>▸ Current</span>
                            )}
                            <p className="text-[10px] font-semibold uppercase tracking-wide mb-1"
                              style={{ color: isCurrent ? sc.text : "rgba(154,165,177,0.6)" }}>{label}</p>
                            <p className="text-2xl font-extrabold" style={{ color: isCurrent ? sc.text : "rgba(245,247,250,0.9)" }}>
                              {formatCurrency(price)}
                            </p>
                            <p className="text-[10px] mt-1" style={{ color: "rgba(154,165,177,0.45)" }}>{sublabel}</p>
                          </div>
                        );
                      })}
                    </div>
                    {compsResult.seasonal.event_name && (
                      <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg"
                        style={{ background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.2)" }}>
                        <Flame className="w-3.5 h-3.5" style={{ color: "#F97316" }} />
                        <span className="text-xs" style={{ color: "#F97316" }}>
                          {compsResult.seasonal.event_name}: +{compsResult.seasonal.event_premium_pct}% event premium applied to {compsResult.seasonal.month_name}
                        </span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ── Pricing explanation bullets ── */}
              {pricingBullets.length > 0 && (
                <Card className="glass-card">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <TrendingUp className="w-4 h-4" style={{ color: "#00C2A8" }} />
                      {t("Why This Rate", "Por Qué Este Precio")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {pricingBullets.map((b, i) => (
                        <div key={i} className="flex items-start gap-2.5">
                          <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold"
                            style={{
                              background: b.positive ? "rgba(0,194,168,0.15)" : "rgba(249,115,22,0.15)",
                              color: b.positive ? "#00C2A8" : "#F97316",
                            }}>
                            {b.positive ? "+" : "−"}
                          </span>
                          <div>
                            <span className="text-sm font-medium" style={{ color: b.positive ? "#00C2A8" : "#F97316" }}>
                              {b.label}
                              <span className="ml-1.5 text-[11px] font-normal" style={{ color: "rgba(154,165,177,0.6)" }}>
                                ({b.positive ? "+" : ""}{b.pct}%)
                              </span>
                            </span>
                            <p className="text-[11px] mt-0.5 text-muted-foreground">{b.note}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] mt-3 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", color: "rgba(154,165,177,0.4)" }}>
                      Base comp median: {formatCurrency(compsResult.base_comp_median)} · All adjustments applied sequentially
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* ── Warnings ── */}
              {compsResult.warnings.length > 0 && (
                <div className="space-y-1.5">
                  {compsResult.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 p-3 rounded-xl"
                      style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "#F59E0B" }} />
                      <p className="text-[11px]" style={{ color: "rgba(245,247,250,0.75)" }}>{w}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* ── 7-Layer Breakdown (collapsible) ── */}
              <Card className="glass-card">
                <CardHeader className="pb-0">
                  <button type="button" className="flex items-center justify-between w-full"
                    onClick={() => setShowBreakdown(v => !v)}>
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Layers className="w-4 h-4" style={{ color: "#00C2A8" }} />
                      {t("Full Pricing Breakdown", "Desglose Completo")}
                      <span className="text-[10px] font-normal px-2 py-0.5 rounded-full ml-1"
                        style={{ background: "rgba(0,194,168,0.1)", color: "#00C2A8" }}>
                        {compsResult.pricing_breakdown.length} layers
                      </span>
                    </CardTitle>
                    {showBreakdown
                      ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                      : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                  </button>
                </CardHeader>
                <AnimatePresence>
                  {showBreakdown && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                      <CardContent className="pt-4">
                        <div className="space-y-1.5">
                          {compsResult.pricing_breakdown.map((layer, idx) => {
                            const isBase = layer.layer === "base_comp_median";
                            const pct = layer.adjustment_pct;
                            const pctStr = pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : null;
                            const color = LAYER_COLORS[layer.layer] ?? "#94A3B8";
                            return (
                              <div key={idx}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
                                style={{
                                  background: isBase ? "rgba(0,194,168,0.06)" : layer.applied ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.01)",
                                  border: `1px solid ${isBase ? "rgba(0,194,168,0.2)" : "rgba(255,255,255,0.05)"}`,
                                  opacity: layer.applied || isBase ? 1 : 0.4,
                                }}>
                                <div className="w-1.5 h-6 rounded-full shrink-0" style={{ background: layer.applied ? color : "rgba(255,255,255,0.1)" }} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-foreground">{layer.label}</span>
                                    {pctStr && layer.applied && (
                                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
                                        style={{
                                          background: (pct ?? 0) >= 0 ? "rgba(0,194,168,0.12)" : "rgba(249,115,22,0.12)",
                                          color: (pct ?? 0) >= 0 ? "#00C2A8" : "#F97316",
                                        }}>
                                        {pctStr}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{layer.note}</p>
                                </div>
                                <div className="text-right shrink-0">
                                  <span className="text-sm font-semibold">{formatCurrency(layer.cumulative_price)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </CardContent>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Card>

              {/* ── Selected Comps (collapsible) ── */}
              {compsResult.selected_comps.length > 0 && (
                <Card className="glass-card">
                  <CardHeader className="pb-0">
                    <button type="button" className="flex items-center justify-between w-full"
                      onClick={() => setShowComps(v => !v)}>
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Home className="w-4 h-4" style={{ color: "#00C2A8" }} />
                        {t("Top Comparable Listings", "Comparables Seleccionados")}
                        <span className="text-[10px] font-normal px-2 py-0.5 rounded-full ml-1"
                          style={{ background: "rgba(0,194,168,0.1)", color: "#00C2A8" }}>
                          {compsResult.selected_comps.length}
                        </span>
                      </CardTitle>
                      {showComps
                        ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                        : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                    </button>
                  </CardHeader>
                  <AnimatePresence>
                    {showComps && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                        <CardContent className="pt-4">
                          <div className="space-y-2">
                            {compsResult.selected_comps.map(c => (
                              <div key={c.rank} className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
                                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
                                <span className="text-xs font-bold w-5 text-center shrink-0"
                                  style={{ color: "rgba(154,165,177,0.4)" }}>#{c.rank}</span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs text-foreground">{c.bedrooms}BR · {c.bathrooms}BA</span>
                                    {c.building_name && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded"
                                        style={{ background: "rgba(0,194,168,0.1)", color: "#00C2A8" }}>
                                        {c.building_name}
                                      </span>
                                    )}
                                    {c.rating_overall && (
                                      <span className="text-[10px]" style={{ color: "rgba(154,165,177,0.5)" }}>
                                        {c.rating_overall.toFixed(1)} ★
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] mt-0.5" style={{ color: "rgba(154,165,177,0.4)" }}>
                                    {c.neighborhood} · {c.distance_to_beach_m}m to beach · Tier {c.beach_tier}
                                  </p>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="text-sm font-bold">{formatCurrency(c.nightly_price_usd)}</p>
                                  <p className="text-[10px]" style={{ color: "rgba(154,165,177,0.4)" }}>
                                    score {c.score}
                                  </p>
                                </div>
                                {c.source_url && (
                                  <a href={c.source_url} target="_blank" rel="noopener noreferrer"
                                    className="shrink-0 text-muted-foreground hover:text-primary transition-colors">
                                    <Link2 className="w-3.5 h-3.5" />
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Card>
              )}

              {/* ── Model limitations ── */}
              <div className="px-4 py-3 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "rgba(154,165,177,0.4)" }}>
                  {t("Model Limitations", "Limitaciones del Modelo")}
                </p>
                <ul className="space-y-1">
                  {compsResult.model_limitations.map((l, i) => (
                    <li key={i} className="text-[10px]" style={{ color: "rgba(154,165,177,0.4)" }}>· {l}</li>
                  ))}
                </ul>
              </div>

              {/* Reset */}
              <button type="button" onClick={() => setPhase("idle")}
                className="flex items-center gap-1.5 text-xs mx-auto transition-colors"
                style={{ color: "rgba(154,165,177,0.4)" }}>
                <RefreshCw className="w-3.5 h-3.5" />
                {t("Adjust inputs & recalculate", "Ajustar y recalcular")}
              </button>

            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </PageWrapper>
  );
}
