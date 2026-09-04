import { useMemo } from "react";
import type { Candidato, CandidatoSelection } from "../duckdb/queries";

interface Props {
  candidatos: Candidato[];
  selection: CandidatoSelection | null;
  onChange: (selection: CandidatoSelection) => void;
}

export function FilterPanel({ candidatos, selection, onChange }: Props) {
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

  if (!selection) return null;

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
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Cargo
        <select
          value={selection.cdCargo}
          onChange={(e) => {
            const cdCargo = Number(e.target.value);
            const primeiro = candidatos.find((c) => c.cd_cargo === cdCargo);
            if (primeiro) onChange({ cdCargo, turno: primeiro.turno, nrVotavel: primeiro.nr_votavel });
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
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Turno
          <select
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

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Candidato
        <select
          value={selection.nrVotavel}
          onChange={(e) => onChange({ ...selection, nrVotavel: Number(e.target.value) })}
        >
          {candidatosDoFiltro.map((c) => (
            <option key={c.nr_votavel} value={c.nr_votavel}>
              {c.nm_votavel} ({c.nr_votavel})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
