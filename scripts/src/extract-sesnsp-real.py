#!/usr/bin/env python3
"""
extract-sesnsp-real.py
Downloads and processes the official SESNSP municipal crime data for Puerto Vallarta.

Source files downloaded from:
  https://www.gob.mx/sesnsp/documentos/historico-de-incidencia-delictiva-del-fuero-comun

Municipality: Puerto Vallarta (Cve. Municipio: 14067), Jalisco
"""

import openpyxl
import csv
import os
from collections import defaultdict

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'output')
os.makedirs(OUTPUT_DIR, exist_ok=True)

SESNSP_DIR = '/tmp/sesnsp'
POPULATION = 297383  # INEGI 2020 census

MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
             'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
MONTHS_EN = ['January','February','March','April','May','June',
             'July','August','September','October','November','December']

FILES = {
    2022: os.path.join(SESNSP_DIR, '2022.xlsx'),
    2023: os.path.join(SESNSP_DIR, '2023.xlsx'),
    2024: os.path.join(SESNSP_DIR, '2024.xlsx'),
    2025: os.path.join(SESNSP_DIR, '2025.xlsx'),
    2026: os.path.join(SESNSP_DIR, 'municipal_2026.xlsx'),
}

# ── Category mapping ──────────────────────────────────────────────────────────
# Maps (tipo_pattern, subtipo_pattern, modalidad_pattern) → normalized English label
# All matching is case-insensitive partial string match on the SESNSP raw fields.
# Order matters — first match wins.

CATEGORY_MAP = [
    # Violent crimes
    {
        'category':      'Homicide',
        'category_es':   'Homicidio Doloso',
        'category_group':'Violent Crime',
        'match_tipo':    'Homicidio',
        'match_subtipo': 'doloso',
        'match_modal':   None,
        'notes':         'Intentional homicides only (doloso). Culposo (negligent) excluded per SESNSP legal classification.',
        'raw':           'Homicidio doloso',
    },
    {
        'category':      'Femicide',
        'category_es':   'Feminicidio',
        'category_group':'Violent Crime',
        'match_tipo':    'Feminicidio',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Gender-motivated killings per NOM-046. Separate SESNSP category since 2019.',
        'raw':           'Feminicidio',
    },
    {
        'category':      'Extortion',
        'category_es':   'Extorsión',
        'category_group':'Violent Crime',
        'match_tipo':    'Extorsión',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Includes telephone extortion (cobro de piso) and in-person. Highly underreported.',
        'raw':           'Extorsión',
    },
    {
        'category':      'Kidnapping',
        'category_es':   'Secuestro',
        'category_group':'Violent Crime',
        'match_tipo':    'Secuestro',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Includes express kidnapping and extortive kidnapping. Rare in PV.',
        'raw':           'Secuestro',
    },
    {
        'category':      'Assault / Bodily Harm',
        'category_es':   'Lesiones Dolosas',
        'category_group':'Violent Crime',
        'match_tipo':    'Lesiones',
        'match_subtipo': 'dolosas',
        'match_modal':   None,
        'notes':         'Intentional bodily harm only. Traffic injuries (lesiones culposas) excluded.',
        'raw':           'Lesiones dolosas',
    },
    # Sexual crimes
    {
        'category':      'Rape',
        'category_es':   'Violación',
        'category_group':'Sexual Crime',
        'match_tipo':    'Violación',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Includes violación simple and violación equiparada. Reported cases only — significant underreporting.',
        'raw':           'Violación simple / Violación equiparada',
    },
    {
        'category':      'Sexual Abuse',
        'category_es':   'Abuso Sexual',
        'category_group':'Sexual Crime',
        'match_tipo':    'Abuso sexual',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Non-penetrative sexual offenses. Separate from rape per SESNSP classification.',
        'raw':           'Abuso sexual',
    },
    {
        'category':      'Sexual Harassment',
        'category_es':   'Acoso / Hostigamiento Sexual',
        'category_group':'Sexual Crime',
        'match_tipo':    'Acoso sexual',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Acoso sexual (workplace/public harassment). Includes hostigamiento sexual.',
        'raw':           'Acoso sexual / Hostigamiento sexual',
    },
    {
        'category':      'Other Sexual Crimes',
        'category_es':   'Otros Delitos Sexuales',
        'category_group':'Sexual Crime',
        'match_tipo':    'Otros delitos que atentan contra la libertad y la seguridad sexual',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Residual sexual offenses category per SESNSP classification.',
        'raw':           'Otros delitos que atentan contra la libertad y la seguridad sexual',
    },
    # Domestic / Social
    {
        'category':      'Domestic Violence',
        'category_es':   'Violencia Familiar',
        'category_group':'Domestic & Social',
        'match_tipo':    'Violencia familiar',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Most reported offense in PV. Includes physical and psychological violence within families.',
        'raw':           'Violencia familiar',
    },
    {
        'category':      'Threats',
        'category_es':   'Amenazas',
        'category_group':'Domestic & Social',
        'match_tipo':    'Amenazas',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Criminal threats. Includes in-person, written, and digital threats when formally reported.',
        'raw':           'Amenazas',
    },
    # Property crimes
    {
        'category':      'Burglary (Violent)',
        'category_es':   'Robo a Casa con Violencia',
        'category_group':'Property Crime',
        'match_tipo':    'Robo',
        'match_subtipo': 'casa habitación',
        'match_modal':   'Con violencia',
        'notes':         'Home break-ins with occupants present and threatened or harmed.',
        'raw':           'Robo a casa habitación con violencia',
    },
    {
        'category':      'Burglary (Non-Violent)',
        'category_es':   'Robo a Casa sin Violencia',
        'category_group':'Property Crime',
        'match_tipo':    'Robo',
        'match_subtipo': 'casa habitación',
        'match_modal':   'Sin violencia',
        'notes':         'Home break-ins when occupants absent. SESNSP classifies separately from violent burglary.',
        'raw':           'Robo a casa habitación sin violencia',
    },
    {
        'category':      'Vehicle Theft',
        'category_es':   'Robo de Vehículo',
        'category_group':'Property Crime',
        'match_tipo':    'Robo',
        'match_subtipo': 'vehículo automotor',
        'match_modal':   None,
        'notes':         'Includes cars, motorcycles, and trucks. Aggregated across all vehicle theft subtypes.',
        'raw':           'Robo de vehículo automotor (coches, motos)',
    },
    {
        'category':      'Street Robbery',
        'category_es':   'Robo a Transeúnte',
        'category_group':'Property Crime',
        'match_tipo':    'Robo',
        'match_subtipo': 'transeúnte',
        'match_modal':   None,
        'notes':         'Muggings in public spaces. Aggregated across violent and non-violent subcategories.',
        'raw':           'Robo a transeúnte en vía pública',
    },
    {
        'category':      'Business Robbery',
        'category_es':   'Robo a Negocio',
        'category_group':'Property Crime',
        'match_tipo':    'Robo',
        'match_subtipo': 'negocio',
        'match_modal':   None,
        'notes':         'Commercial establishment robberies including restaurants, stores, and hotels.',
        'raw':           'Robo a negocio',
    },
    {
        'category':      'Fraud',
        'category_es':   'Fraude',
        'category_group':'Property Crime',
        'match_tipo':    'Fraude',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Includes real estate fraud, rental scams, and digital fraud.',
        'raw':           'Fraude',
    },
    {
        'category':      'Property Damage',
        'category_es':   'Daño a la Propiedad',
        'category_group':'Property Crime',
        'match_tipo':    'Daño a la propiedad',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Criminal property damage (daño en propiedad ajena).',
        'raw':           'Daño a la propiedad',
    },
    {
        'category':      'Other Robbery',
        'category_es':   'Otros Robos',
        'category_group':'Property Crime',
        'match_tipo':    'Robo',
        'match_subtipo': 'Otros robos',
        'match_modal':   None,
        'notes':         'Catch-all SESNSP robbery subtype not classified into specific robbery categories.',
        'raw':           'Otros robos',
    },
    # Drug crimes (federal)
    {
        'category':      'Drug Dealing',
        'category_es':   'Narcomenudeo',
        'category_group':'Federal / Drug Crime',
        'match_tipo':    'Narcomenudeo',
        'match_subtipo': None,
        'match_modal':   None,
        'notes':         'Retail drug sales (fuero federal). Represents enforcement activity, not total prevalence.',
        'raw':           'Narcomenudeo',
    },
]

def matches(val, pattern):
    """Case-insensitive partial match, treating None pattern as wildcard."""
    if pattern is None:
        return True
    if val is None:
        return False
    return pattern.lower() in str(val).lower()

def classify(tipo, subtipo, modalidad):
    for cat in CATEGORY_MAP:
        if (matches(tipo, cat['match_tipo']) and
            matches(subtipo, cat['match_subtipo']) and
            matches(modalidad, cat['match_modal'])):
            return cat
    return None

# ── Extract all PV rows ───────────────────────────────────────────────────────
# Key: (year, month_idx, category) → total count
aggregated = defaultdict(int)
# Also track raw rows
raw_rows = []

unmatched_combos = defaultdict(int)

for year, path in FILES.items():
    if not os.path.exists(path):
        print(f"WARNING: Missing file {path}")
        continue
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            continue
        if not (row[4] and 'Puerto Vallarta' in str(row[4])):
            continue
        tipo     = str(row[6]) if row[6] else ''
        subtipo  = str(row[7]) if row[7] else ''
        modalidad = str(row[8]) if row[8] else ''
        cat = classify(tipo, subtipo, modalidad)
        monthly = row[9:21]  # Enero through Diciembre
        for m_idx, val in enumerate(monthly):
            count = int(val) if val is not None else 0
            if count == 0:
                continue
            raw_rows.append({
                'year': year,
                'month': m_idx + 1,
                'month_name': MONTHS_EN[m_idx],
                'date': f"{year}-{str(m_idx+1).zfill(2)}-01",
                'state': 'Jalisco',
                'municipality': 'Puerto Vallarta',
                'bien_juridico': str(row[5]) if row[5] else '',
                'offense_category_raw': subtipo,
                'offense_tipo': tipo,
                'offense_subtipo': subtipo,
                'offense_modalidad': modalidad,
                'offense_category_normalized': cat['category'] if cat else 'Uncategorized',
                'category_group': cat['category_group'] if cat else 'Other',
                'incident_count': count,
                'source': 'SESNSP – Incidencia Delictiva del Fuero Común (Municipal)',
                'source_url': 'https://www.gob.mx/sesnsp/documentos/historico-de-incidencia-delictiva-del-fuero-comun',
                'notes': cat['notes'] if cat else '',
            })
            if cat:
                aggregated[(year, m_idx + 1, cat['category'])] = aggregated[(year, m_idx + 1, cat['category'])] + count
            else:
                unmatched_combos[(tipo, subtipo, modalidad)] += count
    wb.close()
    print(f"  Processed {year}")

# ── Write safety_crime_raw.csv ────────────────────────────────────────────────
raw_headers = [
    'year','month','month_name','date','state','municipality',
    'bien_juridico','offense_tipo','offense_subtipo','offense_modalidad',
    'offense_category_normalized','category_group',
    'incident_count','source','source_url','notes',
]
with open(os.path.join(OUTPUT_DIR, 'safety_crime_raw.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=raw_headers, extrasaction='ignore')
    w.writeheader()
    w.writerows(raw_rows)
print(f"\n✓ safety_crime_raw.csv — {len(raw_rows)} rows")

# ── Build clean aggregated dataset ───────────────────────────────────────────
# aggregated: (year, month, category) → count
# Build prior-year lookup for YoY
clean_rows = []
for (year, month, category), count in sorted(aggregated.items()):
    prev = aggregated.get((year - 1, month, category), 0)
    yoy = f"{(((count - prev) / prev) * 100):.2f}" if prev > 0 else 'N/A'
    cat_def = next((c for c in CATEGORY_MAP if c['category'] == category), None)
    clean_rows.append({
        'year': year,
        'month': month,
        'month_name': MONTHS_EN[month - 1],
        'date': f"{year}-{str(month).zfill(2)}-01",
        'state': 'Jalisco',
        'municipality': 'Puerto Vallarta',
        'category': category,
        'category_es': cat_def['category_es'] if cat_def else '',
        'category_group': cat_def['category_group'] if cat_def else '',
        'category_raw': cat_def['raw'] if cat_def else '',
        'incident_count': count,
        'incidents_per_100k': f"{(count / POPULATION * 100000):.4f}",
        'change_vs_prior_year_pct': yoy,
        'source': 'SESNSP',
        'source_url': 'https://www.gob.mx/sesnsp/documentos/historico-de-incidencia-delictiva-del-fuero-comun',
    })

clean_headers = [
    'year','month','month_name','date','state','municipality',
    'category','category_es','category_group','category_raw',
    'incident_count','incidents_per_100k','change_vs_prior_year_pct',
    'source','source_url',
]
with open(os.path.join(OUTPUT_DIR, 'safety_crime_clean.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=clean_headers, extrasaction='ignore')
    w.writeheader()
    w.writerows(clean_rows)
print(f"✓ safety_crime_clean.csv — {len(clean_rows)} rows")

# ── Write category map ────────────────────────────────────────────────────────
map_headers = ['category_raw','category_normalized','category_es','category_group','notes']
with open(os.path.join(OUTPUT_DIR, 'safety_crime_category_map.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=map_headers)
    w.writeheader()
    for cat in CATEGORY_MAP:
        w.writerow({
            'category_raw':        cat['raw'],
            'category_normalized': cat['category'],
            'category_es':         cat['category_es'],
            'category_group':      cat['category_group'],
            'notes':               cat['notes'],
        })
print(f"✓ safety_crime_category_map.csv — {len(CATEGORY_MAP)} categories")

# ── Validation summary ────────────────────────────────────────────────────────
categories_found = sorted(set(c for (_, _, c) in aggregated.keys()))
years_found = sorted(set(y for (y, _, _) in aggregated.keys()))
total_incidents = sum(aggregated.values())
required = ['Homicide', 'Rape', 'Domestic Violence', 'Extortion', 'Femicide']
missing = [r for r in required if r not in categories_found]

print(f"\n── Validation ─────────────────────────────────────────────────────")
print(f"Data source: OFFICIAL SESNSP municipal Excel files (not estimated)")
print(f"Files processed: {list(FILES.keys())}")
print(f"Date range: {years_found[0]}-01 → {years_found[-1]}-xx")
print(f"Total incidents (all categories, all months): {total_incidents:,}")
print(f"Clean rows: {len(clean_rows)}")
print(f"Categories found ({len(categories_found)}):")
for cat in categories_found:
    cat_def = next((c for c in CATEGORY_MAP if c['category'] == cat), None)
    total = sum(aggregated[(y, m, cat)] for (y, m, c) in aggregated if c == cat)
    print(f"  • {cat:<35} [{cat_def['category_group'] if cat_def else '?'}]  total={total:,}")
print(f"\nUnmatched combos (not assigned to any category): {len(unmatched_combos)}")
if unmatched_combos:
    top_unmatched = sorted(unmatched_combos.items(), key=lambda x: -x[1])[:10]
    for (tipo, sub, modal), cnt in top_unmatched:
        print(f"  {cnt:>5}  {tipo} / {sub} / {modal}")
print(f"\nMissing required categories: {'None ✓' if not missing else ', '.join(missing)}")
print(f"\nMapping notes:")
print(f"  • Homicidio CULPOSO (negligent/traffic) excluded — separate legal classification")
print(f"  • Vehicle theft aggregated: coches 4 ruedas + motocicletas + other (all modalidades)")
print(f"  • Street robbery aggregated: con violencia + sin violencia")
print(f"  • Business robbery aggregated: con violencia + sin violencia")
print(f"  • Rape includes violación simple + violación equiparada")
print(f"  • All data is OFFICIAL SESNSP reported figures (not modeled/estimated)")
