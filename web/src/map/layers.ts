import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Feature, FeatureCollection } from "geojson";
import { shareColor } from "./color";
import type { MesorregiaoShare, MunicipioShare, SecaoShare } from "../duckdb/queries";

const NEUTRAL_FILL: [number, number, number, number] = [214, 211, 204, 200];

interface ShareRow {
  share: number | null;
}

function maxShareOf(shares: Map<number, ShareRow> | null): number {
  return shares ? Math.max(0, ...[...shares.values()].map((s) => s.share ?? 0)) : 0;
}

function buildChoroplethLayer(
  id: string,
  geojson: FeatureCollection,
  joinProperty: string,
  shares: Map<number, ShareRow> | null,
) {
  const maxShare = maxShareOf(shares);

  return new GeoJsonLayer({
    id,
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
      const key = f.properties?.[joinProperty] as number | undefined;
      const row = key != null ? shares.get(key) : undefined;
      const [r, g, b] = shareColor(row?.share, maxShare);
      return [r, g, b, 210];
    },
    getLineColor: [255, 255, 255, 220],
    lineWidthMinPixels: 0.5,
  });
}

export function buildMesorregiaoLayer(
  geojson: FeatureCollection,
  shares: Map<number, MesorregiaoShare> | null,
) {
  return buildChoroplethLayer("mesorregioes", geojson, "cd_mesorregiao", shares);
}

export function buildMunicipioLayer(
  geojson: FeatureCollection,
  shares: Map<number, MunicipioShare> | null,
) {
  return buildChoroplethLayer("municipios", geojson, "cd_municipio_tse", shares);
}

// Só o contorno do município, sem preenchimento -- serve de pano de fundo pro
// nível de seção eleitoral (zoom alto), onde os pontos sozinhos deixam o
// usuário sem noção de em qual cidade cada um está.
export function buildMunicipioOutlineLayer(geojson: FeatureCollection) {
  return new GeoJsonLayer({
    id: "municipios-outline",
    data: geojson,
    stroked: true,
    filled: false,
    pickable: false,
    getLineColor: [120, 120, 120, 180],
    lineWidthMinPixels: 1,
  });
}

export function buildSecaoLayer(shares: SecaoShare[]) {
  const maxShare = Math.max(0, ...shares.map((s) => s.share ?? 0));

  return new ScatterplotLayer<SecaoShare>({
    id: "secoes",
    data: shares,
    pickable: true,
    stroked: true,
    filled: true,
    radiusUnits: "pixels",
    radiusMinPixels: 3,
    radiusMaxPixels: 8,
    lineWidthMinPixels: 1,
    getPosition: (d) => [d.longitude, d.latitude],
    getFillColor: (d) => {
      const [r, g, b] = shareColor(d.share, maxShare);
      return [r, g, b, 220];
    },
    getLineColor: (d) => (d.is_approximate ? [255, 140, 0, 255] : [255, 255, 255, 200]),
    getRadius: 5,
    updateTriggers: {
      getFillColor: [maxShare],
    },
  });
}
