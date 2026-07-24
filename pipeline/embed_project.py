"""Embed the Meaning Map corpus, compute find-similar neighbors, run the face-validity
spot-check, and (with --umap) project to 2D + write shippable artifacts.

Usage:
  python embed_project.py <model_id> <corpus.jsonl> <outdir> [--umap]
"""
import json, sys, os, time
import numpy as np

model_id = sys.argv[1]
corpus_path = sys.argv[2]
outdir = sys.argv[3]
do_umap = "--umap" in sys.argv
tag = model_id.split("/")[-1]
os.makedirs(outdir, exist_ok=True)
CACHE = os.environ.get("FASTEMBED_CACHE", r"C:\Users\dusti\.mmv\cache")

recs = [json.loads(l) for l in open(corpus_path, encoding="utf-8")]
texts = [r["embed_text"] for r in recs]
titles = [r["title"] for r in recs]
codes = [r["code"] for r in recs]
N = len(recs)

from fastembed import TextEmbedding
t0 = time.time()
model = TextEmbedding(model_name=model_id, cache_dir=CACHE)
emb = np.array(list(model.embed(texts, batch_size=32)), dtype="float32")
# normalize -> cosine == dot product
emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-12
enc_s = time.time() - t0
dim = emb.shape[1]
print(f"[{tag}] encoded {N} items -> dim {dim} in {enc_s:.1f}s")

# cosine kNN (normalized -> dot product); tiny matrix, brute force is fine
sim = emb @ emb.T
np.fill_diagonal(sim, -1.0)
K = 10
nn_idx = np.argpartition(-sim, K, axis=1)[:, :K]
# sort each row's K by sim desc
for i in range(N):
    order = np.argsort(-sim[i, nn_idx[i]])
    nn_idx[i] = nn_idx[i][order]

PROBES = ["Statisticians", "Business Intelligence Analysts", "Registered Nurses",
          "Electricians", "Kindergarten Teachers", "Software Developers", "Lawyers",
          "Accountants and Auditors", "Chefs and Head Cooks", "Graphic Designers",
          "Heavy and Tractor-Trailer Truck Drivers", "Police and Sheriff",
          "Farmers, Ranchers"]

def find(probe):
    for i, t in enumerate(titles):
        if probe.lower() in t.lower():
            return i
    return None

print(f"\n===== FACE-VALIDITY SPOT-CHECK  [{tag}] =====")
spot = {}
for p in PROBES:
    i = find(p)
    if i is None:
        print(f"\n[{p}] NOT FOUND"); continue
    nbrs = [(titles[j], round(float(sim[i, j]), 3)) for j in nn_idx[i]]
    spot[titles[i]] = nbrs
    print(f"\n{titles[i]}  ({codes[i]})")
    for t, s in nbrs:
        print(f"    {s:.3f}  {t}")

# persist neighbors + spot-check for this model
json.dump(spot, open(f"{outdir}/spotcheck_{tag}.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
np.save(f"{outdir}/emb_{tag}.npy", emb)

if do_umap:
    import umap
    print(f"\n[{tag}] running UMAP...")
    reducer = umap.UMAP(n_neighbors=15, min_dist=0.1, metric="cosine",
                        random_state=42, n_components=2)
    xy = reducer.fit_transform(emb)
    # normalize coords to [0,1] for a clean shipped file
    mn, mx = xy.min(0), xy.max(0)
    xy01 = (xy - mn) / (mx - mn)
    coords = []
    for i, r in enumerate(recs):
        coords.append({
            "code": r["code"], "title": r["title"],
            "short_description": r["short_description"],
            "major_group": r["major_group"], "major_group_code": r["major_group_code"],
            "job_zone": r["job_zone"],
            "x": round(float(xy01[i, 0]), 4), "y": round(float(xy01[i, 1]), 4),
        })
    json.dump(coords, open(f"{outdir}/coords.json", "w", encoding="utf-8"),
              ensure_ascii=False)
    # neighbors index: top-10 indices + rounded cosine per item (parallel to coords order)
    nbr_index = [{"i": i, "n": [int(j) for j in nn_idx[i]],
                  "s": [round(float(sim[i, j]), 3) for j in nn_idx[i]]}
                 for i in range(N)]
    json.dump(nbr_index, open(f"{outdir}/neighbors.json", "w", encoding="utf-8"))
    print(f"[{tag}] wrote coords.json ({os.path.getsize(outdir+'/coords.json')} B) "
          f"+ neighbors.json ({os.path.getsize(outdir+'/neighbors.json')} B)")

    # continent coherence: mean cosine of each item to same-major-group vs overall
    mg = np.array([r["major_group_code"] for r in recs])
    same = []
    for i in range(N):
        m = mg == mg[i]; m[i] = False
        if m.sum():
            same.append(sim[i, m].mean())
    print(f"[{tag}] mean intra-major-group cosine: {np.mean(same):.3f} "
          f"(overall mean off-diag: {sim[sim>-1].mean():.3f})")
