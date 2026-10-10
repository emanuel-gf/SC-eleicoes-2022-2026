"""Milestone 2 (+ pedido de partido, + 2026): pré-agregação via DuckDB dos
parquets que o frontend vai consumir.

Lê, pra cada ano em SOURCES, `votacao_secao_<ano>_SC_geolocated.parquet` + o
arquivo de candidatos por município/zona do TSE (que traz o partido de cada
um), junto com os lookups do milestone 1 (`data/lookup/`), e produz em
`web/public/data/` (ver PLAN.md) -- todos os anos nos mesmos arquivos, com
`ano_eleicao` como dimensão:

    candidatos.parquet          (só candidatos de verdade + Branco/Nulo)
    partidos.parquet            (partidos distintos por cargo/turno)
    agg_mesorregiao.parquet
    agg_municipio.parquet
    agg_mesorregiao_partido.parquet
    agg_municipio_partido.parquet
    secoes/ano_eleicao=<ano>/cargo_slug=<slug>/turno=<n>/data_0.parquet   (já vem com nr_partido)
    comparacao_candidatos.parquet   (quem concorreu ao mesmo cargo em 2022 e 2026, casado por CPF)

O parquet geolocalizado de 2026 (e de anos futuros) sai do
`scripts/build_geolocated.py`.

Run:
    uv run python scripts/build_aggregates.py
"""

import shutil
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "tse_data_manipulation"
# ano -> (votação por seção geolocalizada, candidatos por município/zona,
# cadastro de candidatos `consulta_cand` -- o único com CPF, que é o que
# identifica a mesma pessoa entre eleições). 2022 ficou na raiz de
# tse_data_manipulation/ por razão histórica; anos novos ficam numa pasta própria.
SOURCES = {
    2022: (
        DATA_DIR / "votacao_secao_2022_SC_geolocated.parquet",
        DATA_DIR / "votacao_candidato_munzona_2022_SC.csv",
        DATA_DIR / "consulta_cand_2022_SC.csv",
    ),
    2026: (
        DATA_DIR / "2026" / "votacao_secao_2026_SC_geolocated.parquet",
        DATA_DIR / "2026" / "votacao_candidato_munzona_2026_SC.csv",
        DATA_DIR / "2026" / "consulta_cand_2026_SC.csv",
    ),
}
# Os dois anos comparados no modo "Comparar" do mapa (1º turno vs 1º turno).
ANO_BASE, ANO_COMPARADO = 2022, 2026
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

    secao_sources = ", ".join(f"'{secao.as_posix()}'" for secao, _, _ in SOURCES.values())
    munzona_sources = ", ".join(f"'{munzona.as_posix()}'" for _, munzona, _ in SOURCES.values())
    cand_sources = ", ".join(f"'{cand.as_posix()}'" for _, _, cand in SOURCES.values())

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
            SQ_CANDIDATO AS sq_candidato,
            CD_MUNICIPIO AS cd_municipio_tse,
            NR_ZONA AS nr_zona,
            NR_LOCAL_VOTACAO AS nr_local_votacao,
            LATITUDE AS latitude,
            LONGITUDE AS longitude,
            IS_APPROXIMATE AS is_approximate,
            QT_VOTOS AS qt_votos
        FROM read_parquet([{secao_sources}], union_by_name=true)
    """)

    n_rows, n_cargo_null = con.execute(
        "SELECT count(*), count(*) FILTER (cargo_slug IS NULL) FROM votos_base"
    ).fetchone()
    assert n_cargo_null == 0, f"{n_cargo_null} linhas com DS_CARGO fora do CARGO_SLUGS conhecido"
    print(f"Fonte: {n_rows} linhas, todos os cargos mapeados pra slug.")
    for ano, n in con.execute("SELECT ano_eleicao, count(*) FROM votos_base GROUP BY 1 ORDER BY 1").fetchall():
        print(f"  {ano}: {n} linhas")

    # --- lookup de partido a partir do arquivo de candidatos por município/zona ---
    # Duas tabelas: uma por candidato de verdade (NR_CANDIDATO -> partido) e uma só
    # por partido (cobre "voto de legenda", onde NR_VOTAVEL É o número do partido,
    # sem candidato específico -- só existe em cargos proporcionais).
    # Por ano: número de candidato/partido não é estável entre eleições.
    con.execute(f"""
        CREATE VIEW candidato_partido AS
        SELECT DISTINCT ANO_ELEICAO AS ano_eleicao, CD_CARGO AS cd_cargo, NR_CANDIDATO AS nr_votavel,
               NR_PARTIDO AS nr_partido, SG_PARTIDO AS sg_partido, NM_PARTIDO AS nm_partido
        FROM read_csv([{munzona_sources}], delim=';', encoding='latin-1', header=true, union_by_name=true)
    """)
    con.execute("""
        CREATE VIEW partido_nome AS
        SELECT DISTINCT ano_eleicao, cd_cargo, nr_partido, sg_partido, nm_partido FROM candidato_partido
    """)

    dupe = con.execute("""
        SELECT ano_eleicao, cd_cargo, nr_votavel, count(DISTINCT sg_partido)
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
        LEFT JOIN candidato_partido cp
            ON v.ano_eleicao = cp.ano_eleicao AND v.cd_cargo = cp.cd_cargo AND v.nr_votavel = cp.nr_votavel
        LEFT JOIN partido_nome pn
            ON v.ano_eleicao = pn.ano_eleicao AND v.cd_cargo = pn.cd_cargo AND v.nr_votavel = pn.nr_partido
    """)

    # Uma fração muito pequena de números votáveis não aparece no arquivo de
    # candidatos por município/zona (provavelmente candidatura cassada/indeferida
    # depois da urna já impressa) -- não dá pra saber o partido desses. Fica como
    # aviso, não erro: o voto continua contando nos agregados totais (denominador
    # de "% de votos válidos"), só não vira um candidato/partido selecionável.
    sem_partido_por_ano = con.execute(
        f"""
        SELECT ano_eleicao,
               count(*) FILTER (nr_partido IS NULL AND nr_votavel NOT IN {PSEUDO_CANDIDATOS}),
               SUM(qt_votos) FILTER (nr_partido IS NULL AND nr_votavel NOT IN {PSEUDO_CANDIDATOS}),
               SUM(qt_votos)
        FROM votos GROUP BY 1 ORDER BY 1
        """
    ).fetchall()
    for ano, linhas_sem_partido, votos_sem_partido, votos_total in sem_partido_por_ano:
        if linhas_sem_partido:
            pct = 100 * votos_sem_partido / votos_total
            print(
                f"  AVISO {ano}: {linhas_sem_partido} linhas ({votos_sem_partido} votos, "
                f"{pct:.3f}% dos votos) com número votável sem partido resolvido "
                "-- provavelmente candidatura cassada/indeferida; ficam fora do dropdown "
                "de candidato/partido mas continuam contando no total de votos válidos."
            )
        else:
            print(f"  OK {ano}: todo voto (exceto Branco/Nulo) tem partido resolvido")

    # --- 1. dimensão de candidatos (só gente de verdade + Branco/Nulo, sem legenda) ---
    con.execute(f"""
        COPY (
            SELECT DISTINCT v.ano_eleicao, v.turno, v.cd_cargo, v.ds_cargo, v.nr_votavel, v.nm_votavel,
                   v.nr_partido, v.sg_partido, v.nm_partido
            FROM votos v
            WHERE v.nr_votavel IN {PSEUDO_CANDIDATOS}
               OR EXISTS (
                    SELECT 1 FROM candidato_partido cp
                    WHERE cp.ano_eleicao = v.ano_eleicao AND cp.cd_cargo = v.cd_cargo AND cp.nr_votavel = v.nr_votavel
               )
            ORDER BY ano_eleicao, cd_cargo, turno, nr_votavel
        ) TO '{(OUT_DIR / "candidatos.parquet").as_posix()}' (FORMAT PARQUET)
    """)

    # --- 1b. dimensão de partidos (pra segunda dropdown) ---
    con.execute(f"""
        COPY (
            SELECT DISTINCT ano_eleicao, turno, cd_cargo, ds_cargo, nr_partido, sg_partido, nm_partido
            FROM votos
            WHERE nr_partido IS NOT NULL
            ORDER BY ano_eleicao, cd_cargo, turno, sg_partido
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

    # --- 4. ponto exato (seção), particionado por ano/cargo/turno -- já com nr_partido,
    # pra dar pra agregar por partido no cliente sem precisar de outro arquivo ---
    # Group by inclui lat/lon direto (em vez de só zona+local) pra não quebrar nos
    # poucos casos (6 de 3488) em que o mesmo numero de local aparece com endereços
    # diferentes dentro da mesma zona -- viram pontos distintos, o que é o correto.
    # Apaga antes: o layout de pasta mudou (ganhou ano_eleicao=) e partições
    # velhas sobrando seriam lidas junto pelo glob da validação.
    secoes_dir = OUT_DIR / "secoes"
    shutil.rmtree(secoes_dir, ignore_errors=True)
    con.execute(f"""
        COPY (
            SELECT
                ano_eleicao, cargo_slug, turno, nr_votavel, nm_votavel, nr_partido, sg_partido,
                nr_zona, nr_local_votacao, cd_municipio_tse, latitude, longitude, is_approximate,
                SUM(qt_votos) AS qt_votos
            FROM votos
            GROUP BY ALL
        ) TO '{secoes_dir.as_posix()}' (
            FORMAT PARQUET, PARTITION_BY (ano_eleicao, cargo_slug, turno), OVERWRITE_OR_IGNORE 1
        )
    """)

    # --- validação: total por ano/cargo/turno bate entre a fonte e cada agregado ---
    totals = {}
    totals["fonte"] = con.execute(
        "SELECT ano_eleicao, cd_cargo, turno, SUM(qt_votos) FROM votos GROUP BY ALL"
    ).fetchall()
    for name in ["agg_municipio", "agg_mesorregiao"]:
        totals[name] = con.execute(
            f"SELECT ano_eleicao, cd_cargo, turno, SUM(qt_votos) FROM read_parquet('{(OUT_DIR / f'{name}.parquet').as_posix()}') GROUP BY ALL"
        ).fetchall()
    totals["secoes"] = con.execute(
        f"""
        SELECT s.ano_eleicao, c.cd_cargo, s.turno, SUM(s.qt_votos)
        FROM read_parquet('{secoes_dir.as_posix()}/**/*.parquet', hive_partitioning=1) s
        JOIN (SELECT DISTINCT cd_cargo, cargo_slug FROM votos) c USING (cargo_slug)
        GROUP BY ALL
        """
    ).fetchall()
    expected = sorted(totals["fonte"])
    for name, rows in totals.items():
        assert sorted(rows) == expected, f"total por ano/cargo/turno diverge em {name}"
    print(f"  OK total de votos por ano/cargo/turno bate em todos os agregados ({len(expected)} combinações)")

    # --- validação: soma de votos bate entre agregados e a fonte, pra candidatos e partidos conhecidos (2022) ---
    checks = [
        ("Governador", 22, "JORGINHO DOS SANTOS MELLO"),
        ("Governador", 11, "ESPERIDIÃO AMIN HELOU FILHO"),
        ("Governador", 95, "VOTO BRANCO"),
        ("Governador", 96, "VOTO NULO"),
        ("Senador", 222, "JORGE SEIF JUNIOR"),
    ]
    for cargo, nr, _label in checks:
        raw = con.execute(
            "SELECT SUM(qt_votos) FROM votos WHERE ano_eleicao = 2022 AND ds_cargo = ? AND nr_votavel = ?", [cargo, nr]
        ).fetchone()[0]
        by_muni = con.execute(
            f"""
            SELECT SUM(qt_votos) FROM read_parquet('{(OUT_DIR / "agg_municipio.parquet").as_posix()}') am
            JOIN (SELECT DISTINCT cd_cargo, ds_cargo FROM votos) c USING (cd_cargo)
            WHERE am.ano_eleicao = 2022 AND c.ds_cargo = ? AND am.nr_votavel = ?
            """,
            [cargo, nr],
        ).fetchone()[0]
        by_meso = con.execute(
            f"""
            SELECT SUM(qt_votos) FROM read_parquet('{(OUT_DIR / "agg_mesorregiao.parquet").as_posix()}') ar
            JOIN (SELECT DISTINCT cd_cargo, ds_cargo FROM votos) c USING (cd_cargo)
            WHERE ar.ano_eleicao = 2022 AND c.ds_cargo = ? AND ar.nr_votavel = ?
            """,
            [cargo, nr],
        ).fetchone()[0]
        by_secoes = con.execute(
            f"""
            SELECT SUM(qt_votos) FROM read_parquet('{secoes_dir.as_posix()}/**/*.parquet', hive_partitioning=1) s
            WHERE s.ano_eleicao = 2022 AND s.cargo_slug = ? AND s.nr_votavel = ?
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
            WHERE ap.ano_eleicao = 2022 AND c.ds_cargo = ? AND ap.nr_partido = ?
            """,
            [cargo, nr_partido],
        ).fetchone()[0]
        by_candidato = con.execute(
            "SELECT SUM(qt_votos) FROM votos WHERE ano_eleicao = 2022 AND ds_cargo = ? AND nr_votavel = ?",
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
        WHERE ap.ano_eleicao = 2022 AND c.ds_cargo = 'Deputado Federal' AND ap.nr_partido = 22
        """
    ).fetchone()[0]
    dep_fed_pl_maior_candidato = con.execute(
        """
        SELECT MAX(soma) FROM (
            SELECT nr_votavel, SUM(qt_votos) AS soma FROM votos
            WHERE ano_eleicao = 2022 AND ds_cargo = 'Deputado Federal' AND nr_partido = 22
            GROUP BY nr_votavel
        )
        """
    ).fetchone()[0]
    assert dep_fed_pl_partido >= dep_fed_pl_maior_candidato, "soma do partido não pode ser menor que o maior candidato dele"
    print(
        f"  OK partido 22 (Deputado Federal): {dep_fed_pl_partido} votos "
        f">= maior candidato individual ({dep_fed_pl_maior_candidato})"
    )

    build_comparacao(con, cand_sources)

    print("\nMilestone 2 (+ partido, + 2026, + comparação) completo. Arquivos em", OUT_DIR)


def build_comparacao(con: duckdb.DuckDBPyConnection, cand_sources: str) -> None:
    """Quem concorreu ao MESMO cargo em ANO_BASE e ANO_COMPARADO, casado por CPF.

    Número de urna, nome de urna e partido não servem pra casar a mesma pessoa
    entre eleições (entre quem concorreu nos dois anos: 68 trocaram de número
    no mesmo cargo, 69 de partido, 46 de nome de urna). O caminho exato é
    voto -> SQ_CANDIDATO (id da candidatura, por eleição) -> consulta_cand ->
    CPF. O CPF NÃO vai pro site (dado pessoal, site é público) -- só um
    id_pessoa substituto. O voto por município é calculado no navegador a
    partir do agg_municipio/agg_mesorregiao, via nr_<ano> desta tabela.
    """
    out = OUT_DIR / "comparacao_candidatos.parquet"
    # consulta_cand tem mais de uma linha por candidatura (ex. uma por turno) --
    # DISTINCT; CPF como texto (tem zero à esquerda).
    con.execute(f"""
        CREATE VIEW candidatura_cpf AS
        SELECT DISTINCT ANO_ELEICAO AS ano_eleicao, SQ_CANDIDATO AS sq_candidato, NR_CPF_CANDIDATO AS cpf
        FROM read_csv([{cand_sources}], delim=';', encoding='latin-1', header=true, union_by_name=true,
                      types={{'NR_CPF_CANDIDATO': 'VARCHAR', 'SQ_CANDIDATO': 'BIGINT'}})
    """)
    sem_cpf = con.execute("""
        SELECT count(*) FROM candidatura_cpf
        WHERE cpf IS NULL OR cpf IN ('', '-1', '-3', '-4')
    """).fetchone()[0]
    assert sem_cpf == 0, f"{sem_cpf} candidaturas sem CPF no consulta_cand (TSE mascarou?)"

    # Votos do 1º turno por pessoa/cargo/ano (SQ_CANDIDATO > 0 = candidato de
    # verdade; legenda e Branco/Nulo vêm com -1).
    con.execute(f"""
        CREATE TABLE pessoa_ano AS
        SELECT v.ano_eleicao, v.cd_cargo, v.ds_cargo, c.cpf, v.nr_votavel,
               any_value(v.nm_votavel) AS nome, any_value(v.sg_partido) AS sg_partido,
               SUM(v.qt_votos)::BIGINT AS votos
        FROM votos v
        JOIN candidatura_cpf c ON c.ano_eleicao = v.ano_eleicao AND c.sq_candidato = v.sq_candidato
        WHERE v.turno = 1 AND v.sq_candidato > 0 AND v.ano_eleicao IN ({ANO_BASE}, {ANO_COMPARADO})
        GROUP BY v.ano_eleicao, v.cd_cargo, v.ds_cargo, c.cpf, v.nr_votavel
    """)
    dupe = con.execute("""
        SELECT ano_eleicao, cd_cargo, nome, count(*) FROM pessoa_ano GROUP BY ano_eleicao, cd_cargo, cpf, nome
        HAVING count(*) > 1
    """).fetchall()
    assert not dupe, f"pessoa com mais de um número no mesmo cargo/ano: {dupe}"

    con.execute(f"""
        COPY (
            SELECT
                dense_rank() OVER (ORDER BY a.cpf) AS id_pessoa,
                a.cd_cargo, b.ds_cargo,
                a.nr_votavel AS nr_{ANO_BASE}, b.nr_votavel AS nr_{ANO_COMPARADO},
                a.nome AS nome_{ANO_BASE}, b.nome AS nome_{ANO_COMPARADO},
                a.sg_partido AS sg_partido_{ANO_BASE}, b.sg_partido AS sg_partido_{ANO_COMPARADO},
                a.votos AS votos_{ANO_BASE}, b.votos AS votos_{ANO_COMPARADO}
            FROM pessoa_ano a
            JOIN pessoa_ano b
                ON a.cpf = b.cpf AND a.cd_cargo = b.cd_cargo
                AND a.ano_eleicao = {ANO_BASE} AND b.ano_eleicao = {ANO_COMPARADO}
            ORDER BY a.cd_cargo, b.nome
        ) TO '{out.as_posix()}' (FORMAT PARQUET)
    """)

    # --- validação ---
    por_cargo = con.execute(
        f"SELECT ds_cargo, count(*) FROM read_parquet('{out.as_posix()}') GROUP BY 1 ORDER BY 2 DESC"
    ).fetchall()
    n_total = sum(n for _, n in por_cargo)
    print(f"\nComparação {ANO_BASE} -> {ANO_COMPARADO}: {n_total} pessoas no mesmo cargo nos dois anos "
          + ", ".join(f"{cargo}: {n}" for cargo, n in por_cargo))
    assert 100 <= n_total <= 200, f"número de pessoas casadas fora do esperado (~131): {n_total}"

    # Total de cada pessoa bate com a soma do agg_municipio pelo número dela em cada ano.
    divergentes = con.execute(f"""
        WITH agg AS (
            SELECT ano_eleicao, cd_cargo, nr_votavel, SUM(qt_votos) AS votos
            FROM read_parquet('{(OUT_DIR / "agg_municipio.parquet").as_posix()}')
            WHERE turno = 1 GROUP BY ALL
        )
        SELECT c.nome_{ANO_COMPARADO}
        FROM read_parquet('{out.as_posix()}') c
        LEFT JOIN agg a ON a.ano_eleicao = {ANO_BASE} AND a.cd_cargo = c.cd_cargo AND a.nr_votavel = c.nr_{ANO_BASE}
        LEFT JOIN agg b ON b.ano_eleicao = {ANO_COMPARADO} AND b.cd_cargo = c.cd_cargo AND b.nr_votavel = c.nr_{ANO_COMPARADO}
        WHERE a.votos IS DISTINCT FROM c.votos_{ANO_BASE} OR b.votos IS DISTINCT FROM c.votos_{ANO_COMPARADO}
    """).fetchall()
    assert not divergentes, f"total da pessoa não bate com agg_municipio: {divergentes[:5]}"
    print(f"  OK total de cada pessoa bate com agg_municipio nos dois anos")

    jorginho = con.execute(f"""
        SELECT votos_{ANO_BASE}, votos_{ANO_COMPARADO} FROM read_parquet('{out.as_posix()}')
        WHERE ds_cargo = 'Governador' AND nr_{ANO_BASE} = 22
    """).fetchall()
    assert jorginho == [(1575912, 2942386)], f"Jorginho Mello (Governador) inesperado: {jorginho}"
    print(f"  OK Jorginho Mello (Governador, 1º turno): {jorginho[0][0]} -> {jorginho[0][1]}")

    mudou_numero = con.execute(f"""
        SELECT count(*) FROM read_parquet('{out.as_posix()}') WHERE nr_{ANO_BASE} <> nr_{ANO_COMPARADO}
    """).fetchone()[0]
    print(f"  {mudou_numero} pessoas trocaram de número de urna no mesmo cargo -- casadas mesmo assim pelo CPF")


if __name__ == "__main__":
    main()
