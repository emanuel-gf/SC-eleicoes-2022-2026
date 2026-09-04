import type { StyleSpecification } from "maplibre-gl";

// Todos gratuitos, sem API key -- nenhum é Mapbox. OpenFreeMap é MapLibre-first
// (mesmo mantenedor por trás do MapLibre); o raster do OSM entra como fallback
// clássico com um style mínimo próprio (MapLibre também renderiza raster).
export interface BasemapOption {
  id: string;
  label: string;
  style: string | StyleSpecification;
}

const OSM_RASTER_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

export const BASEMAPS: BasemapOption[] = [
  { id: "liberty", label: "OpenFreeMap Liberty", style: "https://tiles.openfreemap.org/styles/liberty" },
  { id: "positron", label: "OpenFreeMap Positron (claro)", style: "https://tiles.openfreemap.org/styles/positron" },
  { id: "bright", label: "OpenFreeMap Bright", style: "https://tiles.openfreemap.org/styles/bright" },
  { id: "osm", label: "OpenStreetMap (raster)", style: OSM_RASTER_STYLE },
];

export const DEFAULT_BASEMAP = BASEMAPS[1]; // positron: neutro, não briga com a cor do choropleth
