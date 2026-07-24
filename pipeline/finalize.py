"""Finalize the Meaning Map pipeline on the chosen embeddings:
  - reuse saved bge-small embeddings (no re-embed)
  - top-10 find-similar index
  - UMAP param sweep -> pick most-legible continents (silhouette) preserving local structure (trustworthiness)
  - write shippable coords.json + neighbors.json for the winner
  - write a rough diagnostic preview.html (colored scatter) to confirm continents read
"""
import json, os, sys
import numpy as np
from sklearn.metrics import silhouette_score
from sklearn.manifold import trustworthiness
import umap

OUT = sys.argv[1]
recs = [json.loads(l) for l in open(f"{OUT}/corpus.jsonl", encoding="utf-8")]
emb = np.load(f"{OUT}/emb_bge-small-en-v1.5.npy")
N = len(recs)
titles = [r["title"] for r in recs]
mg = np.array([r["major_group_code"] for r in recs])

# find-similar index (top-10 cosine; emb already normalized)
sim = emb @ emb.T
np.fill_diagonal(sim, -1.0)
K = 10
nn_idx = np.argpartition(-sim, K, axis=1)[:, :K]
for i in range(N):
    nn_idx[i] = nn_idx[i][np.argsort(-sim[i, nn_idx[i]])]

SWEEP = [
    dict(n_neighbors=15, min_dist=0.10),
    dict(n_neighbors=30, min_dist=0.15),
    dict(n_neighbors=50, min_dist=0.25),
]
results = []
for p in SWEEP:
    reducer = umap.UMAP(metric="cosine", random_state=42, n_components=2, **p)
    xy = reducer.fit_transform(emb)
    sil = silhouette_score(xy, mg)                    # continent separation (higher=better)
    tw = trustworthiness(emb, xy, n_neighbors=10)     # local structure kept (higher=better)
    results.append((p, xy, sil, tw))
    print(f"n_neighbors={p['n_neighbors']:>2} min_dist={p['min_dist']:.2f} "
          f"-> silhouette(major-group)={sil:.3f}  trustworthiness={tw:.3f}")

# pick: best silhouette among those within 0.01 trustworthiness of the max
tw_max = max(r[3] for r in results)
elig = [r for r in results if r[3] >= tw_max - 0.01] or results
best = max(elig, key=lambda r: r[2])
p, xy, sil, tw = best
print(f"\nCHOSEN: n_neighbors={p['n_neighbors']} min_dist={p['min_dist']} "
      f"(silhouette={sil:.3f}, trustworthiness={tw:.3f})")

# normalize coords to [0,1]
mn, mx = xy.min(0), xy.max(0)
xy01 = (xy - mn) / (mx - mn)
coords = [{
    "code": r["code"], "title": r["title"], "short_description": r["short_description"],
    "major_group": r["major_group"], "major_group_code": r["major_group_code"],
    "job_zone": r["job_zone"],
    "x": round(float(xy01[i, 0]), 4), "y": round(float(xy01[i, 1]), 4),
} for i, r in enumerate(recs)]
json.dump(coords, open(f"{OUT}/coords.json", "w", encoding="utf-8"), ensure_ascii=False)

nbr_index = [{"n": [int(j) for j in nn_idx[i]],
              "s": [round(float(sim[i, j]), 3) for j in nn_idx[i]]} for i in range(N)]
json.dump(nbr_index, open(f"{OUT}/neighbors.json", "w", encoding="utf-8"))

cs = os.path.getsize(f"{OUT}/coords.json"); ns = os.path.getsize(f"{OUT}/neighbors.json")
print(f"coords.json {cs} B ({cs/1024:.1f} KB) | neighbors.json {ns} B ({ns/1024:.1f} KB)")

# per-major-group spatial coherence: mean 2D-kNN(10) same-group fraction
from sklearn.neighbors import NearestNeighbors
nn2d = NearestNeighbors(n_neighbors=11).fit(xy01)
_, idx2d = nn2d.kneighbors(xy01)
agree = np.mean([(mg[idx2d[i, 1:]] == mg[i]).mean() for i in range(N)])
print(f"2D 10-NN same-major-group fraction: {agree:.3f}")

# rough diagnostic preview (self-contained SVG scatter, colored by major group)
GROUPS = sorted(set(r["major_group"] for r in recs))
PAL = ["#4e79a7","#f28e2b","#e15759","#76b7b2","#59a14f","#edc948","#b07aa1","#ff9da7",
       "#9c755f","#bab0ac","#1b9e77","#d95f02","#7570b3","#e7298a","#66a61e","#e6ab02",
       "#a6761d","#666666","#1f78b4","#33a02c","#fb9a99","#6a3d9a"]
cmap = {g: PAL[i % len(PAL)] for i, g in enumerate(GROUPS)}
W = H = 900; R = 3.2
def sx(x): return 30 + x * (W - 60)
def sy(y): return 30 + (1 - y) * (H - 60)
dots = "".join(
    f'<circle cx="{sx(c["x"]):.1f}" cy="{sy(c["y"]):.1f}" r="{R}" fill="{cmap[c["major_group"]]}" '
    f'fill-opacity="0.85"><title>{c["title"]} — {c["major_group"]}</title></circle>'
    for c in coords)
legend = "".join(
    f'<div><span style="background:{cmap[g]}"></span>{g}</div>' for g in GROUPS)
html = f"""<!doctype html><meta charset=utf-8><title>Meaning Map — rough projection preview (02 diagnostic)</title>
<style>body{{font:13px/1.4 system-ui;margin:20px;color:#222}}h1{{font-size:16px}}
.wrap{{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}}
#lg div{{display:flex;align-items:center;gap:6px;margin:2px 0}}#lg span{{width:12px;height:12px;border-radius:2px;display:inline-block}}
svg{{border:1px solid #ddd;background:#fafafa}}</style>
<h1>Meaning Map — rough projection preview (ticket 02 diagnostic, NOT the 04 hero)</h1>
<p>{N} occupations · bge-small-en-v1.5 · UMAP n_neighbors={p['n_neighbors']} min_dist={p['min_dist']} · colored by SOC major group · hover a dot for the title. Confirms continents read; the designed map is 04's job.</p>
<div class=wrap><svg width="{W}" height="{H}">{dots}</svg><div id=lg>{legend}</div></div>"""
open(f"{OUT}/preview.html", "w", encoding="utf-8").write(html)
print(f"preview.html written ({os.path.getsize(OUT+'/preview.html')/1024:.0f} KB)")
