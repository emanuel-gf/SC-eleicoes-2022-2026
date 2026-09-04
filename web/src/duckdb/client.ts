import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

// Bundles servidos localmente pelo Vite (não da jsDelivr) -- mantém o app
// 100% estático/offline-capaz, coerente com a decisão de não ter backend.
const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdbWasmMvp, mainWorker: mvpWorker },
  eh: { mainModule: duckdbWasmEh, mainWorker: ehWorker },
};

const DATA_FILES = [
  "candidatos.parquet",
  "partidos.parquet",
  "agg_municipio.parquet",
  "agg_mesorregiao.parquet",
  "agg_municipio_partido.parquet",
  "agg_mesorregiao_partido.parquet",
];

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function registerParquet(db: duckdb.AsyncDuckDB, name: string) {
  const res = await fetch(`/data/${name}`);
  const buffer = new Uint8Array(await res.arrayBuffer());
  await db.registerFileBuffer(name, buffer);
}

export function getDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
      const worker = new Worker(bundle.mainWorker!);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      await Promise.all(DATA_FILES.map((name) => registerParquet(db, name)));
      return db;
    })();
  }
  return dbPromise;
}

// Partições de seção são carregadas sob demanda (só quando o zoom pede o nível
// de detalhe máximo) e ficam registradas depois -- trocar de candidato dentro
// do mesmo cargo/turno não deveria refazer o fetch.
const registeredSecaoPartitions = new Set<string>();

export async function registerSecaoPartition(
  db: duckdb.AsyncDuckDB,
  cargoSlug: string,
  turno: number,
): Promise<string> {
  const name = `secoes_${cargoSlug}_${turno}.parquet`;
  if (!registeredSecaoPartitions.has(name)) {
    const res = await fetch(`/data/secoes/cargo_slug=${cargoSlug}/turno=${turno}/data_0.parquet`);
    const buffer = new Uint8Array(await res.arrayBuffer());
    await db.registerFileBuffer(name, buffer);
    registeredSecaoPartitions.add(name);
  }
  return name;
}
