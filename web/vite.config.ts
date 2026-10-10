import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serve o site em /<nome-do-repo>/ -- o workflow de deploy
  // passa BASE_PATH. Local (dev/preview) continua na raiz.
  base: process.env.BASE_PATH ?? '/',
  optimizeDeps: {
    // maplibre-gl v6 carrega o worker como arquivo irmão
    // (`new URL('./maplibre-gl-worker.mjs', import.meta.url)`). O pré-bundle
    // do Vite move o maplibre pra node_modules/.vite/deps/ sem levar o worker
    // junto -> 404 no worker e o basemap vetorial não renderiza.
    exclude: ['maplibre-gl'],
  },
})
