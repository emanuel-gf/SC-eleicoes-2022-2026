import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { FeatureCollection } from "geojson";
import {
  buildMesorregiaoLayer,
  buildMunicipioLayer,
  buildMunicipioOutlineLayer,
  buildSecaoLayer,
} from "./layers";
import { BASEMAPS, DEFAULT_BASEMAP } from "./basemaps";
import { getDuckDB, registerSecaoPartition } from "../duckdb/client";
import {
  CARGO_SLUGS,
  fetchCandidatos,
  fetchMesorregiaoShares,
  fetchMunicipioShares,
  fetchPartidos,
  fetchSecaoShares,
  type Candidato,
  type FilterSelection,
  type MesorregiaoShare,
  type MunicipioShare,
  type Partido,
  type SecaoShare,
} from "../duckdb/queries";
import { FilterPanel } from "../ui/FilterPanel";
import { BasemapSwitcher } from "../ui/BasemapSwitcher";
import { ScaleToggleButton } from "../ui/ScaleToggleButton";

const SC_CENTER: [number, number] = [-50.5, -27.3];
const SC_ZOOM = 6.6;

// Os 3 níveis de zoom hierárquico do PLAN.md: mesorregião (bem afastado) ->
// município -> seção eleitoral (ponto exato, zoom alto).
const ZOOM_MESORREGIAO_MAX = 7;
const ZOOM_MUNICIPIO_MAX = 9.5;

type ZoomTier = "mesorregiao" | "municipio" | "secao";

function tierForZoom(zoom: number): ZoomTier {
  if (zoom < ZOOM_MESORREGIAO_MAX) return "mesorregiao";
  if (zoom < ZOOM_MUNICIPIO_MAX) return "municipio";
  return "secao";
}

function formatPct(share: number | null | undefined): string {
  return share != null ? `${(share * 100).toFixed(1)}%` : "sem dados";
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const scaleControlRef = useRef<maplibregl.ScaleControl | null>(null);

  const [municipiosGeojson, setMunicipiosGeojson] = useState<FeatureCollection | null>(null);
  const [mesorregioesGeojson, setMesorregioesGeojson] = useState<FeatureCollection | null>(null);
  const [candidatos, setCandidatos] = useState<Candidato[]>([]);
  const [partidos, setPartidos] = useState<Partido[]>([]);
  const [selection, setSelection] = useState<FilterSelection | null>(null);
  const [municipioShares, setMunicipioShares] = useState<Map<number, MunicipioShare> | null>(null);
  const [mesorregiaoShares, setMesorregiaoShares] = useState<Map<number, MesorregiaoShare> | null>(null);
  const [secaoShares, setSecaoShares] = useState<SecaoShare[] | null>(null);
  const [tier, setTier] = useState<ZoomTier>(tierForZoom(SC_ZOOM));
  const [basemapId, setBasemapId] = useState(DEFAULT_BASEMAP.id);
  const [scaleVisible, setScaleVisible] = useState(false);

  // Refs espelhando o estado usado pelo getTooltip -- o callback é criado uma
  // vez só (na criação do overlay) então precisa ler do ref, não do closure,
  // pra não ficar preso nos valores da primeira renderização.
  const municipioSharesRef = useRef(municipioShares);
  const mesorregiaoSharesRef = useRef(mesorregiaoShares);
  const selectionRef = useRef(selection);
  useEffect(() => {
    municipioSharesRef.current = municipioShares;
  }, [municipioShares]);
  useEffect(() => {
    mesorregiaoSharesRef.current = mesorregiaoShares;
  }, [mesorregiaoShares]);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  // Cria o mapa + overlay do deck.gl uma vez, e acompanha o zoom pra trocar de nível.
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: DEFAULT_BASEMAP.style,
      center: SC_CENTER,
      zoom: SC_ZOOM,
    });
    mapRef.current = map;

    const scale = new maplibregl.ScaleControl({ unit: "metric" });
    map.addControl(scale, "bottom-left");
    scaleControlRef.current = scale;
    // Começa escondida -- só aparece quando o usuário clicar no botão.
    scale._container.style.display = "none";

    const overlay = new MapboxOverlay({
      layers: [],
      getTooltip: ({ object, layer }) => {
        if (!object) return null;
        const label = selectionRef.current?.label ?? "";

        if (layer?.id === "secoes") {
          const s = object as SecaoShare;
          return {
            text: `Seção ${s.nr_zona}/${s.nr_local_votacao}\n${label}: ${s.votos} votos (${formatPct(s.share)})`,
          };
        }
        if (layer?.id === "municipios") {
          const cdMunicipioTse = object.properties?.cd_municipio_tse as number | undefined;
          const row = cdMunicipioTse != null ? municipioSharesRef.current?.get(cdMunicipioTse) : undefined;
          const nome = object.properties?.nm_municipio_ibge;
          return {
            text: row
              ? `${nome}\n${label}: ${row.votos} votos (${formatPct(row.share)})\nVotos válidos: ${row.total_validos}`
              : `${nome}`,
          };
        }
        if (layer?.id === "mesorregioes") {
          const cdMeso = object.properties?.cd_mesorregiao as number | undefined;
          const row = cdMeso != null ? mesorregiaoSharesRef.current?.get(cdMeso) : undefined;
          const nome = object.properties?.nm_mesorregiao;
          return {
            text: row
              ? `${nome}\n${label}: ${row.votos} \n  Votos/Votos válidos: votos (${formatPct(row.share)})`
              : `${nome}`,
          };
        }
        return null;
      },
    });
    map.addControl(overlay as unknown as maplibregl.IControl);
    overlayRef.current = overlay;

    const updateTier = () => setTier(tierForZoom(map.getZoom()));
    map.on("moveend", updateTier);

    return () => {
      map.off("moveend", updateTier);
      overlayRef.current = null;
      scaleControlRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // Troca de basemap: setStyle preserva os controles adicionados via addControl
  // (overlay do deck.gl e escala continuam no lugar).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const basemap = BASEMAPS.find((b) => b.id === basemapId) ?? DEFAULT_BASEMAP;
    map.setStyle(basemap.style);
  }, [basemapId]);

  // Mostra/esconde o controle de escala nativo do MapLibre.
  useEffect(() => {
    const container = scaleControlRef.current?._container;
    if (container) container.style.display = scaleVisible ? "block" : "none";
  }, [scaleVisible, tier]);

  // GeoJSON dos dois níveis poligonais -- independem do duckdb.
  useEffect(() => {
    let cancelled = false;
    fetch("/geo/sc_municipios.geojson")
      .then((r) => r.json() as Promise<FeatureCollection>)
      .then((data) => {
        if (!cancelled) setMunicipiosGeojson(data);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/geo/sc_mesorregioes.geojson")
      .then((r) => r.json() as Promise<FeatureCollection>)
      .then((data) => {
        if (!cancelled) setMesorregioesGeojson(data);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Inicializa o DuckDB-WASM e carrega candidatos + partidos; seleciona o
  // primeiro candidato por padrão pra já mostrar algo no mapa.
  useEffect(() => {
    let cancelled = false;
    getDuckDB()
      .then((db) => Promise.all([fetchCandidatos(db), fetchPartidos(db)]))
      .then(([candidatoRows, partidoRows]) => {
        if (cancelled) return;
        setCandidatos(candidatoRows);
        setPartidos(partidoRows);
        if (candidatoRows.length > 0) {
          const first = candidatoRows[0];
          setSelection({
            mode: "candidato",
            cdCargo: first.cd_cargo,
            dsCargo: first.ds_cargo,
            turno: first.turno,
            value: first.nr_votavel,
            label: first.nm_votavel,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Município e mesorregião são baratos (já carregados por inteiro) -- reconsulta
  // os dois toda vez que o filtro muda, independente do nível de zoom atual.
  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    getDuckDB().then(async (db) => {
      const [muni, meso] = await Promise.all([
        fetchMunicipioShares(db, selection),
        fetchMesorregiaoShares(db, selection),
      ]);
      if (cancelled) return;
      setMunicipioShares(new Map(muni.map((r) => [r.cd_municipio_tse, r])));
      setMesorregiaoShares(new Map(meso.map((r) => [r.cd_mesorregiao, r])));
    });
    return () => {
      cancelled = true;
    };
  }, [selection]);

  // Seção eleitoral só carrega quando o zoom pede o nível de detalhe máximo --
  // a partição certa (cargo/turno) é registrada sob demanda no DuckDB.
  useEffect(() => {
    if (!selection || tier !== "secao") return;
    const cargoSlug = CARGO_SLUGS[selection.dsCargo];
    if (!cargoSlug) return;
    let cancelled = false;
    getDuckDB().then(async (db) => {
      const file = await registerSecaoPartition(db, cargoSlug, selection.turno);
      const rows = await fetchSecaoShares(db, file, selection);
      if (!cancelled) setSecaoShares(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [selection, tier]);

  // Redesenha só a(s) camada(s) do nível de zoom atual. No nível de seção, o
  // contorno dos municípios entra por baixo dos pontos pra dar referência de
  // "em qual cidade" cada um está.
  useEffect(() => {
    if (!overlayRef.current) return;
    if (tier === "mesorregiao") {
      if (!mesorregioesGeojson) return;
      overlayRef.current.setProps({ layers: [buildMesorregiaoLayer(mesorregioesGeojson, mesorregiaoShares)] });
    } else if (tier === "municipio") {
      if (!municipiosGeojson) return;
      overlayRef.current.setProps({ layers: [buildMunicipioLayer(municipiosGeojson, municipioShares)] });
    } else {
      const layers = [];
      if (municipiosGeojson) layers.push(buildMunicipioOutlineLayer(municipiosGeojson));
      layers.push(buildSecaoLayer(secaoShares ?? []));
      overlayRef.current.setProps({ layers });
    }
  }, [tier, municipiosGeojson, mesorregioesGeojson, municipioShares, mesorregiaoShares, secaoShares]);

  return (
    <>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <FilterPanel candidatos={candidatos} partidos={partidos} selection={selection} onChange={setSelection} />
      <BasemapSwitcher current={basemapId} onChange={setBasemapId} />
      <ScaleToggleButton visible={scaleVisible} onToggle={() => setScaleVisible((v) => !v)} />
    </>
  );
}
