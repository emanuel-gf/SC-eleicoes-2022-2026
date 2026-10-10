"""Converte o CSV de votação por seção de um ano novo (ex. 2026) em parquet e
geocodifica os locais de votação, produzindo o mesmo formato do
`votacao_secao_2022_SC_geolocated.parquet` (colunas originais do TSE +
LATITUDE, LONGITUDE, IS_APPROXIMATE) que o `build_aggregates.py` consome.

Em 2022 isso foi feito no `intro.ipynb` (Nominatim -> Photon -> Google). Aqui
o processo é o mesmo, só que como script reprodutível e reaproveitando o que
já foi geocodificado em 2022 -- a maioria dos locais de votação (escolas) não
muda entre eleições:

    1. reaproveita a coordenada de 2022 quando o local bate por município +
       endereço, ou município + nome do local;
    2. o que sobrar vai pro Nominatim (endereço), depois Photon (endereço),
       depois Google (nome do local) -- se tiver GOOGLE_MAPS_API no .env;
    3. todo geocode novo precisa cair dentro (ou bem perto) do polígono do
       próprio município -- isso barra o problema de 2022 em que nomes de rua
       genéricos ("Rua Geral") iam parar em outro estado;
    4. o que nenhum geocoder resolver cai no centroide do município, marcado
       com IS_APPROXIMATE = true (mesma convenção de 2022).

Os geocodes novos ficam em cache (`enderecos_geocoded_<ano>.parquet`), então
rodar de novo não refaz chamadas de rede.

Run:
    uv run python scripts/build_geolocated.py 2026
"""

import os
import sys
from pathlib import Path

import duckdb
import geopandas as gpd
import pandas as pd
from dotenv import load_dotenv
from geopy.extra.rate_limiter import RateLimiter
from geopy.geocoders import GoogleV3, Nominatim, Photon
from shapely.geometry import Point
from tqdm import tqdm

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "tse_data_manipulation"
REFERENCE_GEOLOCATED = DATA_DIR / "votacao_secao_2022_SC_geolocated.parquet"
MUNICIPIOS_GEOJSON = REPO_ROOT / "data" / "geo" / "sc_municipios.geojson"

USER_AGENT = "tse-eleicao-geocoder (emanuelgoulartf@gmail.com)"

# ~2km em graus -- tolerância pra local de votação na divisa do município (o
# polígono do geobr é simplificado, e escola de beira de divisa existe).
MUNICIPIO_BUFFER_DEG = 0.02

LOCAL_COLS = [
    "CD_MUNICIPIO", "NM_MUNICIPIO", "NR_ZONA", "NR_LOCAL_VOTACAO",
    "NM_LOCAL_VOTACAO", "DS_LOCAL_VOTACAO_ENDERECO",
]


def convert_csv_to_parquet(con: duckdb.DuckDBPyConnection, csv_path: Path, parquet_path: Path) -> None:
    # Datas/hora como texto -- mesmo tipo do parquet de 2022 (lá o pandas leu
    # tudo como string), pra não ter schema diferente entre os anos.
    con.execute(f"""
        COPY (
            SELECT * FROM read_csv(
                '{csv_path.as_posix()}', delim=';', encoding='latin-1', header=true,
                types={{'DT_GERACAO': 'VARCHAR', 'HH_GERACAO': 'VARCHAR', 'DT_ELEICAO': 'VARCHAR'}}
            )
        ) TO '{parquet_path.as_posix()}' (FORMAT PARQUET)
    """)


def match_reference_coords(con: duckdb.DuckDBPyConnection, parquet_path: Path) -> pd.DataFrame:
    """Um registro por local de votação do ano novo, com a coordenada de 2022
    quando dá pra casar (prioridade: zona+local+endereço, endereço, nome)."""
    cols = ", ".join(LOCAL_COLS)
    con.execute(f"CREATE OR REPLACE TABLE locais AS SELECT DISTINCT {cols} FROM read_parquet('{parquet_path.as_posix()}')")
    con.execute(f"""
        CREATE OR REPLACE TABLE ref AS
        SELECT DISTINCT {cols}, LATITUDE, LONGITUDE, IS_APPROXIMATE
        FROM read_parquet('{REFERENCE_GEOLOCATED.as_posix()}')
    """)
    # Pra cada critério, se o mesmo endereço/nome tiver mais de uma coordenada
    # em 2022 (raro), prefere a não-aproximada.
    return con.execute("""
        WITH candidatos AS (
            SELECT l.*, r.LATITUDE, r.LONGITUDE, r.IS_APPROXIMATE, 1 AS prioridade
            FROM locais l JOIN ref r USING (CD_MUNICIPIO, NR_ZONA, NR_LOCAL_VOTACAO, DS_LOCAL_VOTACAO_ENDERECO)
            UNION ALL
            SELECT l.*, r.LATITUDE, r.LONGITUDE, r.IS_APPROXIMATE, 2
            FROM locais l JOIN ref r USING (CD_MUNICIPIO, DS_LOCAL_VOTACAO_ENDERECO)
            UNION ALL
            SELECT l.*, r.LATITUDE, r.LONGITUDE, r.IS_APPROXIMATE, 3
            FROM locais l JOIN ref r USING (CD_MUNICIPIO, NM_LOCAL_VOTACAO)
        ),
        melhor AS (
            SELECT * FROM candidatos
            QUALIFY row_number() OVER (
                PARTITION BY CD_MUNICIPIO, NR_ZONA, NR_LOCAL_VOTACAO, NM_LOCAL_VOTACAO, DS_LOCAL_VOTACAO_ENDERECO
                ORDER BY prioridade, IS_APPROXIMATE
            ) = 1
        )
        SELECT l.*, m.LATITUDE, m.LONGITUDE, m.IS_APPROXIMATE,
               CASE WHEN m.LATITUDE IS NOT NULL THEN 'reuso_2022' END AS GEOCODE_FONTE
        FROM locais l
        LEFT JOIN melhor m USING (CD_MUNICIPIO, NR_ZONA, NR_LOCAL_VOTACAO, NM_LOCAL_VOTACAO, DS_LOCAL_VOTACAO_ENDERECO)
    """).df()


def load_municipio_shapes() -> dict[int, object]:
    gdf = gpd.read_file(MUNICIPIOS_GEOJSON)
    return {int(row.cd_municipio_tse): row.geometry for row in gdf.itertuples()}


def build_geocoders() -> list[tuple[str, str, object]]:
    """(nome, coluna da query, função geocode) -- na ordem em que são tentados."""
    geocoders = [
        ("nominatim", "query_endereco", RateLimiter(
            Nominatim(user_agent=USER_AGENT, timeout=15).geocode,
            min_delay_seconds=1, max_retries=2, error_wait_seconds=5, swallow_exceptions=True,
        )),
        ("photon", "query_endereco", RateLimiter(
            Photon(user_agent=USER_AGENT, timeout=15).geocode,
            min_delay_seconds=1.5, max_retries=3, error_wait_seconds=8, swallow_exceptions=True,
        )),
    ]
    load_dotenv(REPO_ROOT / ".env")
    google_key = os.environ.get("GOOGLE_MAPS_API")
    if google_key:
        # Google por nome do local (escola), como no notebook de 2022 -- foi o
        # que resolveu os casos que o OSM não tem cadastrado.
        geocoders.append(("google", "query_escola", RateLimiter(
            GoogleV3(api_key=google_key, timeout=15).geocode,
            min_delay_seconds=0.2, max_retries=2, error_wait_seconds=5, swallow_exceptions=True,
        )))
    else:
        print("  (sem GOOGLE_MAPS_API no .env -- pulando Google)")
    return geocoders


def geocode_missing(faltando: pd.DataFrame, cache_path: Path, shapes: dict[int, object]) -> pd.DataFrame:
    """Geocodifica endereços únicos sem coordenada. Retorna uma linha por
    (CD_MUNICIPIO, DS_LOCAL_VOTACAO_ENDERECO, NM_LOCAL_VOTACAO) com LATITUDE,
    LONGITUDE, GEOCODE_FONTE (NULL se nenhum geocoder acertou dentro do município)."""
    key = ["CD_MUNICIPIO", "DS_LOCAL_VOTACAO_ENDERECO", "NM_LOCAL_VOTACAO"]
    unicos = faltando[key + ["NM_MUNICIPIO"]].drop_duplicates(subset=key).reset_index(drop=True)

    if cache_path.exists():
        cache = pd.read_parquet(cache_path)
    else:
        cache = pd.DataFrame(columns=key + ["LATITUDE", "LONGITUDE", "GEOCODE_FONTE"])
    pendentes = unicos.merge(cache[key], on=key, how="left", indicator=True)
    pendentes = pendentes.loc[pendentes["_merge"] == "left_only", key + ["NM_MUNICIPIO"]]
    print(f"  {len(unicos)} endereços únicos sem coordenada; {len(unicos) - len(pendentes)} já no cache, "
          f"{len(pendentes)} pra geocodificar")

    if len(pendentes):
        pendentes = pendentes.copy()
        pendentes["query_endereco"] = (
            pendentes["DS_LOCAL_VOTACAO_ENDERECO"].fillna("").str.strip() + ", "
            + pendentes["NM_MUNICIPIO"].str.strip() + ", SC, Brasil"
        )
        pendentes["query_escola"] = (
            pendentes["NM_LOCAL_VOTACAO"].fillna("").str.strip() + ", "
            + pendentes["NM_MUNICIPIO"].str.strip() + ", SC"
        )
        geocoders = build_geocoders()
        novos = []
        rejeitados = 0
        for row in tqdm(pendentes.itertuples(index=False), total=len(pendentes)):
            area = shapes[int(row.CD_MUNICIPIO)].buffer(MUNICIPIO_BUFFER_DEG)
            result = {k: getattr(row, k) for k in key} | {"LATITUDE": None, "LONGITUDE": None, "GEOCODE_FONTE": None}
            for nome, query_col, geocode in geocoders:
                loc = geocode(getattr(row, query_col))
                if loc is None:
                    continue
                if not area.contains(Point(loc.longitude, loc.latitude)):
                    rejeitados += 1
                    continue
                result |= {"LATITUDE": loc.latitude, "LONGITUDE": loc.longitude, "GEOCODE_FONTE": nome}
                break
            novos.append(result)
        print(f"  {rejeitados} resultados de geocoder rejeitados por cair fora do município")
        cache = pd.concat([cache, pd.DataFrame(novos)], ignore_index=True)
        cache.to_parquet(cache_path, index=False)
    return cache


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("uso: uv run python scripts/build_geolocated.py <ano>")
    ano = int(sys.argv[1])
    ano_dir = DATA_DIR / str(ano)
    csv_path = ano_dir / f"votacao_secao_{ano}_SC.csv"
    parquet_path = ano_dir / f"votacao_secao_{ano}_SC.parquet"
    geolocated_path = ano_dir / f"votacao_secao_{ano}_SC_geolocated.parquet"
    cache_path = ano_dir / f"enderecos_geocoded_{ano}.parquet"

    con = duckdb.connect()

    if not parquet_path.exists():
        print(f"Convertendo {csv_path.name} -> {parquet_path.name}...")
        convert_csv_to_parquet(con, csv_path, parquet_path)
    n_csv = con.execute(f"SELECT count(*) FROM read_parquet('{parquet_path.as_posix()}')").fetchone()[0]
    print(f"  {n_csv} linhas em {parquet_path.name}")

    print("Casando locais de votação com as coordenadas de 2022...")
    locais = match_reference_coords(con, parquet_path)
    shapes = load_municipio_shapes()

    # O geocode de 2022 não tinha a checagem de município: ~4% dos locais de lá
    # caíram fora do próprio município (até 500km, endereço genérico tipo
    # "ESTRADA GERAL, S/N" casando com rua homônima em outro lugar). Esses não
    # são reaproveitados -- voltam pra fila de geocode, com a checagem.
    fora_ref = [
        r.Index for r in locais.itertuples()
        if pd.notna(r.LATITUDE)
        and not shapes[int(r.CD_MUNICIPIO)].buffer(MUNICIPIO_BUFFER_DEG).contains(Point(r.LONGITUDE, r.LATITUDE))
    ]
    locais.loc[fora_ref, ["LATITUDE", "LONGITUDE", "IS_APPROXIMATE", "GEOCODE_FONTE"]] = None
    reuso = locais["LATITUDE"].notna().sum()
    print(f"  {len(locais)} locais de votação; {reuso} reaproveitados de 2022 "
          f"({len(fora_ref)} descartados por estarem fora do município em 2022)")

    faltando = locais.loc[locais["LATITUDE"].isna()]
    if len(faltando):
        print("Geocodificando o que sobrou...")
        geocoded = geocode_missing(faltando, cache_path, shapes)
        key = ["CD_MUNICIPIO", "DS_LOCAL_VOTACAO_ENDERECO", "NM_LOCAL_VOTACAO"]
        locais = locais.merge(geocoded, on=key, how="left", suffixes=("", "_geo"))
        for col in ["LATITUDE", "LONGITUDE", "GEOCODE_FONTE"]:
            locais[col] = locais[col].combine_first(locais[f"{col}_geo"])
        locais = locais.drop(columns=[f"{c}_geo" for c in ["LATITUDE", "LONGITUDE", "GEOCODE_FONTE"]])
        locais.loc[locais["GEOCODE_FONTE"].isin(["nominatim", "photon", "google"]), "IS_APPROXIMATE"] = False

    # --- fallback: centroide do município ---
    sem_coord = locais["LATITUDE"].isna()
    if sem_coord.any():
        centroides = {cd: geom.representative_point() for cd, geom in shapes.items()}
        locais.loc[sem_coord, "LATITUDE"] = locais.loc[sem_coord, "CD_MUNICIPIO"].map(lambda cd: centroides[int(cd)].y)
        locais.loc[sem_coord, "LONGITUDE"] = locais.loc[sem_coord, "CD_MUNICIPIO"].map(lambda cd: centroides[int(cd)].x)
        locais.loc[sem_coord, "IS_APPROXIMATE"] = True
        locais.loc[sem_coord, "GEOCODE_FONTE"] = "centroide_municipio"
    locais["IS_APPROXIMATE"] = locais["IS_APPROXIMATE"].astype(bool)

    print("\nOrigem da coordenada por local de votação:")
    print(locais["GEOCODE_FONTE"].value_counts().to_string())

    # --- validação: toda coordenada (inclusive as reaproveitadas) dentro do município ---
    fora = [
        r for r in locais.itertuples()
        if not shapes[int(r.CD_MUNICIPIO)].buffer(MUNICIPIO_BUFFER_DEG).contains(Point(r.LONGITUDE, r.LATITUDE))
    ]
    if fora:
        print(f"  AVISO: {len(fora)} locais com coordenada fora do próprio município:")
        for r in fora[:10]:
            print(f"    {r.NM_MUNICIPIO} | {r.NM_LOCAL_VOTACAO} | {r.GEOCODE_FONTE}")
    else:
        print("  OK: todos os locais caem dentro do próprio município")

    # --- junta coordenada em cada linha de voto e salva ---
    con.register("locais_geo", locais)
    con.execute(f"""
        COPY (
            SELECT v.*, g.LATITUDE, g.LONGITUDE, g.IS_APPROXIMATE
            FROM read_parquet('{parquet_path.as_posix()}') v
            JOIN locais_geo g USING (CD_MUNICIPIO, NR_ZONA, NR_LOCAL_VOTACAO, NM_LOCAL_VOTACAO, DS_LOCAL_VOTACAO_ENDERECO)
        ) TO '{geolocated_path.as_posix()}' (FORMAT PARQUET)
    """)
    n_geo, n_null = con.execute(
        f"SELECT count(*), count(*) FILTER (LATITUDE IS NULL) FROM read_parquet('{geolocated_path.as_posix()}')"
    ).fetchone()
    assert n_geo == n_csv, f"join perdeu/duplicou linhas: {n_csv} no CSV vs {n_geo} geolocalizadas"
    assert n_null == 0, f"{n_null} linhas sem coordenada"
    print(f"\nSalvo {geolocated_path} ({n_geo} linhas, 100% com coordenada)")


if __name__ == "__main__":
    main()
