import { defineConfig } from 'astro/config';

// Fully static, no adapter, zero framework integrations (dustincoledata sibling
// pattern — Real Price / Namesake). Interactivity is one plain client-side TS
// <script> module (src/scripts/map.ts) bundled by Vite. Data (coords/neighbors)
// is import-inlined into that bundle at build time — no runtime fetch, ever.
export default defineConfig({
  site: 'https://meaningmap.dustincoledata.com',
  base: '/',
  output: 'static',
  trailingSlash: 'ignore',
});
