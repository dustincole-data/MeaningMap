"""Verify the shipped artifacts against the frozen embeddings (Phase-1 acceptance).

No re-projection (UMAP output is version-sensitive; coords.json is the locked
artifact). Instead we check the two things that MUST hold on the committed data:

  1. neighbors.json == exact top-10 cosine neighbors recomputed from emb_*.npy
     (find-similar is a pure lookup; it must match the embeddings byte-for-byte).
  2. trustworthiness(emb, coords_xy, k=10) >= 0.90 — the 2D projection preserves
     real high-dim neighborhoods, so find-similar survives the projection.
     (Spec reports 0.956; we recompute it here rather than trust the number.)

trustworthiness is implemented in numpy (no sklearn dependency).

Run: python pipeline/verify.py
"""
import json
import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIPE = ROOT / "pipeline"
DATA = ROOT / "src" / "data"


def trustworthiness(emb, xy, k=10):
    """Fraction-based Venna & Kaski trustworthiness, numpy-only. N=893 -> O(N^2) fine."""
    n = emb.shape[0]
    # high-dim rank of every point from every point (0 = self)
    D_hi = -(emb @ emb.T)                         # emb normalized -> -cosine as distance
    rank_hi = np.argsort(np.argsort(D_hi, axis=1), axis=1)
    # low-dim k nearest neighbors
    d2 = ((xy[:, None, :] - xy[None, :, :]) ** 2).sum(-1)
    np.fill_diagonal(d2, np.inf)
    nn_lo = np.argsort(d2, axis=1)[:, :k]
    # high-dim k nearest set (exclude self)
    hi_order = np.argsort(D_hi, axis=1)
    hi_knn = [set(hi_order[i, 1:k + 1]) for i in range(n)]
    total = 0.0
    for i in range(n):
        for j in nn_lo[i]:
            if j not in hi_knn[i]:
                total += (rank_hi[i, j] - k)       # rank penalty for intruders
    norm = 2.0 / (n * k * (2 * n - 3 * k - 1))
    return 1.0 - norm * total


def main():
    emb = np.load(PIPE / "emb_bge-small-en-v1.5.npy")
    coords = json.load(open(DATA / "coords.json", encoding="utf-8"))
    nbr = json.load(open(DATA / "neighbors.json", encoding="utf-8"))
    n = emb.shape[0]
    assert len(coords) == n == 893, f"length mismatch: emb {n}, coords {len(coords)}"
    assert len(nbr) == n, "neighbors length mismatch"

    # 1. neighbors integrity: recompute top-10 cosine from emb, compare to shipped
    sim = emb @ emb.T
    np.fill_diagonal(sim, -1.0)
    K = 10
    idx = np.argpartition(-sim, K, axis=1)[:, :K]
    for i in range(n):
        idx[i] = idx[i][np.argsort(-sim[i, idx[i]])]
    mismatches = sum(1 for i in range(n) if list(idx[i]) != nbr[i]["n"])
    print(f"neighbors recomputed from embeddings: "
          f"{n - mismatches}/{n} rows match exactly ({mismatches} mismatches)")

    # 2. trustworthiness of the committed coords
    xy = np.array([[c["x"], c["y"]] for c in coords], dtype="float64")
    tw = trustworthiness(emb, xy, k=10)
    print(f"trustworthiness(emb, coords_xy, k=10) = {tw:.3f}  (gate >= 0.90)")

    # 3. embedding-text-never-includes-title acceptance: spot-check a word-collision pair
    #    (bge-small was chosen because it does NOT collapse "Business Intelligence
    #    Analysts" -> "Intelligence Analysts" on title spelling). Report the top neighbor.
    title_of = [c["title"] for c in coords]
    def top1(sub):
        i = next(k for k, t in enumerate(title_of) if sub in t)
        return title_of[i], title_of[nbr[i]["n"][0]], nbr[i]["s"][0]
    for probe in ("Business Intelligence Analysts", "Registered Nurses", "Statisticians"):
        t, n1, s = top1(probe)
        print(f"  {t}  ->  #1 {n1} ({s})")

    ok = (mismatches == 0) and (tw >= 0.90)
    print("OK" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
