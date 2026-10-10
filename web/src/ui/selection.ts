import type {
  Candidato,
  Comparacao,
  ComparacaoMetric,
  ComparisonSelection,
  FilterMode,
  FilterSelection,
  Partido,
} from "../duckdb/queries";

// O que o usuário quer ver -- campos ausentes (ou que não existem no ano/cargo/
// turno escolhido) caem no primeiro valor válido. É o único lugar que sabe
// montar uma FilterSelection consistente, pra trocar de ano/cargo/turno/modo
// nunca deixar o filtro apontando pra um candidato que não existe ali.
export interface SelectionWish {
  mode: FilterMode;
  ano: number;
  cdCargo?: number;
  turno?: number;
  value?: number;
  // Em modo candidato, casa pelo nome quando o número não é confiável (troca
  // de ano: o número de urna não é estável entre eleições).
  label?: string;
}

export function anosDisponiveis(candidatos: Candidato[]): number[] {
  return [...new Set(candidatos.map((c) => c.ano_eleicao))].sort((a, b) => b - a);
}

export function cargosDoAno(candidatos: Candidato[], ano: number): [number, string][] {
  const seen = new Map<number, string>();
  for (const c of candidatos) if (c.ano_eleicao === ano) seen.set(c.cd_cargo, c.ds_cargo);
  return [...seen.entries()];
}

export function turnosDoCargo(candidatos: Candidato[], ano: number, cdCargo: number): number[] {
  return [
    ...new Set(candidatos.filter((c) => c.ano_eleicao === ano && c.cd_cargo === cdCargo).map((c) => c.turno)),
  ].sort();
}

export function candidatosDoFiltro(candidatos: Candidato[], ano: number, cdCargo: number, turno: number): Candidato[] {
  return candidatos
    .filter((c) => c.ano_eleicao === ano && c.cd_cargo === cdCargo && c.turno === turno)
    .sort((a, b) => a.nm_votavel.localeCompare(b.nm_votavel));
}

export function partidosDoFiltro(partidos: Partido[], ano: number, cdCargo: number, turno: number): Partido[] {
  return partidos
    .filter((p) => p.ano_eleicao === ano && p.cd_cargo === cdCargo && p.turno === turno)
    .sort((a, b) => a.sg_partido.localeCompare(b.sg_partido));
}

export function resolveSelection(
  candidatos: Candidato[],
  partidos: Partido[],
  wish: SelectionWish,
): FilterSelection | null {
  const cargos = cargosDoAno(candidatos, wish.ano);
  const cargo = cargos.find(([cd]) => cd === wish.cdCargo) ?? cargos[0];
  if (!cargo) return null;
  const [cdCargo, dsCargo] = cargo;

  const turnos = turnosDoCargo(candidatos, wish.ano, cdCargo);
  const turno = wish.turno != null && turnos.includes(wish.turno) ? wish.turno : turnos[0];

  if (wish.mode === "candidato") {
    const options = candidatosDoFiltro(candidatos, wish.ano, cdCargo, turno);
    const chosen =
      (wish.label != null ? options.find((c) => c.nm_votavel === wish.label) : undefined) ??
      (wish.label == null && wish.value != null ? options.find((c) => c.nr_votavel === wish.value) : undefined) ??
      options[0];
    if (!chosen) return null;
    return { mode: "candidato", ano: wish.ano, cdCargo, dsCargo, turno, value: chosen.nr_votavel, label: chosen.nm_votavel };
  }

  const options = partidosDoFiltro(partidos, wish.ano, cdCargo, turno);
  const chosen = options.find((p) => p.nr_partido === wish.value) ?? options[0];
  if (!chosen) return null;
  return { mode: "partido", ano: wish.ano, cdCargo, dsCargo, turno, value: chosen.nr_partido, label: chosen.sg_partido };
}

// --- Comparação 2022 -> 2026 ---

export function cargosComparaveis(comparacoes: Comparacao[]): [number, string][] {
  const seen = new Map<number, string>();
  for (const c of comparacoes) seen.set(c.cd_cargo, c.ds_cargo);
  return [...seen.entries()];
}

export function comparacoesDoCargo(comparacoes: Comparacao[], cdCargo: number): Comparacao[] {
  return comparacoes
    .filter((c) => c.cd_cargo === cdCargo)
    .sort((a, b) => a.nome_2026.localeCompare(b.nome_2026));
}

// Mesmo papel do resolveSelection: cargo/pessoa que não existem caem no
// primeiro válido. Sem pessoa pedida, abre em quem teve mais voto em 2026 no
// cargo -- começar num candidato nanico deixa o mapa quase todo cinza.
export function resolveComparison(
  comparacoes: Comparacao[],
  wish: { cdCargo?: number; idPessoa?: number; metric?: ComparacaoMetric },
): ComparisonSelection | null {
  const cargos = cargosComparaveis(comparacoes);
  const cargo = cargos.find(([cd]) => cd === wish.cdCargo) ?? cargos[0];
  if (!cargo) return null;
  const options = comparacoesDoCargo(comparacoes, cargo[0]);
  const maisVotado = [...options].sort((a, b) => b.votos_2026 - a.votos_2026)[0];
  const chosen = options.find((c) => c.id_pessoa === wish.idPessoa) ?? maisVotado;
  if (!chosen) return null;
  return { cdCargo: cargo[0], idPessoa: chosen.id_pessoa, metric: wish.metric ?? "diff" };
}
