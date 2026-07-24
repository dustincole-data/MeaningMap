"""Quantify the speckle risk 03 flagged: how well do embedding/UMAP clusters align
with occupation FAMILY, at both 22-SOC-group and ~9-super-family granularity?
Uses coords.json (already written). Writes preview.html with a 9-super-family view.
"""
import json, sys
import numpy as np
from sklearn.metrics import silhouette_score
from sklearn.neighbors import NearestNeighbors

OUT = sys.argv[1]
coords = json.load(open(f"{OUT}/coords.json", encoding="utf-8"))
N = len(coords)
xy = np.array([[c["x"], c["y"]] for c in coords])
mg = np.array([c["major_group_code"] for c in coords])

# candidate ~9 super-families (04 owns the final bin; this is to MEASURE the encoding 03 chose)
SUPER = {
    "11": "Management & Business", "13": "Management & Business",
    "15": "Computing, Engineering & Science", "17": "Computing, Engineering & Science",
    "19": "Computing, Engineering & Science",
    "21": "Education, Legal & Community", "23": "Education, Legal & Community",
    "25": "Education, Legal & Community",
    "27": "Arts & Media",
    "29": "Healthcare", "31": "Healthcare",
    "33": "Service (protective/food/care)", "35": "Service (protective/food/care)",
    "37": "Service (protective/food/care)", "39": "Service (protective/food/care)",
    "41": "Sales & Office", "43": "Sales & Office",
    "45": "Trades, Production & Resources", "47": "Trades, Production & Resources",
    "49": "Trades, Production & Resources", "51": "Trades, Production & Resources",
    "53": "Transportation",
}
sf = np.array([SUPER.get(m, "Other") for m in mg])

nn = NearestNeighbors(n_neighbors=11).fit(xy)
_, idx = nn.kneighbors(xy)
nbrs = idx[:, 1:]

def same_frac(labels):
    return np.mean([(labels[nbrs[i]] == labels[i]).mean() for i in range(N)])

def chance(labels):  # random same-label baseline = sum p_k^2
    _, c = np.unique(labels, return_counts=True)
    return ((c / N) ** 2).sum()

print(f"22 SOC groups : silhouette={silhouette_score(xy, mg):+.3f}  "
      f"2D-10NN same-family={same_frac(mg):.3f}  (chance≈{chance(mg):.3f})")
print(f" 9 super-fam : silhouette={silhouette_score(xy, sf):+.3f}  "
      f"2D-10NN same-superfamily={same_frac(sf):.3f}  (chance≈{chance(sf):.3f})")

# per-SOC-family coherence: mean same-family fraction, ranked (what reads vs what speckles)
NAME = {c["major_group_code"]: c["major_group"] for c in coords}
rows = []
for m in sorted(set(mg)):
    mask = mg == m
    frac = np.mean([(mg[nbrs[i]] == m).mean() for i in np.where(mask)[0]])
    rows.append((frac, int(mask.sum()), NAME[m]))
rows.sort(reverse=True)
print("\nPer-family spatial coherence (mean same-family fraction among its members' 2D 10-NN):")
print("  COHERES (reads as a continent):")
for frac, n, name in rows:
    if frac >= 0.45:
        print(f"    {frac:.2f}  ({n:>3})  {name}")
print("  SPECKLES (interleaves with other families):")
for frac, n, name in rows:
    if frac < 0.45:
        print(f"    {frac:.2f}  ({n:>3})  {name}")

# regenerate preview.html colored by 9 super-families (the actual chosen encoding gestalt)
GROUPS = sorted(set(sf))
PAL = ["#4e79a7","#f28e2b","#e15759","#76b7b2","#59a14f","#edc948","#b07aa1","#9c755f","#af7aa1"]
cmap = {g: PAL[i % len(PAL)] for i, g in enumerate(GROUPS)}
W = H = 950; R = 3.4
def sx(x): return 30 + x*(W-60)
def sy(y): return 30 + (1-y)*(H-60)
dots = "".join(
    f'<circle cx="{sx(c["x"]):.1f}" cy="{sy(c["y"]):.1f}" r="{R}" fill="{cmap[sf[i]]}" '
    f'fill-opacity="0.85"><title>{c["title"]} — {c["major_group"]}</title></circle>'
    for i, c in enumerate(coords))
legend = "".join(f'<div><span style="background:{cmap[g]}"></span>{g}</div>' for g in GROUPS)
html = f"""<!doctype html><meta charset=utf-8><title>Meaning Map — projection preview (02 diagnostic, 9 super-families)</title>
<style>body{{font:13px/1.4 system-ui;margin:20px;color:#222}}h1{{font-size:16px}}
.wrap{{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}}
#lg div{{display:flex;align-items:center;gap:6px;margin:3px 0}}#lg span{{width:14px;height:14px;border-radius:2px;display:inline-block}}
svg{{border:1px solid #ddd;background:#faf8f4}}</style>
<h1>Meaning Map — rough projection preview (ticket 02 diagnostic — NOT the 04 hero)</h1>
<p>{N} occupations · bge-small-en-v1.5 · UMAP n_neighbors=15 min_dist=0.1 · colored by ~9 <b>super-families</b> · hover for title+SOC group.<br>
Confirms whether family-colored continents read (the speckle test). The designed atlas is 04's job.</p>
<div class=wrap><svg width="{W}" height="{H}">{dots}</svg><div id=lg><b>Super-family</b>{legend}</div></div>"""
open(f"{OUT}/preview.html", "w", encoding="utf-8").write(html)
print(f"\npreview.html regenerated (9 super-families)")
