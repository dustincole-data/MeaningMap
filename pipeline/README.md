# Pipeline — how the shipped data is baked (run locally, commit the output)

The site ships two committed artifacts and does **zero** data work at deploy time:

- `src/data/coords.json` — 893 occupations: `code, title, short_description,
  major_group(+code), job_zone, x, y, rx, ry, employment, median_wage, wage_capped, wage_level`.
  `rx`/`ry` are `x`/`y` after collision relaxation (world-space, de-overlapped) — baked by
  `relax.mjs` so the browser doesn't run 70 iterations on every load.
- `src/data/neighbors.json` — parallel array `{n:[top-10 indices], s:[cosine scores]}`

Everything below runs **once, locally, on a residential IP**, and the results are
committed. This is a data-acquisition constraint, not a compute one: **BLS.gov
403-blocks datacenter IPs** (Vercel / GitHub Actions runners), so the OEWS join
cannot run in CI. Rebake is manual and occasional (annual OEWS release at most).

## Provenance & order
All artifacts are **parallel by index**: `coords[i]`, `neighbors[i]`, and
`emb_bge-small-en-v1.5.npy[i]` describe the same occupation. Order is fixed by
`corpus.jsonl` (build order).

## Steps

1. **`build_corpus.py`** — O*NET 30.3 (CC BY 4.0) → `corpus.jsonl`. Each occupation's
   `embed_text` = Description → Core Tasks → top-10 Skills → top-10 Knowledge → top-10
   Work Activities. **The title is never embedded** (keeps the map semantic, not
   spelling-driven — the standing acceptance criterion). Needs the raw O*NET DB text
   files locally; `corpus.jsonl` is gitignored (large, regeneratable).

2. **`embed_project.py bge-small-en-v1.5 corpus.jsonl . --umap`** — embeds with
   `BAAI/bge-small-en-v1.5` (384-dim) via **fastembed** (ONNX, no PyTorch → avoids the
   Windows MAX_PATH break). Writes `emb_bge-small-en-v1.5.npy` (committed — the verify
   anchor) + the top-10 cosine index. (Re-embedding requires `pip install fastembed`.)

3. **`finalize.py .`** — UMAP `metric=cosine, n_neighbors=15, min_dist=0.10,
   random_state=42` → 2D coords normalized to [0,1]; writes the base `coords.json` +
   `neighbors.json`. (The committed `coords.base.json` is this output — UMAP is
   version-sensitive, so we reuse it rather than re-project.)

4. **`join_bls.py`** ← run this to (re)bake the shipped data. Downloads BLS OEWS May-2024
   national (`oesm24nat.zip`, residential IP), joins `TOT_EMP` + `A_MEDIAN` onto each
   occupation at 6-digit SOC (rolling up to broad/minor when O*NET-SOC is finer than
   OEWS), and writes `src/data/coords.json` + `src/data/neighbors.json`. `wage_level`
   records the join resolution; siblings under one SOC share a figure (UI footnote:
   "reported at the broader occupational group level"). ~4 occupations have no published
   annual wage (per-gig performers, one rare code) → shown as "not reported".
   **This overwrites `rx`/`ry` too** — always run `relax.mjs` (step 4b) right after.

4b. **`relax.mjs`** — precomputes the collision relaxation (de-overlap dots while holding
   projection structure: 70-iteration grid-based repulsion, `R=14 maxDisp=46`) that used to
   run in the browser on every load (~1.4s of the ~1.75s blocking startup) and writes the
   result into `src/data/coords.json` as `rx`/`ry`. The algorithm is copied verbatim from
   `map.ts`'s old `relax()` — keep them in sync if the params ever change. Run with plain
   `node` (not Python): Node and the browser are both V8, so running the identical algorithm
   there reproduces the runtime output exactly, rather than risking drift from a re-implementation.

5. **`verify.py`** — acceptance gate on the committed data (no re-projection):
   - `neighbors.json` matches the exact top-10 cosine recomputed from the embeddings
     (find-similar is faithful to the model);
   - `trustworthiness(emb, coords_xy, k=10) ≥ 0.90` (measured **0.957** — 2D preserves
     real high-dim neighborhoods, so find-similar survives the projection).

## Regenerate the shipped data
```
python pipeline/join_bls.py     # re-downloads OEWS if pipeline/raw/ is empty
node pipeline/relax.mjs          # re-bakes rx/ry (join_bls.py overwrites them)
python pipeline/verify.py        # must print OK
```

`measure_family.py` is a diagnostic for the 22-SOC → 10-super-family binning (§3 of the
spec) — not part of the ship path.

## Sources
- Occupation data: **O*NET 30.3** (US DOL/ETA, CC BY 4.0)
- Wage & employment: **BLS OEWS** May 2024 national (public domain)
