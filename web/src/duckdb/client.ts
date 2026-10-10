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
  "comparacao_candidatos.parquet",
];

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

// Falha alto se o arquivo não vier -- sem isso um 404 (que o dev server do
// Vite responde com HTML) seria registrado como "parquet" e só quebraria
// depois, numa query, com um erro bem menos óbvio.
async function fetchData(path: string): Promise<Uint8Array> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`falha ao baixar ${path} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function registerParquet(db: duckdb.AsyncDuckDB, name: string) {
  const buffer = await fetchData(`/data/${name}`);
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
      // O suporte a parquet do DuckDB-WASM é uma extensão baixada em runtime
      // -- por padrão de extensions.duckdb.org, que é lento/instável (já
      // falhou ou levou >10s) e travava o carregamento inteiro do app. Servimos
      // a extensão junto com o site (public/duckdb-extensions/<versão>/<wasm_eh|wasm_mvp>/)
      // e carregamos já aqui, pra qualquer falha aparecer no init.
      const conn = await db.connect();
      try {
        await conn.query(`SET custom_extension_repository = '${window.location.origin}/duckdb-extensions'`);
        await conn.query("LOAD parquet");
      } finally {
        await conn.close();
      }
      await Promise.all(DATA_FILES.map((name) => registerParquet(db, name)));
      return db;
    })();
    // Init que falhou não fica em cache -- a próxima chamada tenta de novo.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

// Partições de seção são carregadas sob demanda (só quando o zoom pede o nível
// de detalhe máximo) e ficam registradas depois -- trocar de candidato dentro
// do mesmo ano/cargo/turno não deveria refazer o fetch.
const registeredSecaoPartitions = new Set<string>();

export async function registerSecaoPartition(
  db: duckdb.AsyncDuckDB,
  ano: number,
  cargoSlug: string,
  turno: number,
): Promise<string> {
  const name = `secoes_${ano}_${cargoSlug}_${turno}.parquet`;
  if (!registeredSecaoPartitions.has(name)) {
    const buffer = await fetchData(`/data/secoes/ano_eleicao=${ano}/cargo_slug=${cargoSlug}/turno=${turno}/data_0.parquet`);
    await db.registerFileBuffer(name, buffer);
    registeredSecaoPartitions.add(name);
  }
  return name;
}
