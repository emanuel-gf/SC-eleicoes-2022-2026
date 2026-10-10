import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Feature, FeatureCollection } from "geojson";
import { divergingColor, NO_DATA_COLOR, shareColor } from "./color";
import type {
  ComparacaoMetric,
  ComparacaoRow,
  MesorregiaoShare,
  MunicipioShare,
  SecaoShare,
} from "../duckdb/queries";

const NEUTRAL_FILL: [number, number, number, number] = [214, 211, 204, 200];

interface ShareRow {
  share: number | null;
}

function maxShareOf(shares: Map<number, ShareRow> | null): number {
  return shares ? Math.max(0, ...[...shares.values()].map((s) => s.share ?? 0)) : 0;
}

type Rgb = [number, number, number];

// Choropleth genérico: `colorOf` decide a cor de cada unidade a partir da linha
// casada pela propriedade `joinProperty` do GeoJSON. `colorKey` entra no
// updateTriggers -- tem que mudar sempre que a cor puder mudar.
function buildChoroplethLayer<Row>(
  id: string,
  geojson: FeatureCollection,
  joinProperty: string,
  rows: Map<number, Row> | null,
  colorOf: (row: Row | undefined) => Rgb,
  colorKey: unknown[],
) {
  return new GeoJsonLayer({
    id,
    data: geojson,
    stroked: true,
    filled: true,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 120],
    updateTriggers: {
      getFillColor: [rows, ...colorKey],
    },
    getFillColor: (f: Feature) => {
      if (!rows) return NEUTRAL_FILL;
      const key = f.properties?.[joinProperty] as number | undefined;
      const [r, g, b] = colorOf(key != null ? rows.get(key) : undefined);
      return [r, g, b, 210];
    },
    getLineColor: [255, 255, 255, 220],
    lineWidthMinPixels: 0.5,
  });
}

function buildShareLayer(id: string, geojson: FeatureCollection, joinProperty: string, shares: Map<number, ShareRow> | null) {
  const maxShare = maxShareOf(shares);
  return buildChoroplethLayer(id, geojson, joinProperty, shares, (row) => shareColor(row?.share, maxShare), [maxShare]);
}

export function buildMesorregiaoLayer(
  geojson: FeatureCollection,
  shares: Map<number, MesorregiaoShare> | null,
) {
  return buildShareLayer("mesorregioes", geojson, "cd_mesorregiao", shares);
}

export function buildMunicipioLayer(
  geojson: FeatureCollection,
  shares: Map<number, MunicipioShare> | null,
) {
  return buildShareLayer("municipios", geojson, "cd_municipio_tse", shares);
}

// Variação % satura em ±100%: acima disso a cor não muda (base pequena em
// 2022 gera % enormes, tipo 3 -> 30 votos = +900%, que achatariam o resto).
export const PCT_DOMAIN = 1;

// Diferença absoluta usa curva raiz quadrada na intensidade: em escala linear
// uma cidade grande (ex. Florianópolis, +106 mil pro Jorginho) define o
// domínio e qualquer ganho/perda de poucos milhares fica cinza. Com a raiz,
// diferenças médias aparecem e o maior valor continua saturando. A legenda
// usa a mesma função pra posicionar os ticks.
export function diffIntensity(diff: number, domain: number): number {
  if (domain <= 0) return 0;
  return Math.sign(diff) * Math.sqrt(Math.min(1, Math.abs(diff) / domain));
}

/** Domínio simétrico da escala divergente: max |diff| no modo absoluto, ±100% no %. */
export function comparacaoDomain(rows: Map<number, ComparacaoRow> | null, metric: ComparacaoMetric): number {
  if (metric === "pct") return PCT_DOMAIN;
  return rows ? Math.max(0, ...[...rows.values()].map((r) => Math.abs(r.diff))) : 0;
}

function comparacaoColor(row: ComparacaoRow | undefined, metric: ComparacaoMetric, domain: number): Rgb {
  if (!row || (row.votos_2022 === 0 && row.votos_2026 === 0) || domain <= 0) return NO_DATA_COLOR;
  if (metric === "pct") {
    // Sem voto em 2022 e com voto em 2026 = "novo": ganho máximo.
    if (row.pct == null) return divergingColor(1);
    return divergingColor(row.pct / domain);
  }
  return divergingColor(diffIntensity(row.diff, domain));
}

// Mesmo choropleth do modo resultado (mesmos ids de camada, então o tooltip
// continua achando a feature), só que com a escala divergente de ganho/perda.
export function buildComparacaoLayer(
  level: "municipio" | "mesorregiao",
  geojson: FeatureCollection,
  rows: Map<number, ComparacaoRow> | null,
  metric: ComparacaoMetric,
) {
  const domain = comparacaoDomain(rows, metric);
  const [id, joinProperty] =
    level === "municipio" ? ["municipios", "cd_municipio_tse"] : ["mesorregioes", "cd_mesorregiao"];
  return buildChoroplethLayer(id, geojson, joinProperty, rows, (row) => comparacaoColor(row, metric, domain), [
    metric,
    domain,
  ]);
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
