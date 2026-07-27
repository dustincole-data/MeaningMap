# Meaning Map

A crafted, readable atlas of **893 US occupations** placed by what the work actually
involves — similar jobs sit near each other, coloured by occupation family. Click any
job to find the ones most like it. Live: **meaningmap.dustincoledata.com**

Real O*NET + BLS data, **browser-side, no server, no model shipped, zero runtime
compute.** "Find similar" is a lookup against a precomputed nearest-neighbour index,
not live inference — the embeddings are baked at build-prep time and never shipped.

## How it works

- **Corpus** — 893 O*NET-SOC 2019 occupations (v30.3, CC BY 4.0) with a full descriptor
  set. Each is embedded from *what the job involves* (Description → Core Tasks → top-10
  Skills / Knowledge / Work Activities) — **never the title**, so neighbours are semantic,
  not spelling collisions.
- **Embeddings** — `BAAI/bge-small-en-v1.5` (384-dim, via fastembed / ONNX). Top-10 cosine
  neighbours precomputed per occupation.
- **Projection** — UMAP (cosine, n_neighbors=15, min_dist=0.10) to 2D. Trustworthiness
  **0.957** — the 2D layout preserves real high-dim neighbourhoods, so find-similar
  survives the projection.
- **Wage & employment** — BLS OEWS May 2024 national, joined at 6-digit SOC. OEWS is
  coarser than O*NET-SOC, so siblings under one SOC share a figure ("reported at the
  broader occupational group level").
- **Render** — HTML5 Canvas (KDE density continents + territory-clipped marching-squares
  coastlines + luminous marks) with HTML overlays for crisp text. Collision-relaxed layout,
  strict label level-of-detail, pinch/drag on touch.

## Develop

```
npm install
npm run dev        # http://localhost:4321
npm run build      # -> dist/  (hermetic: uses committed src/data, no fetch)
npm run preview
```

Shipped data lives in `src/data/{coords,neighbors}.json` and is **committed** — the Vercel
build does zero fetching or compute. Fonts are self-hosted (`npm run fonts`); the OG/social
image is `public/og/cover.png`.

## Checks

Two Playwright scripts drive a real browser (installed Edge — `playwright-core` downloads
nothing) against a running dev server, at 390×844 touch **and** 1440×900:

```
npm run dev                        # in one terminal
npm run check                      # 58 assertions: chrome, sheet, touch two-stage, brand mark, key
npm run check:sim                  # 41 assertions: leader + bar similarity encodings
npm run check:all
MM_URL=http://127.0.0.1:4322/ npm run check     # if dev picked another port
```

`check:sim` measures the encodings as **rendered** — ink sampled from a screenshot along each
leader, bar widths read off the boxes — not the formula. Both encodings have shipped in a state
where the formula was right and the picture was unreadable, and no assertion over the source can
tell "faint but correct" from "noise". Screenshots land in `tests/.artifacts/` (git-ignored).

## Rebake the data (occasional, local only)

The BLS OEWS join must run on a **residential IP** — BLS.gov 403-blocks datacenter IPs
(Vercel / CI), so it can't run in a hosted build. See [`pipeline/README.md`](pipeline/README.md).

```
python pipeline/join_bls.py     # re-downloads OEWS, rewrites src/data/*.json
python pipeline/verify.py        # gate: neighbours match embeddings, trustworthiness >= 0.90
```

## Stack

Astro 5 (static, no adapter) · vanilla TS canvas engine · Vercel static hosting. Data:
O*NET 30.3 (US DOL/ETA, CC BY 4.0) · BLS OEWS (public domain).
