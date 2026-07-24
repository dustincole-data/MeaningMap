"""Join BLS OEWS national wage & employment onto the locked projection.

Reads the committed projection (coords.base.json — code/title/x/y/... from the
bge-small + UMAP pipeline) and the BLS OEWS May-2024 national file, and writes
the SHIPPED src/data/coords.json with `employment`, `median_wage`, `wage_capped`
and `wage_level` added per occupation. Also copies neighbors.json into src/data/.

Why this runs LOCALLY (residential IP), not in CI: BLS.gov 403-blocks datacenter
IPs (Vercel / GitHub Actions runners), so the OEWS fetch cannot run in a hosted
build. Output is committed; the Vercel build does zero fetching. See pipeline/README.

SOC-resolution caveat (spec §1): OEWS reports at 6-digit SOC (867 codes), coarser
than O*NET-SOC (893 occupations). O*NET siblings under one SOC share a figure, and
24 O*NET codes have no OEWS `detailed` row (SOC-vintage drift) — those roll up to
the OEWS `broad`/`minor` aggregate. `wage_level` records which resolution was used;
the UI footnote says figures are "reported at the broader occupational group level".

Run: python pipeline/join_bls.py
"""
import json, os, sys, zipfile, io, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIPE = ROOT / "pipeline"
RAW = PIPE / "raw"
OEWS_URL = "https://www.bls.gov/oes/special-requests/oesm24nat.zip"
XLSX = RAW / "oesm24nat" / "national_M2024_dl.xlsx"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.bls.gov/oes/tables.htm",
    "Upgrade-Insecure-Requests": "1",
}


def ensure_oews():
    """Download+extract the OEWS national file if not already present (residential IP)."""
    if XLSX.exists():
        print(f"OEWS present: {XLSX.relative_to(ROOT)}")
        return
    RAW.mkdir(parents=True, exist_ok=True)
    print(f"downloading {OEWS_URL} (residential IP required — BLS blocks datacenter IPs)...")
    req = urllib.request.Request(OEWS_URL, headers=HEADERS)
    data = urllib.request.urlopen(req, timeout=120).read()
    (RAW / "oesm24nat.zip").write_bytes(data)
    zipfile.ZipFile(io.BytesIO(data)).extractall(RAW)
    print(f"  extracted -> {XLSX.relative_to(ROOT)} ({len(data)/1024:.0f} KB zip)")


def num(v):
    """OEWS numeric or None. '*'/'**'/'~'/'' = suppressed/not-released."""
    if v is None:
        return None
    s = str(v).strip().replace(",", "")
    if s in ("", "*", "**", "~", "nan"):
        return None
    if s == "#":  # top-coded: wage >= $115.00/hr or $239,200/yr
        return 239200
    try:
        return int(round(float(s)))
    except ValueError:
        return None


def main():
    import pandas as pd
    ensure_oews()
    df = pd.read_excel(XLSX, dtype=str)
    # per-aggregation-level lookups keyed by OCC_CODE (6-digit SOC "11-1011")
    lvl = {}
    for g in ("detailed", "broad", "minor"):
        sub = df[df["O_GROUP"] == g]
        lvl[g] = {r["OCC_CODE"]: r for _, r in sub.iterrows()}

    def find_code(code):
        """Return (level, row) for an exact OCC_CODE at whatever level it exists."""
        for g in ("detailed", "broad", "minor"):
            if code in lvl[g]:
                return g, lvl[g][code]
        return None, None

    def resolve(soc6):
        """Best OEWS row for an O*NET soc6: exact code, else roll the last digits up.
        Each candidate is looked up at every level (some merged codes like 31-1120,
        the Home Health & Personal Care Aides merge, are published as `detailed`)."""
        # SOC is "XX-YYYY" (hyphen at index 2): broad zeros the last digit
        # (soc6[:6]+"0"), minor zeros the last two (soc6[:5]+"00").
        for cand in (soc6, soc6[:6] + "0", soc6[:5] + "00"):
            level, row = find_code(cand)
            if row is not None:
                # exact detailed match keeps its own resolution; rollups are "broad"
                return ("detailed" if cand == soc6 and level == "detailed" else level), row
        return None, None

    coords = json.load(open(PIPE / "coords.base.json", encoding="utf-8"))
    stats = {"detailed": 0, "broad": 0, "minor": 0, None: 0}
    n_wage = n_emp = n_capped = 0
    for d in coords:
        soc6 = d["code"].split(".")[0]
        level, row = resolve(soc6)
        stats[level] = stats.get(level, 0) + 1
        emp = num(row["TOT_EMP"]) if row is not None else None
        wage = num(row["A_MEDIAN"]) if row is not None else None
        capped = bool(row is not None and str(row["A_MEDIAN"]).strip() == "#")
        d["employment"] = emp
        d["median_wage"] = wage
        d["wage_capped"] = capped
        d["wage_level"] = level  # detailed | broad | minor | null
        n_emp += emp is not None
        n_wage += wage is not None
        n_capped += capped

    out_dir = ROOT / "src" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    json.dump(coords, open(out_dir / "coords.json", "w", encoding="utf-8"), ensure_ascii=False)
    # neighbors is projection-independent (pure cosine top-10) — copy through unchanged
    nbr = json.load(open(PIPE / "neighbors.json", encoding="utf-8"))
    json.dump(nbr, open(out_dir / "neighbors.json", "w", encoding="utf-8"))

    cs = (out_dir / "coords.json").stat().st_size
    ns = (out_dir / "neighbors.json").stat().st_size
    print(f"\nwrote src/data/coords.json  ({cs/1024:.0f} KB, {len(coords)} occupations)")
    print(f"wrote src/data/neighbors.json ({ns/1024:.0f} KB, {len(nbr)} rows)")
    print(f"wage resolution: {stats}")
    print(f"employment present: {n_emp}/{len(coords)} | "
          f"median_wage present: {n_wage}/{len(coords)} | top-coded (#): {n_capped}")
    assert len(coords) == 893, f"expected 893 occupations, got {len(coords)}"
    assert len(nbr) == len(coords), "neighbors/coords length mismatch"
    print("OK")


if __name__ == "__main__":
    main()
