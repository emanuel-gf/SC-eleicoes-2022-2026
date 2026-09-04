

Arquivo que baixei do site do TSE para 2022: 

- votacao_candidato_munzona_2022.zip
- votacao_secao_2022_SC.zip - Esse eh o arquivo correto. Possue todos os candidatos e detalhamento por secao e zona. /Users/macuser/projeto/TSE-eleicao/votacao_secao_2022_SC.zip
- detalhe_votacao_secao_2022.zip
- buweb_ele_suplementares_2022.zip (boletim)


Arquivo correto de votacao 
SC - Votação por seção eleitoral - 2022
URL: https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2022_SC.zip

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
`build_aggregates.py`) -- rodar de novo se a fonte (`votacao_secao_2022_SC_geolocated.parquet`)
mudar.