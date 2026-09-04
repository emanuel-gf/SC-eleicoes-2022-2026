import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { FeatureCollection } from "geojson";
import { buildMunicipioLayer } from "./layers";
import { getDuckDB } from "../duckdb/client";
import {
  fetchCandidatos,
  fetchMunicipioShares,
  type Candidato,
  type CandidatoSelection,
  type MunicipioShare,
} from "../duckdb/queries";
import { FilterPanel } from "../ui/FilterPanel";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const SC_CENTER: [number, number] = [-50.5, -27.3];
const SC_ZOOM = 6.6;

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);

  const [geojson, setGeojson] = useState<FeatureCollection | null>(null);
  const [candidatos, setCandidatos] = useState<Candidato[]>([]);
  const [selection, setSelection] = useState<CandidatoSelection | null>(null);
  const [shares, setShares] = useState<Map<number, MunicipioShare> | null>(null);

  // Cria o mapa + overlay do deck.gl uma vez.
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: SC_CENTER,
      zoom: SC_ZOOM,
    });

    const overlay = new MapboxOverlay({
      layers: [],
      getTooltip: ({ object }) =>
        object?.properties
          ? { text: `${object.properties.nm_municipio_ibge}\n${object.properties.nm_mesorregiao}` }
          : null,
    });
    map.addControl(overlay as unknown as maplibregl.IControl);
    overlayRef.current = overlay;

    return () => {
      overlayRef.current = null;
      map.remove();
    };
  }, []);

  // Carrega o GeoJSON dos municípios (independe do duckdb).
  useEffect(() => {
    let cancelled = false;
    fetch("/geo/sc_municipios.geojson")
      .then((r) => r.json() as Promise<FeatureCollection>)
      .then((data) => {
        if (!cancelled) setGeojson(data);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Inicializa o DuckDB-WASM e carrega a lista de candidatos; seleciona o
  // primeiro candidato por padrão pra já mostrar algo no mapa.
  useEffect(() => {
    let cancelled = false;
    getDuckDB()
      .then((db) => fetchCandidatos(db))
      .then((rows) => {
        if (cancelled) return;
        setCandidatos(rows);
        if (rows.length > 0) {
          setSelection({ cdCargo: rows[0].cd_cargo, turno: rows[0].turno, nrVotavel: rows[0].nr_votavel });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reconsulta os votos por município toda vez que o filtro muda.
  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    getDuckDB()
      .then((db) => fetchMunicipioShares(db, selection))
      .then((rows) => {
        if (cancelled) return;
        setShares(new Map(rows.map((r) => [r.cd_municipio_tse, r])));
      });
    return () => {
      cancelled = true;
    };
  }, [selection]);

  // Redesenha a camada sempre que o GeoJSON ou os votos mudarem.
  useEffect(() => {
    if (!overlayRef.current || !geojson) return;
    overlayRef.current.setProps({ layers: [buildMunicipioLayer(geojson, shares)] });
  }, [geojson, shares]);

  return (
    <>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <FilterPanel candidatos={candidatos} selection={selection} onChange={setSelection} />
    </>
  );
}
