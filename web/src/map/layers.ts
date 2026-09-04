import { GeoJsonLayer } from "@deck.gl/layers";
import type { Feature, FeatureCollection } from "geojson";
import { shareColor } from "./color";
import type { MunicipioShare } from "../duckdb/queries";

const NEUTRAL_FILL: [number, number, number, number] = [214, 211, 204, 200];

export function buildMunicipioLayer(
  geojson: FeatureCollection,
  shares: Map<number, MunicipioShare> | null,
) {
  const maxShare = shares ? Math.max(0, ...[...shares.values()].map((s) => s.share ?? 0)) : 0;

  return new GeoJsonLayer({
    id: "municipios",
    data: geojson,
    stroked: true,
    filled: true,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 120],
    updateTriggers: {
      getFillColor: [shares, maxShare],
    },
    getFillColor: (f: Feature) => {
      if (!shares) return NEUTRAL_FILL;
      const cdMunicipioTse = f.properties?.cd_municipio_tse as number | undefined;
      const row = cdMunicipioTse != null ? shares.get(cdMunicipioTse) : undefined;
      const [r, g, b] = shareColor(row?.share, maxShare);
      return [r, g, b, 210];
    },
    getLineColor: [255, 255, 255, 220],
    lineWidthMinPixels: 0.5,
  });
}
