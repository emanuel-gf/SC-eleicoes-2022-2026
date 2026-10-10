import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { FeatureCollection } from "geojson";
import {
  buildComparacaoLayer,
  buildMesorregiaoLayer,
  buildMunicipioLayer,
  buildMunicipioOutlineLayer,
  buildSecaoLayer,
  comparacaoDomain,
} from "./layers";
import { BASEMAPS, DEFAULT_BASEMAP } from "./basemaps";
import { getDuckDB, registerSecaoPartition } from "../duckdb/client";
import { assetUrl } from "../assetUrl";
import {
  ANO_BASE,
  ANO_COMPARADO,
  CARGO_SLUGS,
  fetchCandidatos,
  fetchComparacaoRows,
  fetchComparacoes,
  fetchMesorregiaoShares,
  fetchMunicipioShares,
  fetchPartidos,
  fetchSecaoShares,
  type Candidato,
  type Comparacao,
  type ComparacaoRow,
  type ComparisonSelection,
  type FilterSelection,
  type MesorregiaoShare,
  type MunicipioShare,
  type Partido,
  type SecaoShare,
} from "../duckdb/queries";
import { FilterPanel, type ViewMode } from "../ui/FilterPanel";
import { ComparisonLegend } from "../ui/ComparisonLegend";
import { BasemapSwitcher } from "../ui/BasemapSwitcher";
import { ToggleControl } from "../ui/ToggleControl";
import { ScaleToggleButton } from "../ui/ScaleToggleButton";
import { anosDisponiveis, resolveComparison, resolveSelection } from "../ui/selection";

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

const numberFormat = new Intl.NumberFormat("pt-BR");

// Tela estreita (celular): filtros e mapa base começam escondidos, e abrir um
// fecha o outro -- abertos juntos eles se sobrepõem (o seletor de mapa base
// cobria o botão "Comparar").
const NARROW_QUERY = "(max-width: 640px)";
function isNarrowScreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches;
}
const pctFormat = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function formatSigned(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${numberFormat.format(Math.abs(n))}`;
}

function comparacaoTooltip(nome: string, pessoa: string, row: ComparacaoRow | undefined): string {
  if (!row) return `${nome}\n${pessoa}: sem votos em ${ANO_BASE} nem ${ANO_COMPARADO}`;
  const pct =
    row.pct == null
      ? row.votos_2026 > 0
        ? "novo -- 0 votos em 2022"
        : "sem votos"
      : `${row.pct > 0 ? "+" : row.pct < 0 ? "−" : ""}${pctFormat.format(Math.abs(row.pct))}`;
  return (
    `${nome}\n${pessoa}\n` +
    `${ANO_BASE}: ${numberFormat.format(row.votos_2022)} · ${ANO_COMPARADO}: ${numberFormat.format(row.votos_2026)} votos\n` +
    `Diferença: ${formatSigned(row.diff)} (${pct})`
  );
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(() => !isNarrowScreen());
  const [basemapOpen, setBasemapOpen] = useState(() => !isNarrowScreen());

  function toggleFilters() {
    const next = !filtersOpen;
    setFiltersOpen(next);
    if (next && isNarrowScreen()) setBasemapOpen(false);
  }

  function toggleBasemap() {
    const next = !basemapOpen;
    setBasemapOpen(next);
    if (next && isNarrowScreen()) setFiltersOpen(false);
  }
  // Modo comparação: estado próprio, separado da `selection` do modo
  // resultado -- voltar pro resultado restaura o que estava selecionado.
  const [view, setView] = useState<ViewMode>("resultado");
  const [comparacoes, setComparacoes] = useState<Comparacao[]>([]);
  const [comparison, setComparison] = useState<ComparisonSelection | null>(null);
  const [comparacaoMunicipio, setComparacaoMunicipio] = useState<Map<number, ComparacaoRow> | null>(null);
  const [comparacaoMesorregiao, setComparacaoMesorregiao] = useState<Map<number, ComparacaoRow> | null>(null);

  // Comparação não tem nível de seção (seções mudam de lugar entre eleições,
  // e o geocode de 2022 ainda tem locais fora do município) -- no zoom alto
  // continua mostrando município.
  const effectiveTier: ZoomTier = view === "comparacao" && tier === "secao" ? "municipio" : tier;
  const pessoaAtual = comparacoes.find((c) => c.id_pessoa === comparison?.idPessoa) ?? null;

  // Refs espelhando o estado usado pelo getTooltip -- o callback é criado uma
  // vez só (na criação do overlay) então precisa ler do ref, não do closure,
  // pra não ficar preso nos valores da primeira renderização.
  const municipioSharesRef = useRef(municipioShares);
  const mesorregiaoSharesRef = useRef(mesorregiaoShares);
  const selectionRef = useRef(selection);
  const viewRef = useRef(view);
  const pessoaAtualRef = useRef(pessoaAtual);
  const comparacaoMunicipioRef = useRef(comparacaoMunicipio);
  const comparacaoMesorregiaoRef = useRef(comparacaoMesorregiao);
  useEffect(() => {
    viewRef.current = view;
    pessoaAtualRef.current = pessoaAtual;
    comparacaoMunicipioRef.current = comparacaoMunicipio;
    comparacaoMesorregiaoRef.current = comparacaoMesorregiao;
  }, [view, pessoaAtual, comparacaoMunicipio, comparacaoMesorregiao]);
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

        if (viewRef.current === "comparacao") {
          const pessoa = pessoaAtualRef.current?.nome_2026 ?? "";
          if (layer?.id === "municipios") {
            const cd = object.properties?.cd_municipio_tse as number | undefined;
            const row = cd != null ? comparacaoMunicipioRef.current?.get(cd) : undefined;
            return { text: comparacaoTooltip(object.properties?.nm_municipio_ibge, pessoa, row) };
          }
          if (layer?.id === "mesorregioes") {
            const cd = object.properties?.cd_mesorregiao as number | undefined;
            const row = cd != null ? comparacaoMesorregiaoRef.current?.get(cd) : undefined;
            return { text: comparacaoTooltip(object.properties?.nm_mesorregiao, pessoa, row) };
          }
          return null;
        }

        const sel = selectionRef.current;
        const label = sel ? `${sel.label} (${sel.ano})` : "";

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
    fetch(assetUrl("geo/sc_municipios.geojson"))
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
    fetch(assetUrl("geo/sc_mesorregioes.geojson"))
      .then((r) => r.json() as Promise<FeatureCollection>)
      .then((data) => {
        if (!cancelled) setMesorregioesGeojson(data);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Inicializa o DuckDB-WASM e carrega candidatos + partidos; seleciona o
  // primeiro candidato da eleição mais recente por padrão pra já mostrar algo no mapa.
  useEffect(() => {
    let cancelled = false;
    getDuckDB()
      .then((db) => Promise.all([fetchCandidatos(db), fetchPartidos(db), fetchComparacoes(db)]))
      .then(([candidatoRows, partidoRows, comparacaoRows]) => {
        if (cancelled) return;
        setCandidatos(candidatoRows);
        setPartidos(partidoRows);
        setComparacoes(comparacaoRows);
        setComparison(resolveComparison(comparacaoRows, {}));
        const [anoMaisRecente] = anosDisponiveis(candidatoRows);
        if (anoMaisRecente != null) {
          setSelection(resolveSelection(candidatoRows, partidoRows, { mode: "candidato", ano: anoMaisRecente }));
        } else {
          setLoadError("candidatos.parquet veio vazio -- rodar scripts/build_aggregates.py");
        }
      })
      .catch((err: unknown) => {
        // Sem isso o painel de filtro simplesmente some (ele só renderiza com
        // uma seleção) e o erro fica escondido no console.
        console.error("Falha ao carregar os dados no DuckDB", err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
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

  // Comparação: votos da pessoa nos dois anos por município e mesorregião.
  useEffect(() => {
    if (view !== "comparacao" || !pessoaAtual) return;
    let cancelled = false;
    getDuckDB().then(async (db) => {
      const [muni, meso] = await Promise.all([
        fetchComparacaoRows(db, "municipio", pessoaAtual),
        fetchComparacaoRows(db, "mesorregiao", pessoaAtual),
      ]);
      if (cancelled) return;
      setComparacaoMunicipio(new Map(muni.map((r) => [r.cd, r])));
      setComparacaoMesorregiao(new Map(meso.map((r) => [r.cd, r])));
    });
    return () => {
      cancelled = true;
    };
  }, [view, pessoaAtual]);

  // Seção eleitoral só carrega quando o zoom pede o nível de detalhe máximo --
  // a partição certa (ano/cargo/turno) é registrada sob demanda no DuckDB.
  useEffect(() => {
    if (!selection || effectiveTier !== "secao") return;
    const cargoSlug = CARGO_SLUGS[selection.dsCargo];
    if (!cargoSlug) return;
    let cancelled = false;
    getDuckDB().then(async (db) => {
      const file = await registerSecaoPartition(db, selection.ano, cargoSlug, selection.turno);
      const rows = await fetchSecaoShares(db, file, selection);
      if (!cancelled) setSecaoShares(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [selection, effectiveTier]);

  // Redesenha só a(s) camada(s) do nível de zoom atual. No nível de seção, o
  // contorno dos municípios entra por baixo dos pontos pra dar referência de
  // "em qual cidade" cada um está.
  useEffect(() => {
    if (!overlayRef.current) return;
    if (view === "comparacao") {
      const metric = comparison?.metric ?? "diff";
      if (effectiveTier === "mesorregiao") {
        if (!mesorregioesGeojson) return;
        overlayRef.current.setProps({
          layers: [buildComparacaoLayer("mesorregiao", mesorregioesGeojson, comparacaoMesorregiao, metric)],
        });
      } else {
        if (!municipiosGeojson) return;
        overlayRef.current.setProps({
          layers: [buildComparacaoLayer("municipio", municipiosGeojson, comparacaoMunicipio, metric)],
        });
      }
      return;
    }
    if (effectiveTier === "mesorregiao") {
      if (!mesorregioesGeojson) return;
      overlayRef.current.setProps({ layers: [buildMesorregiaoLayer(mesorregioesGeojson, mesorregiaoShares)] });
    } else if (effectiveTier === "municipio") {
      if (!municipiosGeojson) return;
      overlayRef.current.setProps({ layers: [buildMunicipioLayer(municipiosGeojson, municipioShares)] });
    } else {
      const layers = [];
      if (municipiosGeojson) layers.push(buildMunicipioOutlineLayer(municipiosGeojson));
      layers.push(buildSecaoLayer(secaoShares ?? []));
      overlayRef.current.setProps({ layers });
    }
  }, [
    view,
    comparison,
    effectiveTier,
    municipiosGeojson,
    mesorregioesGeojson,
    municipioShares,
    mesorregiaoShares,
    secaoShares,
    comparacaoMunicipio,
    comparacaoMesorregiao,
  ]);

  const legendDomain =
    view === "comparacao" && comparison
      ? comparacaoDomain(effectiveTier === "mesorregiao" ? comparacaoMesorregiao : comparacaoMunicipio, comparison.metric)
      : 0;

  return (
    <>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {/* Erro de carregamento abre o painel mesmo escondido -- não pode sumir calado. */}
      <ToggleControl side="left" label="Filtros" open={filtersOpen || loadError != null} onToggle={toggleFilters}>
        <FilterPanel
          candidatos={candidatos}
          partidos={partidos}
          selection={selection}
          loadError={loadError}
          onChange={setSelection}
          view={view}
          onViewChange={setView}
          comparacoes={comparacoes}
          comparison={comparison}
          onComparisonChange={setComparison}
        />
      </ToggleControl>
      {view === "comparacao" && comparison && legendDomain > 0 && (
        <ComparisonLegend metric={comparison.metric} domain={legendDomain} />
      )}
      <ToggleControl side="right" label="Mapa base" open={basemapOpen} onToggle={toggleBasemap}>
        <BasemapSwitcher current={basemapId} onChange={setBasemapId} />
      </ToggleControl>
      <ScaleToggleButton visible={scaleVisible} onToggle={() => setScaleVisible((v) => !v)} />
    </>
  );
}
