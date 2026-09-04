"""Milestone 2 (+ pedido de partido): pré-agregação via DuckDB dos parquets que
o frontend vai consumir.

Lê `votacao_secao_2022_SC_geolocated.parquet` + os lookups do milestone 1
(`data/lookup/`) + o arquivo de candidatos por município/zona do TSE (que traz
o partido de cada um) e produz em `web/public/data/` (ver PLAN.md):

    candidatos.parquet          (só candidatos de verdade + Branco/Nulo)
    partidos.parquet            (partidos distintos por cargo/turno)
    agg_mesorregiao.parquet
    agg_municipio.parquet
    agg_mesorregiao_partido.parquet
    agg_municipio_partido.parquet
    secoes/cargo=<slug>/turno=<n>/part.parquet   (já vem com nr_partido)

Run:
    uv run python scripts/build_aggregates.py
"""

from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_PARQUET = REPO_ROOT / "tse_data_manipulation" / "votacao_secao_2022_SC_geolocated.parquet"
CANDIDATO_MUNZONA_CSV = REPO_ROOT / "tse_data_manipulation" / "votacao_candidato_munzona_2022_SC.csv"
LOOKUP_DIR = REPO_ROOT / "data" / "lookup"
OUT_DIR = REPO_ROOT / "web" / "public" / "data"

# Slug estável pra nome de partição/pasta -- não usar DS_CARGO cru (tem espaço/acento).
CARGO_SLUGS = {
    "Governador": "governador",
    "Senador": "senador",
    "Deputado Federal": "deputado-federal",
    "Deputado Estadual": "deputado-estadual",
}

# Voto Branco/Nulo não tem partido -- fica de fora dos joins de partido.
PSEUDO_CANDIDATOS = (95, 96)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    cargo_case = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in CARGO_SLUGS.items())

    con.execute(f"""
        CREATE VIEW votos_base AS
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
        "SELECT count(*), count(*) FILTER (cargo_slug IS NULL) FROM votos_base"
    ).fetchone()
    assert n_cargo_null == 0, f"{n_cargo_null} linhas com DS_CARGO fora do CARGO_SLUGS conhecido"
    print(f"Fonte: {n_rows} linhas, todos os cargos mapeados pra slug.")

    # --- lookup de partido a partir do arquivo de candidatos por município/zona ---
    # Duas tabelas: uma por candidato de verdade (NR_CANDIDATO -> partido) e uma só
    # por partido (cobre "voto de legenda", onde NR_VOTAVEL É o número do partido,
    # sem candidato específico -- só existe em cargos proporcionais).
    con.execute(f"""
        CREATE VIEW candidato_partido AS
        SELECT DISTINCT CD_CARGO AS cd_cargo, NR_CANDIDATO AS nr_votavel,
               NR_PARTIDO AS nr_partido, SG_PARTIDO AS sg_partido, NM_PARTIDO AS nm_partido
        FROM read_csv('{CANDIDATO_MUNZONA_CSV.as_posix()}', delim=';', encoding='latin-1', header=true)
    """)
    con.execute("""
        CREATE VIEW partido_nome AS
        SELECT DISTINCT cd_cargo, nr_partido, sg_partido, nm_partido FROM candidato_partido
    """)

    dupe = con.execute("""
        SELECT cd_cargo, nr_votavel, count(DISTINCT sg_partido)
        FROM candidato_partido GROUP BY ALL HAVING count(DISTINCT sg_partido) > 1
    """).fetchall()
    assert not dupe, f"candidato com mais de um partido pro mesmo número: {dupe}"

    # --- junta partido em cada linha de voto (candidato primeiro, depois legenda) ---
    con.execute("""
        CREATE VIEW votos AS
        SELECT
            v.*,
            COALESCE(cp.nr_partido, pn.nr_partido) AS nr_partido,
            COALESCE(cp.sg_partido, pn.sg_partido) AS sg_partido,
            COALESCE(cp.nm_partido, pn.nm_partido) AS nm_partido
        FROM votos_base v
        LEFT JOIN candidato_partido cp ON v.cd_cargo = cp.cd_cargo AND v.nr_votavel = cp.nr_votavel
        LEFT JOIN partido_nome pn ON v.cd_cargo = pn.cd_cargo AND v.nr_votavel = pn.nr_partido
    """)

    # Uma fração muito pequena de números votáveis não aparece no arquivo de
    # candidatos por município/zona (provavelmente candidatura cassada/indeferida
    # depois da urna já impressa) -- não dá pra saber o partido desses. Fica como
    # aviso, não erro: o voto continua contando nos agregados totais (denominador
    # de "% de votos válidos"), só não vira um candidato/partido selecionável.
    votos_sem_partido, linhas_sem_partido = con.execute(
        f"""
        SELECT SUM(qt_votos), count(*) FROM votos
        WHERE nr_partido IS NULL AND nr_votavel NOT IN {PSEUDO_CANDIDATOS}
        """
    ).fetchone()
    if linhas_sem_partido:
        pct = 100 * votos_sem_partido / n_rows
        print(
            f"  AVISO: {linhas_sem_partido} linhas ({votos_sem_partido} votos, "
            f"{pct:.3f}% do total) com número votável sem partido resolvido "
            "-- provavelmente candidatura cassada/indeferida; ficam fora do dropdown "
            "de candidato/partido mas continuam contando no total de votos válidos."
        )
    else:
        print("  OK: todo voto (exceto Branco/Nulo) tem partido resolvido")

    # --- 1. dimensão de candidatos (só gente de verdade + Branco/Nulo, sem legenda) ---
    con.execute(f"""
        COPY (
            SELECT DISTINCT v.ano_eleicao, v.turno, v.cd_cargo, v.ds_cargo, v.nr_votavel, v.nm_votavel,
                   v.nr_partido, v.sg_partido, v.nm_partido
            FROM votos v
            WHERE v.nr_votavel IN {PSEUDO_CANDIDATOS}
               OR EXISTS (
                    SELECT 1 FROM candidato_partido cp
                    WHERE cp.cd_cargo = v.cd_cargo AND cp.nr_votavel = v.nr_votavel
               )
            ORDER BY cd_cargo, turno, nr_votavel
        ) TO '{(OUT_DIR / "candidatos.parquet").as_posix()}' (FORMAT PARQUET)
    """)

    # --- 1b. dimensão de partidos (pra segunda dropdown) ---
    con.execute(f"""
        COPY (
            SELECT DISTINCT ano_eleicao, turno, cd_cargo, ds_cargo, nr_partido, sg_partido, nm_partido
            FROM votos
            WHERE nr_partido IS NOT NULL
            ORDER BY cd_cargo, turno, sg_partido
        ) TO '{(OUT_DIR / "partidos.parquet").as_posix()}' (FORMAT PARQUET)
    """)

    # --- 2. agregado por município (chave: TSE), por candidato e por partido ---
    con.execute(f"""
        COPY (
            SELECT ano_eleicao, turno, cd_cargo, nr_votavel, cd_municipio_tse, SUM(qt_votos) AS qt_votos
            FROM votos
            GROUP BY ALL
        ) TO '{(OUT_DIR / "agg_municipio.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    con.execute(f"""
        COPY (
            SELECT ano_eleicao, turno, cd_cargo, nr_partido, cd_municipio_tse, SUM(qt_votos) AS qt_votos
            FROM votos
            WHERE nr_partido IS NOT NULL
            GROUP BY ALL
        ) TO '{(OUT_DIR / "agg_municipio_partido.parquet").as_posix()}' (FORMAT PARQUET)
    """)

    # --- 3. agregado por mesorregião (via TSE -> IBGE -> mesorregião), candidato e partido ---
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
    con.execute(f"""
        COPY (
            SELECT v.ano_eleicao, v.turno, v.cd_cargo, v.nr_partido, mr.cd_mesorregiao, SUM(v.qt_votos) AS qt_votos
            FROM votos v
            JOIN read_csv_auto('{(LOOKUP_DIR / "municipio_tse_ibge.csv").as_posix()}') tse
                ON v.cd_municipio_tse = tse.cd_municipio_tse
            JOIN read_csv_auto('{(LOOKUP_DIR / "municipio_mesorregiao.csv").as_posix()}') mr
                ON tse.cd_municipio_ibge = mr.cd_municipio_ibge
            WHERE v.nr_partido IS NOT NULL
            GROUP BY ALL
        ) TO '{(OUT_DIR / "agg_mesorregiao_partido.parquet").as_posix()}' (FORMAT PARQUET)
    """)

    # --- 4. ponto exato (seção), particionado por cargo/turno -- já com nr_partido,
    # pra dar pra agregar por partido no cliente sem precisar de outro arquivo ---
    # Group by inclui lat/lon direto (em vez de só zona+local) pra não quebrar nos
    # poucos casos (6 de 3488) em que o mesmo numero de local aparece com endereços
    # diferentes dentro da mesma zona -- viram pontos distintos, o que é o correto.
    secoes_dir = OUT_DIR / "secoes"
    con.execute(f"""
        COPY (
            SELECT
                cargo_slug, turno, nr_votavel, nm_votavel, nr_partido, sg_partido,
                nr_zona, nr_local_votacao, cd_municipio_tse, latitude, longitude, is_approximate,
                SUM(qt_votos) AS qt_votos
            FROM votos
            GROUP BY ALL
        ) TO '{secoes_dir.as_posix()}' (
            FORMAT PARQUET, PARTITION_BY (cargo_slug, turno), OVERWRITE_OR_IGNORE 1
        )
    """)

    # --- validação: soma de votos bate entre agregados e a fonte, pra candidatos e partidos conhecidos ---
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

    # --- validação de partido: soma de PL no governo (só tem 1 candidato, JORGINHO) ---
    # tem que bater com o total do candidato; e pra deputado, soma do partido tem
    # que ser >= soma de qualquer candidato individual dele (tem legenda também).
    party_checks = [("Governador", 22, 22), ("Senador", 22, 222)]
    for cargo, nr_partido, nr_candidato_unico in party_checks:
        by_partido = con.execute(
            f"""
            SELECT SUM(qt_votos) FROM read_parquet('{(OUT_DIR / "agg_municipio_partido.parquet").as_posix()}') ap
            JOIN (SELECT DISTINCT cd_cargo, ds_cargo FROM votos) c USING (cd_cargo)
            WHERE c.ds_cargo = ? AND ap.nr_partido = ?
            """,
            [cargo, nr_partido],
        ).fetchone()[0]
        by_candidato = con.execute(
            "SELECT SUM(qt_votos) FROM votos WHERE ds_cargo = ? AND nr_votavel = ?",
            [cargo, nr_candidato_unico],
        ).fetchone()[0]
        assert by_partido == by_candidato, (
            f"{cargo} partido {nr_partido}: agregado={by_partido} vs candidato único={by_candidato}"
        )
        print(f"  OK partido {nr_partido} ({cargo}): {by_partido} votos bate com o candidato único")

    dep_fed_pl_partido = con.execute(
        f"""
        SELECT SUM(qt_votos) FROM read_parquet('{(OUT_DIR / "agg_municipio_partido.parquet").as_posix()}') ap
        JOIN (SELECT DISTINCT cd_cargo, ds_cargo FROM votos) c USING (cd_cargo)
        WHERE c.ds_cargo = 'Deputado Federal' AND ap.nr_partido = 22
        """
    ).fetchone()[0]
    dep_fed_pl_maior_candidato = con.execute(
        """
        SELECT MAX(soma) FROM (
            SELECT nr_votavel, SUM(qt_votos) AS soma FROM votos
            WHERE ds_cargo = 'Deputado Federal' AND nr_partido = 22
            GROUP BY nr_votavel
        )
        """
    ).fetchone()[0]
    assert dep_fed_pl_partido >= dep_fed_pl_maior_candidato, "soma do partido não pode ser menor que o maior candidato dele"
    print(
        f"  OK partido 22 (Deputado Federal): {dep_fed_pl_partido} votos "
        f">= maior candidato individual ({dep_fed_pl_maior_candidato})"
    )

    print("\nMilestone 2 (+ partido) completo. Arquivos em", OUT_DIR)


if __name__ == "__main__":
    main()
