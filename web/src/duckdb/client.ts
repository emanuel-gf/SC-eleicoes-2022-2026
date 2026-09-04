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

const DATA_FILES = ["candidatos.parquet", "agg_municipio.parquet", "agg_mesorregiao.parquet"];

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
