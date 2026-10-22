# Bundled static heat sources

Used by `firealerts/sources/static_sources.py` to flag hotspots that are not wildfires.

| File | Rows | Source |
|---|---|---|
| `volcanoes.csv` | 1,633 | Smithsonian Institution, Global Volcanism Program, *Volcanoes of the World* (Holocene list). Built from the GVP tables in [rfordatascience/tidytuesday 2020-05-12](https://github.com/rfordatascience/tidytuesday/tree/master/data/2020/2020-05-12) (958 volcanoes, current GVP numbers), plus entries from the older GVP-derived [plotly/datasets `volcano_db.csv`](https://github.com/plotly/datasets/blob/master/volcano_db.csv) that lie more than 5 km from any of those (no `gvp_id`). |
| `gas_flares.csv` | 8,098 | VIIRS Nightfire global gas flare survey, 2015 catalogue v0.2 (Elvidge et al., Earth Observation Group, Colorado School of Mines, for the World Bank GGFR). The file was taken from [marycamila184/flaresat `sources/flare/gas_flaring_points.csv`](https://github.com/marycamila184/flaresat). `kind` is the flare type: upstream, refinery, lng, gas, gpp (gas processing plant) or opp (oil processing plant). |

Coordinates are rounded to 4 decimal places. Volcano positions are summits, so the default
match radius for volcanoes is 5 km (`STATIC_VOLCANO_RADIUS_KM`). Active vents and lava lakes in
large calderas often sit several km from the summit: Ambrym's lava lakes are about 3.4 km away.

To refresh the files, replace them with newer exports that keep the same columns, e.g. the GVP
Holocene list from https://volcano.si.edu/volcanolist_holocene.cfm, or a recent VIIRS Nightfire
flare catalogue from https://eogdata.mines.edu/products/vnf/.
