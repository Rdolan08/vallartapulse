#!/usr/bin/env python3
"""
seed-sesnsp.py
────────────────────────────────────────────────────────────────────────────────
Downloads the SESNSP Incidencia Delictiva Municipal CSV (IDM_NM_dic25.csv),
filters rows for Puerto Vallarta (Jalisco), and replaces ALL rows in the
safety_metrics table with real data from 2015 onwards.

CSV columns (latin-1, 21 cols):
  Año | Clave_Ent | Entidad | Cve.Municipio | Municipio |
  Bien jurídico afectado | Tipo de delito | Subtipo de delito | Modalidad |
  Enero | Febrero | Marzo | Abril | Mayo | Junio | Julio | Agosto |
  Septiembre | Octubre | Noviembre | Diciembre

Run:
  DATABASE_URL=... python3 scripts/seed-sesnsp.py
────────────────────────────────────────────────────────────────────────────────
"""

import os, sys, csv, io, urllib.request, collections
import psycopg2

DATABASE_URL = os.environ["DATABASE_URL"]
SESNSP_URL   = "https://repodatos.atdt.gob.mx/api_update/sesnsp/incidencia_delictiva/IDM_NM_dic25.csv"
MUNICIPALITY = "Puerto Vallarta"
STATE        = "Jalisco"
PVR_POP      = 297453  # 2020 INEGI census population for Puerto Vallarta

# ── Crime category mapping ────────────────────────────────────────────────────
# Maps "Tipo de delito" (Spanish) → English category in our schema.
# Entries not matched are collected in "Other".
CATEGORY_MAP = {
    # Violent
    "Lesiones dolosas":                    ("Assault / Bodily Harm",    "Lesiones dolosas",       "violent"),
    "Lesiones culposas":                   ("Assault / Bodily Harm",    "Lesiones culposas",      "violent"),
    "Feminicidio":                         ("Femicide",                  "Feminicidio",            "violent"),
    "Violación simple":                    ("Rape",                     "Violación sexual",       "violent"),
    "Violación equiparada":                ("Rape",                     "Violación sexual",       "violent"),
    "Abuso sexual":                        ("Sexual Abuse",             "Abuso sexual",           "violent"),
    "Acoso sexual":                        ("Other Sexual Crimes",      "Acoso sexual",           "violent"),
    "Hostigamiento sexual":                ("Other Sexual Crimes",      "Hostigamiento sexual",   "violent"),
    "Violencia de género en todas sus modalidades distintas a la violación": ("Other Sexual Crimes", "Violencia de género", "violent"),
    # Property
    "Robo de vehículo automotor":          ("Vehicle Theft",            "Robo de vehículo",       "property"),
    "Robo a casa habitación":              ("Burglary (Non-Violent)",   "Robo a casa habitación", "property"),
    "Robo a negocio":                      ("Business Robbery",         "Robo a negocio",         "property"),
    "Robo a transeúnte en espacio abierto al público": ("Street Robbery", "Robo a transeúnte",  "property"),
    "Robo de objetos de vehículo automotor": ("Other Robbery",          "Robo de objetos",        "property"),
    "Robo en transporte individual":       ("Other Robbery",            "Robo en transporte",     "property"),
    "Robo a repartidor":                   ("Other Robbery",            "Robo a repartidor",      "property"),
    "Robo de maquinaria":                  ("Other Robbery",            "Robo de maquinaria",     "property"),
    "Robo a institución bancaria":         ("Business Robbery",         "Robo a banco",           "property"),
    "Abigeato":                            ("Other Robbery",            "Abigeato",               "property"),
    "Fraude":                              ("Fraud",                    "Fraude",                 "property"),
    "Extorsión":                           ("Extortion",                "Extorsión",              "property"),
    "Daño en propiedad":                   ("Property Damage",          "Daño en propiedad",      "property"),
    "Despojo":                             ("Other Robbery",            "Despojo",                "property"),
    # Public order / personal safety
    "Violencia familiar":                  ("Domestic Violence",        "Violencia familiar",     "domestic"),
    "Amenazas":                            ("Threats",                  "Amenazas",               "other"),
    "Tráfico de drogas":                   ("Drug Dealing",             "Tráfico de drogas",      "drug"),
    "Narcomenudeo":                        ("Drug Dealing",             "Narcomenudeo",           "drug"),
    "Robo con violencia":                  ("Burglary (Violent)",       "Robo con violencia",     "property"),
}

MONTHS_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
             "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"]
MONTHS_EN = ["January","February","March","April","May","June",
             "July","August","September","October","November","December"]

def safe_int(v):
    try:
        return int(v)
    except:
        return 0

def main():
    print(f"Streaming SESNSP municipal data from {SESNSP_URL} …")
    print("(Filtering for Puerto Vallarta, Jalisco — this may take 1-2 minutes)")

    # key: (year, month, category_en) → count
    counts = collections.defaultdict(int)
    # Also track raw category_es and category_group for storage
    cat_meta = {}

    req = urllib.request.Request(SESNSP_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        stream = io.TextIOWrapper(resp, encoding="latin-1")
        reader = csv.DictReader(stream)
        pvr_rows = 0
        for row in reader:
            if row.get("Municipio", "").strip().lower() != MUNICIPALITY.lower():
                continue
            if row.get("Entidad", "").strip().lower() != STATE.lower():
                continue
            pvr_rows += 1

            tipo = row.get("Tipo de delito", "").strip()
            mapping = CATEGORY_MAP.get(tipo)
            if not mapping:
                # Fuzzy match: check if any key is substring
                for key, val in CATEGORY_MAP.items():
                    if key.lower() in tipo.lower() or tipo.lower() in key.lower():
                        mapping = val
                        break
            if not mapping:
                cat_en, cat_es, cat_group = "Other", tipo, "other"
            else:
                cat_en, cat_es, cat_group = mapping

            year = int(row.get("Año", 0))
            if year < 2019:  # Only import from 2019 onwards to keep dataset manageable
                continue

            for m_idx, m_es in enumerate(MONTHS_ES):
                val = safe_int(row.get(m_es, 0))
                if val > 0:
                    month_num = m_idx + 1
                    key = (year, month_num, cat_en)
                    counts[key] += val
                    cat_meta[cat_en] = (cat_es, cat_group)

    print(f"Parsed {pvr_rows} Puerto Vallarta rows from SESNSP.")
    print(f"Unique (year, month, category) combinations: {len(counts)}")

    if not counts:
        print("ERROR: No data found for Puerto Vallarta — aborting.", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    # Append-only: only insert rows that don't already exist (year + month + category).
    # Historical validated data is never deleted or overwritten on re-run.
    inserted = 0
    skipped  = 0
    for (year, month_num, cat_en), count in sorted(counts.items()):
        cat_es, cat_group = cat_meta.get(cat_en, (cat_en, "other"))
        month_name = MONTHS_EN[month_num - 1]
        per_100k = round(count / PVR_POP * 100000, 2)

        # Calculate change vs prior year (if available)
        prior_key = (year - 1, month_num, cat_en)
        prior_count = counts.get(prior_key)
        change_pct = None
        if prior_count and prior_count > 0:
            change_pct = round((count - prior_count) / prior_count * 100, 2)

        cur.execute("""
            INSERT INTO safety_metrics
                (year, month, month_name, category, category_es, category_group,
                 incident_count, incidents_per_100k, change_vs_prior_year,
                 source, category_raw)
            SELECT %s,%s,%s,%s,%s,%s,%s,%s,%s,
                   'SESNSP – Incidencia Delictiva Municipal (real)', %s
            WHERE NOT EXISTS (
                SELECT 1 FROM safety_metrics
                WHERE year = %s AND month = %s AND category = %s
            )
        """, (year, month_num, month_name, cat_en, cat_es, cat_group,
              count, per_100k, change_pct, cat_es,
              year, month_num, cat_en))
        if cur.rowcount > 0:
            inserted += 1
        else:
            skipped += 1

    conn.commit()
    cur.close()
    conn.close()
    print(f"\nDone — {inserted} new rows inserted, {skipped} already-existing rows skipped.")

    # Print a quick summary
    print("\nSummary by year:")
    year_totals = collections.defaultdict(int)
    for (year, month_num, cat_en), count in counts.items():
        year_totals[year] += count
    for yr in sorted(year_totals):
        print(f"  {yr}: {year_totals[yr]:,} total incidents")

if __name__ == "__main__":
    main()
