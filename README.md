
# Mapa das Eleições 

Este repositório comprende os dados da eleições divulgados pelo TSE. Analise as eleições para o período temporal de 2022 e 2026 e buscar compreender de forma espacial como os candidatos evoluiram em suas bases eleitorais através do estado de Santa Catarina.

A partir das visualizações, é possível entender como tal candidato recebeu votações em 2022, e o mesmo para 2026. Caso esse candidato concorreu nas duas eleições, é possível compreender onde ele recebeu mais votos e onde recebeu menos. Essa espaço-temporalidade serve para compreender como os trabalhos realizados no mandato do candidato influênciou suas regiões.

Algumas consideraçoes devem ser importante, pois os votos do candidato podem ter migrado para outros candidatos, ao qual é fazer essa ligação de forma direta não é possível. 

### Metadados e estrutura pessoal do repositorio

### Arquivos dos dados abertos do TSE 
Arquivo que baixei do site do TSE para 2022: 

- votacao_candidato_munzona_2022.zip
- votacao_secao_2022_SC.zip - Esse eh o arquivo correto. 
Possui todos os candidatos e detalhamento por secao e zona. /Users/macuser/projeto/TSE-eleicao/votacao_secao_2022_SC.zip
- detalhe_votacao_secao_2022.zip
- buweb_ele_suplementares_2022.zip (boletim)


Arquivo correto de votacao 
SC - Votação por seção eleitoral - 2022
URL: <https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2022_SC.zip>

Descrição do conjunto de dados:
Histórico totalização Presidente - Votação nominal/partido por município e zona - Detalhe da apuração por município e zona/seção eleitoral -

## Mapa (web/)

Ver `PLAN.md` pro plano completo. Pra rodar o app localmente:

```bash
cd web
npm install
npm run dev
```

Abre em http://localhost:5173/. Os dados que o app consome (`web/public/data/*.parquet`,
`web/public/geo/*.geojson`) vêm dos scripts em `scripts/` (`build_boundaries.py`,
`build_aggregates.py`) -- rodar de novo se a fonte (`votacao_secao_<ano>_SC_geolocated.parquet`)
mudar.

## 2026 (e anos futuros)

Arquivos do TSE em `tse_data_manipulation/2026/`:

- `votacao_secao_2026_SC.csv` -- de <https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_SC.zip>
- `votacao_candidato_munzona_2026_SC.csv` -- extraído de <https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_candidato_munzona/votacao_candidato_munzona_2026.zip> (traz o partido de cada candidato)
- `consulta_cand_2026_SC.csv` -- extraído de <https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_2026.zip> (cadastro de candidatos, com CPF -- é o que casa a mesma pessoa entre 2022 e 2026 no modo "Comparar"; o de 2022, `consulta_cand_2022_SC.csv`, fica na raiz de `tse_data_manipulation/`). O CPF não vai pro site, só um id substituto.

```bash
uv run python scripts/build_geolocated.py 2026   # CSV -> parquet + geocode (reaproveita 2022)
uv run python scripts/build_aggregates.py        # regenera web/public/data/ com todos os anos
```

Pra um ano novo: baixar os três arquivos pra `tse_data_manipulation/<ano>/`, adicionar o ano em
`SOURCES` no `build_aggregates.py` e rodar os dois comandos acima.

## Deploy (GitHub Pages)

Publicado em <https://emanuel-gf.github.io/SC-eleicoes-2022-2026/> pelo workflow
`.github/workflows/deploy.yml`, a cada push na `main` (ou na mão, pela aba Actions).

- O CI só faz o build do `web/` -- os dados (`web/public/data`, `web/public/geo`,
  `web/public/duckdb-extensions`) já vão commitados. Atualizou dados? Rodar os scripts
  localmente, commitar `web/public/` e dar push.
- O site fica em `/<nome-do-repo>/`, não na raiz: o workflow passa `BASE_PATH` pro Vite e todo
  arquivo é carregado via `web/src/assetUrl.ts`. Nunca usar caminho absoluto tipo `"/data/..."`.
- Testar o build de produção localmente com o mesmo caminho do Pages:

```bash
cd web
BASE_PATH=/SC-eleicoes-2022-2026/ npm run build
BASE_PATH=/SC-eleicoes-2022-2026/ npx vite preview   # abre em http://localhost:4173/SC-eleicoes-2022-2026/
```

- Configuração única no GitHub: Settings → Pages → Source: **GitHub Actions**.
