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
}

export interface CandidatoSelection {
  cdCargo: number;
  turno: number;
  nrVotavel: number;
}

export interface MunicipioShare {
  cd_municipio_tse: number;
  votos: number;
  total_validos: number;
  share: number | null;
}

export async function fetchCandidatos(db: AsyncDuckDB): Promise<Candidato[]> {
  const conn = await db.connect();
  try {
    const result = await conn.query(`
      SELECT ano_eleicao, turno, cd_cargo, ds_cargo, nr_votavel, nm_votavel
      FROM read_parquet('candidatos.parquet')
      ORDER BY cd_cargo, turno, nr_votavel
    `);
    return result.toArray().map((row) => rowToPlainObject<Candidato>(row.toJSON()));
  } finally {
    await conn.close();
  }
}

// Votos válidos = todos os votos do cargo/turno na unidade, exceto Voto Branco (95)
// e Voto Nulo (96) -- é o denominador convencional pra "% dos votos válidos" no
// noticiário eleitoral brasileiro.
export async function fetchMunicipioShares(
  db: AsyncDuckDB,
  { cdCargo, turno, nrVotavel }: CandidatoSelection,
): Promise<MunicipioShare[]> {
  const conn = await db.connect();
  try {
    const stmt = await conn.prepare(`
      WITH totals AS (
        SELECT cd_municipio_tse, SUM(qt_votos) AS total_validos
        FROM read_parquet('agg_municipio.parquet')
        WHERE cd_cargo = ? AND turno = ? AND nr_votavel NOT IN (95, 96)
        GROUP BY cd_municipio_tse
      ),
      cand AS (
        SELECT cd_municipio_tse, SUM(qt_votos) AS votos
        FROM read_parquet('agg_municipio.parquet')
        WHERE cd_cargo = ? AND turno = ? AND nr_votavel = ?
        GROUP BY cd_municipio_tse
      )
      SELECT
        t.cd_municipio_tse AS cd_municipio_tse,
        COALESCE(c.votos, 0) AS votos,
        t.total_validos AS total_validos,
        COALESCE(c.votos, 0)::DOUBLE / NULLIF(t.total_validos, 0) AS share
      FROM totals t
      LEFT JOIN cand c USING (cd_municipio_tse)
    `);
    const result = await stmt.query(cdCargo, turno, cdCargo, turno, nrVotavel);
    return result.toArray().map((row) => rowToPlainObject<MunicipioShare>(row.toJSON()));
  } finally {
    await conn.close();
  }
}
