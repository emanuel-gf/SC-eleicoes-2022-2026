import { useMemo } from "react";
import {
  ANO_BASE,
  ANO_COMPARADO,
  type Candidato,
  type Comparacao,
  type ComparacaoMetric,
  type ComparisonSelection,
  type FilterMode,
  type FilterSelection,
  type Partido,
} from "../duckdb/queries";
import {
  anosDisponiveis,
  candidatosDoFiltro,
  cargosComparaveis,
  cargosDoAno,
  comparacoesDoCargo,
  partidosDoFiltro,
  resolveComparison,
  resolveSelection,
  turnosDoCargo,
  type SelectionWish,
} from "./selection";

export type ViewMode = "resultado" | "comparacao";

interface Props {
  candidatos: Candidato[];
  partidos: Partido[];
  selection: FilterSelection | null;
  loadError: string | null;
  onChange: (selection: FilterSelection) => void;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  comparacoes: Comparacao[];
  comparison: ComparisonSelection | null;
  onComparisonChange: (comparison: ComparisonSelection) => void;
}

const selectStyle: React.CSSProperties = { width: "100%" };
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 10,
  background: "rgba(255,255,255,0.95)",
  borderRadius: 8,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  fontFamily: "system-ui, sans-serif",
  fontSize: 14,
  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
  minWidth: 240,
};

const numberFormat = new Intl.NumberFormat("pt-BR");

// Partido em 2022 pode vir nulo (o ~0,03% de votos sem partido resolvido no
// build -- candidatura indeferida/cassada); aí mostra só o de 2026.
function partidoLabel(p: Comparacao): string {
  const antes = p.sg_partido_2022;
  const depois = p.sg_partido_2026 ?? "?";
  return !antes || antes === depois ? depois : `${antes} → ${depois}`;
}

// Dois botões lado a lado, o ativo preenchido -- usado pro modo de visão e pra
// métrica da comparação.
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" style={{ display: "flex", border: "1px solid #c3c2b7", borderRadius: 6, overflow: "hidden" }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          style={{
            flex: 1,
            border: "none",
            padding: "5px 8px",
            fontSize: 13,
            cursor: "pointer",
            background: value === v ? "#2a78d6" : "transparent",
            color: value === v ? "#ffffff" : "#0b0b0b",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ComparisonControls({
  comparacoes,
  comparison,
  onChange,
}: {
  comparacoes: Comparacao[];
  comparison: ComparisonSelection;
  onChange: (comparison: ComparisonSelection) => void;
}) {
  const cargos = useMemo(() => cargosComparaveis(comparacoes), [comparacoes]);
  const pessoas = useMemo(() => comparacoesDoCargo(comparacoes, comparison.cdCargo), [comparacoes, comparison.cdCargo]);
  const atual = pessoas.find((p) => p.id_pessoa === comparison.idPessoa);

  function apply(wish: { cdCargo?: number; idPessoa?: number; metric?: ComparacaoMetric }) {
    const next = resolveComparison(comparacoes, wish);
    if (next) onChange(next);
  }

  return (
    <>
      <label style={labelStyle}>
        Cargo (mesmo cargo nos dois anos)
        <select
          style={selectStyle}
          value={comparison.cdCargo}
          onChange={(e) => apply({ cdCargo: Number(e.target.value), metric: comparison.metric })}
        >
          {cargos.map(([cd, nome]) => (
            <option key={cd} value={cd}>
              {nome}
            </option>
          ))}
        </select>
      </label>

      <label style={labelStyle}>
        Candidato ({pessoas.length} concorreram em {ANO_BASE} e {ANO_COMPARADO})
        <select
          style={selectStyle}
          value={comparison.idPessoa}
          onChange={(e) =>
            apply({ cdCargo: comparison.cdCargo, idPessoa: Number(e.target.value), metric: comparison.metric })
          }
        >
          {pessoas.map((p) => (
            <option key={p.id_pessoa} value={p.id_pessoa}>
              {p.nome_2026} ({partidoLabel(p)})
            </option>
          ))}
        </select>
      </label>

      {atual && (
        <div style={{ fontSize: 13, color: "#52514e", lineHeight: 1.5 }}>
          Total SC: {numberFormat.format(atual.votos_2022)} → {numberFormat.format(atual.votos_2026)} votos
          {" ("}
          {atual.votos_2026 >= atual.votos_2022 ? "+" : "−"}
          {numberFormat.format(Math.abs(atual.votos_2026 - atual.votos_2022))})
          {atual.nr_2022 !== atual.nr_2026 && (
            <>
              <br />
              Número {atual.nr_2022} em {ANO_BASE} → {atual.nr_2026} em {ANO_COMPARADO}
            </>
          )}
        </div>
      )}

      <Segmented<ComparacaoMetric>
        value={comparison.metric}
        options={[
          ["diff", "Diferença de votos"],
          ["pct", "Variação %"],
        ]}
        onChange={(metric) => onChange({ ...comparison, metric })}
      />
      <div style={{ fontSize: 12, color: "#898781" }}>1º turno de {ANO_BASE} vs 1º turno de {ANO_COMPARADO}</div>
    </>
  );
}

export function FilterPanel({
  candidatos,
  partidos,
  selection,
  loadError,
  onChange,
  view,
  onViewChange,
  comparacoes,
  comparison,
  onComparisonChange,
}: Props) {
  const anos = useMemo(() => anosDisponiveis(candidatos), [candidatos]);

  const cargos = useMemo(
    () => (selection ? cargosDoAno(candidatos, selection.ano) : []),
    [candidatos, selection],
  );

  const turnos = useMemo(
    () => (selection ? turnosDoCargo(candidatos, selection.ano, selection.cdCargo) : []),
    [candidatos, selection],
  );

  const candidatosOpcoes = useMemo(
    () => (selection ? candidatosDoFiltro(candidatos, selection.ano, selection.cdCargo, selection.turno) : []),
    [candidatos, selection],
  );

  const partidosOpcoes = useMemo(
    () => (selection ? partidosDoFiltro(partidos, selection.ano, selection.cdCargo, selection.turno) : []),
    [partidos, selection],
  );

  // Painel sempre visível: enquanto o DuckDB carrega, ou se der erro, mostra
  // isso no lugar dos filtros em vez de sumir sem explicação.
  if (!selection) {
    return (
      <div style={{ ...panelStyle, maxWidth: 360 }}>
        {loadError ? (
          <span style={{ color: "#b42318" }}>Erro ao carregar os dados: {loadError}</span>
        ) : (
          <span>Carregando dados…</span>
        )}
      </div>
    );
  }

  const viewSwitch = (
    <Segmented<ViewMode>
      value={view}
      options={[
        ["resultado", "Resultado"],
        ["comparacao", `Comparar ${ANO_BASE} → ${ANO_COMPARADO}`],
      ]}
      onChange={onViewChange}
    />
  );

  if (view === "comparacao" && comparison) {
    return (
      <div style={{ ...panelStyle, width: 300 }}>
        {viewSwitch}
        <ComparisonControls comparacoes={comparacoes} comparison={comparison} onChange={onComparisonChange} />
      </div>
    );
  }

  function apply(wish: SelectionWish) {
    const next = resolveSelection(candidatos, partidos, wish);
    if (next) onChange(next);
  }

  // Troca de ano mantém cargo/turno/modo quando existem no outro ano, e tenta
  // manter o mesmo candidato (pelo nome) ou o mesmo partido (pelo número).
  function selectAno(ano: number) {
    if (!selection) return;
    apply({
      mode: selection.mode,
      ano,
      cdCargo: selection.cdCargo,
      turno: selection.turno,
      value: selection.value,
      label: selection.mode === "candidato" ? selection.label : undefined,
    });
  }

  function selectMode(mode: FilterMode) {
    if (!selection) return;
    apply({ mode, ano: selection.ano, cdCargo: selection.cdCargo, turno: selection.turno });
  }

  return (
    <div style={panelStyle}>
      {viewSwitch}
      <label style={labelStyle}>
        Eleição
        <select style={selectStyle} value={selection.ano} onChange={(e) => selectAno(Number(e.target.value))}>
          {anos.map((ano) => (
            <option key={ano} value={ano}>
              {ano}
            </option>
          ))}
        </select>
      </label>

      <label style={labelStyle}>
        Cargo
        <select
          style={selectStyle}
          value={selection.cdCargo}
          onChange={(e) => apply({ mode: selection.mode, ano: selection.ano, cdCargo: Number(e.target.value) })}
        >
          {cargos.map(([cd, nome]) => (
            <option key={cd} value={cd}>
              {nome}
            </option>
          ))}
        </select>
      </label>

      {turnos.length > 1 && (
        <label style={labelStyle}>
          Turno
          <select
            style={selectStyle}
            value={selection.turno}
            onChange={(e) =>
              apply({
                mode: selection.mode,
                ano: selection.ano,
                cdCargo: selection.cdCargo,
                turno: Number(e.target.value),
                value: selection.value,
              })
            }
          >
            {turnos.map((t) => (
              <option key={t} value={t}>
                {t}º turno
              </option>
            ))}
          </select>
        </label>
      )}

      <div role="radiogroup" style={{ display: "flex", gap: 12, fontSize: 13 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="radio"
            name="filter-mode"
            checked={selection.mode === "candidato"}
            onChange={() => selectMode("candidato")}
          />
          Candidato
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="radio"
            name="filter-mode"
            checked={selection.mode === "partido"}
            onChange={() => selectMode("partido")}
          />
          Partido
        </label>
      </div>

      {selection.mode === "candidato" ? (
        <label style={labelStyle}>
          Candidato
          <select
            style={selectStyle}
            value={selection.value}
            onChange={(e) => {
              const nr = Number(e.target.value);
              const c = candidatosOpcoes.find((x) => x.nr_votavel === nr);
              onChange({ ...selection, value: nr, label: c?.nm_votavel ?? "" });
            }}
          >
            {candidatosOpcoes.map((c) => (
              <option key={c.nr_votavel} value={c.nr_votavel}>
                {c.nm_votavel} ({c.nr_votavel}
                {c.sg_partido ? ` - ${c.sg_partido}` : ""})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label style={labelStyle}>
          Partido
          <select
            style={selectStyle}
            value={selection.value}
            onChange={(e) => {
              const nr = Number(e.target.value);
              const p = partidosOpcoes.find((x) => x.nr_partido === nr);
              onChange({ ...selection, value: nr, label: p?.sg_partido ?? "" });
            }}
          >
            {partidosOpcoes.map((p) => (
              <option key={p.nr_partido} value={p.nr_partido}>
                {p.sg_partido} ({p.nr_partido}) - {p.nm_partido}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
