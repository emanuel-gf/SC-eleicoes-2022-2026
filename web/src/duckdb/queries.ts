import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

// Colunas de contagem/soma (BIGINT) voltam do Arrow como BigInt -- converte pra
// number aqui na borda, já que votos cabem tranquilo em Number.MAX_SAFE_INTEGER
// e deixar BigInt vazar pro estado do React quebra serialização por aí.
function rowToPlainObject<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return out as T;
}

export interface Candidato {
  ano_eleicao: number;
  turno: number;
  cd_cargo: number;
  ds_cargo: string;
  nr_votavel: number;
  nm_votavel: string;
  nr_partido: number | null;
  sg_partido: string | null;
  nm_partido: string | null;
}

export interface Partido {
  ano_eleicao: number;
  turno: number;
  cd_cargo: number;
  ds_cargo: string;
  nr_partido: number;
  sg_partido: string;
  nm_partido: string;
}

export type FilterMode = "candidato" | "partido";

// `value` é o nr_votavel (modo candidato) ou nr_partido (modo partido) --
// os dois vivem no mesmo espaço de seleção pra não duplicar toda a lógica de
// zoom/tooltip/camada em dois caminhos separados.
export interface FilterSelection {
  mode: FilterMode;
  ano: number;
  cdCargo: number;
  dsCargo: string;
  turno: number;
  value: number;
  label: string;
}

// Mesmo slug do scripts/build_aggregates.py -- usado só pra montar o caminho
// da partição de seções (`secoes/ano_eleicao=<ano>/cargo_slug=<slug>/turno=<n>/*.parquet`).
export const CARGO_SLUGS: Record<string, string> = {
  Governador: "governador",
  Senador: "senador",
  "Deputado Federal": "deputado-federal",
  "Deputado Estadual": "deputado-estadual",
};

export interface ShareRow {
  votos: number;
  total_validos: number;
  share: number | null;
}

export interface MunicipioShare extends ShareRow {
  cd_municipio_tse: number;
}

export interface MesorregiaoShare extends ShareRow {
  cd_mesorregiao: number;
}

export interface SecaoShare extends ShareRow {
  nr_zona: number;
  nr_local_votacao: number;
  cd_municipio_tse: number;
  latitude: number;
  longitude: number;
  is_approximate: boolean;
}

export async function fetchCandidatos(db: AsyncDuckDB): Promise<Candidato[]> {
  const conn = await db.connect();
  try {
    const result = await conn.query(`
      SELECT ano_eleicao, turno, cd_cargo, ds_cargo, nr_votavel, nm_votavel, nr_partido, sg_partido, nm_partido
      FROM read_parquet('candidatos.parquet')
      ORDER BY ano_eleicao, cd_cargo, turno, nr_votavel
    `);
    return result.toArray().map((row) => rowToPlainObject<Candidato>(row.toJSON()));
  } finally {
    await conn.close();
  }
}

export async function fetchPartidos(db: AsyncDuckDB): Promise<Partido[]> {
  const conn = await db.connect();
  try {
    const result = await conn.query(`
      SELECT ano_eleicao, turno, cd_cargo, ds_cargo, nr_partido, sg_partido, nm_partido
      FROM read_parquet('partidos.parquet')
      ORDER BY ano_eleicao, cd_cargo, turno, sg_partido
    `);
    return result.toArray().map((row) => rowToPlainObject<Partido>(row.toJSON()));
  } finally {
    await conn.close();
  }
}

function aggFileFor(mode: FilterMode, level: "municipio" | "mesorregiao"): string {
  return mode === "partido" ? `agg_${level}_partido.parquet` : `agg_${level}.parquet`;
}

function columnFor(mode: FilterMode): "nr_votavel" | "nr_partido" {
  return mode === "partido" ? "nr_partido" : "nr_votavel";
}

// Votos válidos = todos os votos do cargo/turno na unidade, exceto Voto Branco (95)
// e Voto Nulo (96) -- é o denominador convencional pra "% dos votos válidos" no
// noticiário eleitoral brasileiro. Em modo partido, Branco/Nulo já saem de cara
// (não tem nr_partido) então o filtro NOT IN só importa no modo candidato.
export async function fetchMunicipioShares(
  db: AsyncDuckDB,
  { mode, ano, cdCargo, turno, value }: FilterSelection,
): Promise<MunicipioShare[]> {
  const conn = await db.connect();
  try {
    const file = aggFileFor(mode, "municipio");
    const col = columnFor(mode);
    const excludeBrancoNulo = mode === "candidato" ? "AND nr_votavel NOT IN (95, 96)" : "";
    const stmt = await conn.prepare(`
      WITH totals AS (
        SELECT cd_municipio_tse, SUM(qt_votos) AS total_validos
        FROM read_parquet('${file}')
        WHERE ano_eleicao = ? AND cd_cargo = ? AND turno = ? ${excludeBrancoNulo}
        GROUP BY cd_municipio_tse
      ),
      sel AS (
        SELECT cd_municipio_tse, SUM(qt_votos) AS votos
        FROM read_parquet('${file}')
        WHERE ano_eleicao = ? AND cd_cargo = ? AND turno = ? AND ${col} = ?
        GROUP BY cd_municipio_tse
      )
      SELECT
        t.cd_municipio_tse AS cd_municipio_tse,
        COALESCE(s.votos, 0) AS votos,
        t.total_validos AS total_validos,
        COALESCE(s.votos, 0)::DOUBLE / NULLIF(t.total_validos, 0) AS share
      FROM totals t
      LEFT JOIN sel s USING (cd_municipio_tse)
    `);
    const result = await stmt.query(ano, cdCargo, turno, ano, cdCargo, turno, value);
    return result.toArray().map((row) => rowToPlainObject<MunicipioShare>(row.toJSON()));
  } finally {
    await conn.close();
  }
}

export async function fetchMesorregiaoShares(
  db: AsyncDuckDB,
  { mode, ano, cdCargo, turno, value }: FilterSelection,
): Promise<MesorregiaoShare[]> {
  const conn = await db.connect();
  try {
    const file = aggFileFor(mode, "mesorregiao");
    const col = columnFor(mode);
    const excludeBrancoNulo = mode === "candidato" ? "AND nr_votavel NOT IN (95, 96)" : "";
    const stmt = await conn.prepare(`
      WITH totals AS (
        SELECT cd_mesorregiao, SUM(qt_votos) AS total_validos
        FROM read_parquet('${file}')
        WHERE ano_eleicao = ? AND cd_cargo = ? AND turno = ? ${excludeBrancoNulo}
        GROUP BY cd_mesorregiao
      ),
      sel AS (
        SELECT cd_mesorregiao, SUM(qt_votos) AS votos
        FROM read_parquet('${file}')
        WHERE ano_eleicao = ? AND cd_cargo = ? AND turno = ? AND ${col} = ?
        GROUP BY cd_mesorregiao
      )
      SELECT
        t.cd_mesorregiao AS cd_mesorregiao,
        COALESCE(s.votos, 0) AS votos,
        t.total_validos AS total_validos,
        COALESCE(s.votos, 0)::DOUBLE / NULLIF(t.total_validos, 0) AS share
      FROM totals t
      LEFT JOIN sel s USING (cd_mesorregiao)
    `);
    const result = await stmt.query(ano, cdCargo, turno, ano, cdCargo, turno, value);
    return result.toArray().map((row) => rowToPlainObject<MesorregiaoShare>(row.toJSON()));
  } finally {
    await conn.close();
  }
}

// `secaoFile` é o nome virtual já registrado no DuckDB (ver client.ts) pra
// partição ano/cargo_slug/turno da seleção atual -- o arquivo já vem filtrado por
// ano/cargo/turno pelo particionamento em disco e já tem nr_partido, então tanto
// modo candidato quanto partido usam o mesmo arquivo.
export async function fetchSecaoShares(
  db: AsyncDuckDB,
  secaoFile: string,
  { mode, value }: Pick<FilterSelection, "mode" | "value">,
): Promise<SecaoShare[]> {
  const conn = await db.connect();
  try {
    const col = columnFor(mode);
    const excludeBrancoNulo = mode === "candidato" ? "WHERE nr_votavel NOT IN (95, 96)" : "";
    const stmt = await conn.prepare(`
      WITH totals AS (
        SELECT nr_zona, nr_local_votacao, cd_municipio_tse, latitude, longitude, is_approximate,
               SUM(qt_votos) AS total_validos
        FROM read_parquet('${secaoFile}')
        ${excludeBrancoNulo}
        GROUP BY nr_zona, nr_local_votacao, cd_municipio_tse, latitude, longitude, is_approximate
      ),
      sel AS (
        SELECT nr_zona, nr_local_votacao, cd_municipio_tse, SUM(qt_votos) AS votos
        FROM read_parquet('${secaoFile}')
        WHERE ${col} = ?
        GROUP BY nr_zona, nr_local_votacao, cd_municipio_tse
      )
      SELECT
        t.nr_zona AS nr_zona,
        t.nr_local_votacao AS nr_local_votacao,
        t.cd_municipio_tse AS cd_municipio_tse,
        t.latitude AS latitude,
        t.longitude AS longitude,
        t.is_approximate AS is_approximate,
        COALESCE(s.votos, 0) AS votos,
        t.total_validos AS total_validos,
        COALESCE(s.votos, 0)::DOUBLE / NULLIF(t.total_validos, 0) AS share
      FROM totals t
      LEFT JOIN sel s USING (nr_zona, nr_local_votacao, cd_municipio_tse)
    `);
    const result = await stmt.query(value);
    return result.toArray().map((row) => rowToPlainObject<SecaoShare>(row.toJSON()));
  } finally {
    await conn.close();
  }
}

// --- Comparação 2022 -> 2026 ---------------------------------------------
// `comparacao_candidatos.parquet` (scripts/build_aggregates.py) já traz quem
// concorreu ao MESMO cargo nos dois anos, casado por CPF (o CPF em si não vem
// pro site -- só `id_pessoa`). O número de urna pode ter mudado entre os anos,
// por isso cada ano tem o seu (`nr_2022`/`nr_2026`).
export const ANO_BASE = 2022;
export const ANO_COMPARADO = 2026;

export interface Comparacao {
  id_pessoa: number;
  cd_cargo: number;
  ds_cargo: string;
  nr_2022: number;
  nr_2026: number;
  nome_2022: string;
  nome_2026: string;
  sg_partido_2022: string | null;
  sg_partido_2026: string | null;
  votos_2022: number;
  votos_2026: number;
}

export type ComparacaoMetric = "diff" | "pct";

export interface ComparisonSelection {
  cdCargo: number;
  idPessoa: number;
  metric: ComparacaoMetric;
}

export interface ComparacaoRow {
  cd: number;
  votos_2022: number;
  votos_2026: number;
  diff: number;
  // null quando não teve voto em 2022 (variação % indefinida -- "novo").
  pct: number | null;
}

export async function fetchComparacoes(db: AsyncDuckDB): Promise<Comparacao[]> {
  const conn = await db.connect();
  try {
    const result = await conn.query(`
      SELECT * FROM read_parquet('comparacao_candidatos.parquet') ORDER BY cd_cargo, nome_2026
    `);
    return result.toArray().map((row) => rowToPlainObject<Comparacao>(row.toJSON()));
  } finally {
    await conn.close();
  }
}

// Votos da mesma pessoa nos dois anos por unidade (1º turno vs 1º turno), a
// partir dos agregados que o modo "resultado" já usa. FULL OUTER JOIN: uma
// unidade onde ela só teve voto num dos anos aparece com 0 no outro.
export async function fetchComparacaoRows(
  db: AsyncDuckDB,
  level: "municipio" | "mesorregiao",
  comparacao: Pick<Comparacao, "cd_cargo" | "nr_2022" | "nr_2026">,
): Promise<ComparacaoRow[]> {
  const conn = await db.connect();
  try {
    const key = level === "municipio" ? "cd_municipio_tse" : "cd_mesorregiao";
    const stmt = await conn.prepare(`
      WITH base AS (
        SELECT ${key} AS cd, SUM(qt_votos) AS votos FROM read_parquet('agg_${level}.parquet')
        WHERE ano_eleicao = ${ANO_BASE} AND turno = 1 AND cd_cargo = ? AND nr_votavel = ?
        GROUP BY 1
      ),
      comparado AS (
        SELECT ${key} AS cd, SUM(qt_votos) AS votos FROM read_parquet('agg_${level}.parquet')
        WHERE ano_eleicao = ${ANO_COMPARADO} AND turno = 1 AND cd_cargo = ? AND nr_votavel = ?
        GROUP BY 1
      )
      SELECT
        COALESCE(b.cd, c.cd) AS cd,
        COALESCE(b.votos, 0) AS votos_2022,
        COALESCE(c.votos, 0) AS votos_2026,
        COALESCE(c.votos, 0) - COALESCE(b.votos, 0) AS diff,
        (COALESCE(c.votos, 0) - b.votos)::DOUBLE / NULLIF(b.votos, 0) AS pct
      FROM base b
      FULL OUTER JOIN comparado c ON b.cd = c.cd
    `);
    const { cd_cargo, nr_2022, nr_2026 } = comparacao;
    const result = await stmt.query(cd_cargo, nr_2022, cd_cargo, nr_2026);
    return result.toArray().map((row) => rowToPlainObject<ComparacaoRow>(row.toJSON()));
  } finally {
    await conn.close();
  }
}
