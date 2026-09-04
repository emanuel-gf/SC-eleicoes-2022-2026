import { useMemo } from "react";
import type { Candidato, FilterMode, FilterSelection, Partido } from "../duckdb/queries";

interface Props {
  candidatos: Candidato[];
  partidos: Partido[];
  selection: FilterSelection | null;
  onChange: (selection: FilterSelection) => void;
}

const selectStyle: React.CSSProperties = { width: "100%" };
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };

export function FilterPanel({ candidatos, partidos, selection, onChange }: Props) {
  const cargos = useMemo(() => {
    const seen = new Map<number, string>();
    for (const c of candidatos) seen.set(c.cd_cargo, c.ds_cargo);
    return [...seen.entries()];
  }, [candidatos]);

  const turnos = useMemo(() => {
    if (!selection) return [];
    return [...new Set(candidatos.filter((c) => c.cd_cargo === selection.cdCargo).map((c) => c.turno))].sort();
  }, [candidatos, selection]);

  const candidatosDoFiltro = useMemo(() => {
    if (!selection) return [];
    return candidatos
      .filter((c) => c.cd_cargo === selection.cdCargo && c.turno === selection.turno)
      .sort((a, b) => a.nm_votavel.localeCompare(b.nm_votavel));
  }, [candidatos, selection]);

  const partidosDoFiltro = useMemo(() => {
    if (!selection) return [];
    return partidos
      .filter((p) => p.cd_cargo === selection.cdCargo && p.turno === selection.turno)
      .sort((a, b) => a.sg_partido.localeCompare(b.sg_partido));
  }, [partidos, selection]);

  if (!selection) return null;

  function selectMode(mode: FilterMode) {
    if (!selection) return;
    if (mode === "candidato") {
      const first = candidatosDoFiltro[0];
      if (first) {
        onChange({ ...selection, mode, value: first.nr_votavel, label: first.nm_votavel });
      }
    } else {
      const first = partidosDoFiltro[0];
      if (first) {
        onChange({ ...selection, mode, value: first.nr_partido, label: first.sg_partido });
      }
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: 16,
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
      }}
    >
      <label style={labelStyle}>
        Cargo
        <select
          style={selectStyle}
          value={selection.cdCargo}
          onChange={(e) => {
            const cdCargo = Number(e.target.value);
            const primeiro = candidatos.find((c) => c.cd_cargo === cdCargo);
            if (primeiro) {
              onChange({
                mode: selection.mode,
                cdCargo,
                dsCargo: primeiro.ds_cargo,
                turno: primeiro.turno,
                value: primeiro.nr_votavel,
                label: primeiro.nm_votavel,
              });
            }
          }}
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
            onChange={(e) => onChange({ ...selection, turno: Number(e.target.value) })}
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
              const c = candidatosDoFiltro.find((x) => x.nr_votavel === nr);
              onChange({ ...selection, value: nr, label: c?.nm_votavel ?? "" });
            }}
          >
            {candidatosDoFiltro.map((c) => (
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
              const p = partidosDoFiltro.find((x) => x.nr_partido === nr);
              onChange({ ...selection, value: nr, label: p?.sg_partido ?? "" });
            }}
          >
            {partidosDoFiltro.map((p) => (
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
