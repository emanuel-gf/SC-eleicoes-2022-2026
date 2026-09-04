"""Milestone 2: pré-agregação via DuckDB dos parquets que o frontend vai consumir.

Lê `votacao_secao_2022_SC_geolocated.parquet` + os lookups do milestone 1
(`data/lookup/`) e produz em `web/public/data/` (ver PLAN.md):

    candidatos.parquet
    agg_mesorregiao.parquet
    agg_municipio.parquet
    secoes/cargo=<slug>/turno=<n>/part.parquet

Run:
    uv run python scripts/build_aggregates.py
"""

from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_PARQUET = REPO_ROOT / "tse_data_manipulation" / "votacao_secao_2022_SC_geolocated.parquet"
LOOKUP_DIR = REPO_ROOT / "data" / "lookup"
OUT_DIR = REPO_ROOT / "web" / "public" / "data"

# Slug estável pra nome de partição/pasta -- não usar DS_CARGO cru (tem espaço/acento).
CARGO_SLUGS = {
    "Governador": "governador",
    "Senador": "senador",
    "Deputado Federal": "deputado-federal",
    "Deputado Estadual": "deputado-estadual",
}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    cargo_case = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in CARGO_SLUGS.items())

    con.execute(f"""
        CREATE VIEW votos AS
        SELECT
            ANO_ELEICAO AS ano_eleicao,
            NR_TURNO AS turno,
            CD_CARGO AS cd_cargo,
            DS_CARGO AS ds_cargo,
            CASE DS_CARGO {cargo_case} END AS cargo_slug,
            NR_VOTAVEL AS nr_votavel,
            NM_VOTAVEL AS nm_votavel,
            CD_MUNICIPIO AS cd_municipio_tse,
            NR_ZONA AS nr_zona,
            NR_LOCAL_VOTACAO AS nr_local_votacao,
            LATITUDE AS latitude,
            LONGITUDE AS longitude,
            IS_APPROXIMATE AS is_approximate,
            QT_VOTOS AS qt_votos
        FROM read_parquet('{SOURCE_PARQUET.as_posix()}')
    """)

    n_rows, n_cargo_null = con.execute(
        "SELECT count(*), count(*) FILTER (cargo_slug IS NULL) FROM votos"
    ).fetchone()
    assert n_cargo_null == 0, f"{n_cargo_null} linhas com DS_CARGO fora do CARGO_SLUGS conhecido"
    print(f"Fonte: {n_rows} linhas, todos os cargos mapeados pra slug.")

    # --- 1. dimensão de candidatos ---
    con.execute(f"""
        COPY (
            SELECT DISTINCT ano_eleicao, turno, cd_cargo, ds_cargo, nr_votavel, nm_votavel
            FROM votos
            ORDER BY cd_cargo, turno, nr_votavel
        ) TO '{(OUT_DIR / "candidatos.parquet").as_posix()}' (FORMAT PARQUET)
    """)

    # --- 2. agregado por município (chave: TSE) ---
    con.execute(f"""
        COPY (
            SELECT ano_eleicao, turno, cd_cargo, nr_votavel, cd_municipio_tse, SUM(qt_votos) AS qt_votos
            FROM votos
            GROUP BY ALL
        ) TO '{(OUT_DIR / "agg_municipio.parquet").as_posix()}' (FORMAT PARQUET)
    """)

    # --- 3. agregado por mesorregião (via TSE -> IBGE -> mesorregião) ---
    con.execute(f"""
        COPY (
            SELECT v.ano_eleicao, v.turno, v.cd_cargo, v.nr_votavel, mr.cd_mesorregiao, SUM(v.qt_votos) AS qt_votos
            FROM votos v
            JOIN read_csv_auto('{(LOOKUP_DIR / "municipio_tse_ibge.csv").as_posix()}') tse
                ON v.cd_municipio_tse = tse.cd_municipio_tse
            JOIN read_csv_auto('{(LOOKUP_DIR / "municipio_mesorregiao.csv").as_posix()}') mr
                ON tse.cd_municipio_ibge = mr.cd_municipio_ibge
            GROUP BY ALL
        ) TO '{(OUT_DIR / "agg_mesorregiao.parquet").as_posix()}' (FORMAT PARQUET)
    """)

    # --- 4. ponto exato (seção), particionado por cargo/turno ---
    # Group by inclui lat/lon direto (em vez de só zona+local) pra não quebrar nos
    # poucos casos (6 de 3488) em que o mesmo numero de local aparece com endereços
    # diferentes dentro da mesma zona -- viram pontos distintos, o que é o correto.
    secoes_dir = OUT_DIR / "secoes"
    con.execute(f"""
        COPY (
            SELECT
                cargo_slug, turno, nr_votavel, nm_votavel, nr_zona, nr_local_votacao,
                cd_municipio_tse, latitude, longitude, is_approximate,
                SUM(qt_votos) AS qt_votos
            FROM votos
            GROUP BY ALL
        ) TO '{secoes_dir.as_posix()}' (
            FORMAT PARQUET, PARTITION_BY (cargo_slug, turno), OVERWRITE_OR_IGNORE 1
        )
    """)

    # --- validação: soma de votos bate entre agregados e a fonte, pra candidatos conhecidos ---
    checks = [
        ("Governador", 22, "JORGINHO DOS SANTOS MELLO"),
        ("Governador", 11, "ESPERIDIÃO AMIN HELOU FILHO"),
        ("Governador", 95, "VOTO BRANCO"),
        ("Governador", 96, "VOTO NULO"),
        ("Senador", 222, "JORGE SEIF JUNIOR"),
    ]
    for cargo, nr, _label in checks:
        raw = con.execute(
            "SELECT SUM(qt_votos) FROM votos WHERE ds_cargo = ? AND nr_votavel = ?", [cargo, nr]
        ).fetchone()[0]
        by_muni = con.execute(
            f"""
            SELECT SUM(qt_votos) FROM read_parquet('{(OUT_DIR / "agg_municipio.parquet").as_posix()}') am
            JOIN (SELECT DISTINCT cd_cargo, ds_cargo FROM votos) c USING (cd_cargo)
            WHERE c.ds_cargo = ? AND am.nr_votavel = ?
            """,
            [cargo, nr],
        ).fetchone()[0]
        by_meso = con.execute(
            f"""
            SELECT SUM(qt_votos) FROM read_parquet('{(OUT_DIR / "agg_mesorregiao.parquet").as_posix()}') ar
            JOIN (SELECT DISTINCT cd_cargo, ds_cargo FROM votos) c USING (cd_cargo)
            WHERE c.ds_cargo = ? AND ar.nr_votavel = ?
            """,
            [cargo, nr],
        ).fetchone()[0]
        by_secoes = con.execute(
            f"""
            SELECT SUM(qt_votos) FROM read_parquet('{secoes_dir.as_posix()}/**/*.parquet', hive_partitioning=1) s
            WHERE s.cargo_slug = ? AND s.nr_votavel = ?
            """,
            [CARGO_SLUGS[cargo], nr],
        ).fetchone()[0]
        assert raw == by_muni == by_meso == by_secoes, (
            f"{cargo} nº{nr}: raw={raw} municipio={by_muni} mesorregiao={by_meso} secoes={by_secoes}"
        )
        print(f"  OK {cargo} nº{nr}: {raw} votos (bate em todos os agregados)")

    print("\nMilestone 2 completo. Arquivos em", OUT_DIR)


if __name__ == "__main__":
    main()
