"""Milestone 1: município/mesorregião boundaries + TSE<->IBGE crosswalk for SC.

Produces (see PLAN.md):
    data/geo/sc_municipios.geojson
    data/geo/sc_mesorregioes.geojson   (dissolve of the municípios, not downloaded)
    data/lookup/municipio_tse_ibge.csv
    data/lookup/municipio_mesorregiao.csv

Run once (or whenever the source data needs refreshing):
    uv run python scripts/build_boundaries.py
"""

import zipfile
from pathlib import Path

import geobr
import geopandas as gpd
import pandas as pd
import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_GEO = REPO_ROOT / "data" / "geo"
DATA_LOOKUP = REPO_ROOT / "data" / "lookup"
TSE_IBGE_ZIP = REPO_ROOT / "tse_data_manipulation" / "municipio_tse_ibge.zip"

UF_CODE_SC = 42
MUNICIPALITY_YEAR = 2022


def load_tse_ibge_crosswalk_sc() -> pd.DataFrame:
    with zipfile.ZipFile(TSE_IBGE_ZIP) as zf:
        with zf.open("municipio_tse_ibge.csv") as f:
            df = pd.read_csv(f, sep=";", encoding="latin1")

    sc = df.loc[df["SG_UF"] == "SC", [
        "CD_MUNICIPIO_TSE", "NM_MUNICIPIO_TSE", "CD_MUNICIPIO_IBGE", "NM_MUNICIPIO_IBGE",
    ]].rename(columns={
        "CD_MUNICIPIO_TSE": "cd_municipio_tse",
        "NM_MUNICIPIO_TSE": "nm_municipio_tse",
        "CD_MUNICIPIO_IBGE": "cd_municipio_ibge",
        "NM_MUNICIPIO_IBGE": "nm_municipio_ibge",
    }).reset_index(drop=True)
    return sc


def fetch_municipio_mesorregiao() -> pd.DataFrame:
    url = f"https://servicodados.ibge.gov.br/api/v1/localidades/estados/{UF_CODE_SC}/municipios"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    rows = []
    for muni in resp.json():
        meso = muni["microrregiao"]["mesorregiao"]
        rows.append({
            "cd_municipio_ibge": muni["id"],
            "cd_mesorregiao": meso["id"],
            "nm_mesorregiao": meso["nome"],
        })
    return pd.DataFrame(rows)


def fetch_municipios_geobr() -> gpd.GeoDataFrame:
    gdf = geobr.read_municipality(code_muni="SC", year=MUNICIPALITY_YEAR)
    gdf = gdf.rename(columns={"code_muni": "cd_municipio_ibge", "name_muni": "nm_municipio_ibge"})
    gdf["cd_municipio_ibge"] = gdf["cd_municipio_ibge"].astype("int64")
    return gdf[["cd_municipio_ibge", "nm_municipio_ibge", "geometry"]]


def main() -> None:
    DATA_GEO.mkdir(parents=True, exist_ok=True)
    DATA_LOOKUP.mkdir(parents=True, exist_ok=True)

    print("Carregando crosswalk TSE<->IBGE (SC)...")
    crosswalk = load_tse_ibge_crosswalk_sc()
    print(f"  {len(crosswalk)} municípios TSE encontrados para SC")

    print("Consultando API de Localidades do IBGE (município -> mesorregião)...")
    meso_lookup = fetch_municipio_mesorregiao()
    print(f"  {len(meso_lookup)} municípios, {meso_lookup['cd_mesorregiao'].nunique()} mesorregiões")

    print("Baixando polígonos de município via geobr...")
    municipios = fetch_municipios_geobr()
    print(f"  {len(municipios)} polígonos de município")

    # --- validação ---
    ibge_crosswalk = set(crosswalk["cd_municipio_ibge"])
    ibge_geobr = set(municipios["cd_municipio_ibge"])
    ibge_meso = set(meso_lookup["cd_municipio_ibge"])

    assert len(crosswalk) == 295, f"esperava 295 municípios no crosswalk TSE, achei {len(crosswalk)}"
    assert len(municipios) == 295, f"esperava 295 polígonos do geobr, achei {len(municipios)}"
    assert len(meso_lookup) == 295, f"esperava 295 municípios na API do IBGE, achei {len(meso_lookup)}"
    assert ibge_crosswalk == ibge_geobr, (
        f"códigos IBGE não batem entre crosswalk e geobr: "
        f"só no crosswalk={ibge_crosswalk - ibge_geobr}, só no geobr={ibge_geobr - ibge_crosswalk}"
    )
    assert ibge_crosswalk == ibge_meso, (
        f"códigos IBGE não batem entre crosswalk e API do IBGE: "
        f"só no crosswalk={ibge_crosswalk - ibge_meso}, só na API={ibge_meso - ibge_crosswalk}"
    )
    print("  OK: os 295 municípios batem 1:1 entre TSE, geobr e API do IBGE")

    # --- junta mesorregião nos polígonos e salva ---
    municipios = municipios.merge(meso_lookup, on="cd_municipio_ibge", how="left")
    municipios = municipios.merge(
        crosswalk[["cd_municipio_tse", "cd_municipio_ibge"]], on="cd_municipio_ibge", how="left"
    )
    municipios.to_file(DATA_GEO / "sc_municipios.geojson", driver="GeoJSON")
    print(f"Salvo {DATA_GEO / 'sc_municipios.geojson'}")

    # --- dissolve por mesorregião ---
    mesorregioes = municipios.dissolve(by="cd_mesorregiao", as_index=False).loc[
        :, ["cd_mesorregiao", "nm_mesorregiao", "geometry"]
    ]
    assert len(mesorregioes) == 6, f"esperava 6 mesorregiões após o dissolve, achei {len(mesorregioes)}"
    invalid = ~mesorregioes.geometry.is_valid
    assert not invalid.any(), f"geometrias inválidas após dissolve: {mesorregioes.loc[invalid, 'nm_mesorregiao'].tolist()}"
    mesorregioes.to_file(DATA_GEO / "sc_mesorregioes.geojson", driver="GeoJSON")
    print(f"Salvo {DATA_GEO / 'sc_mesorregioes.geojson'} (6 polígonos, geometria válida)")

    # --- lookups tabulares ---
    crosswalk.to_csv(DATA_LOOKUP / "municipio_tse_ibge.csv", index=False)
    meso_lookup.to_csv(DATA_LOOKUP / "municipio_mesorregiao.csv", index=False)
    print(f"Salvo {DATA_LOOKUP / 'municipio_tse_ibge.csv'} e {DATA_LOOKUP / 'municipio_mesorregiao.csv'}")

    print("\nResumo por mesorregião:")
    print(mesorregioes[["cd_mesorregiao", "nm_mesorregiao"]].to_string(index=False))


if __name__ == "__main__":
    main()
