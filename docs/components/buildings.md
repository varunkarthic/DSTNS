# Buildings and places

Places are the mapped features that drive demand: schools, offices, shops,
stops and so on. Source: `MapFeature` (`include/dstns/model.hpp`), place
classification and demand (`include/dstns/demand.hpp`, `src/demand.cpp`), and
coupling (`src/events.cpp`).

## Where places come from

| Source | Produces |
|---|---|
| OSM ways tagged `building`, `amenity`, `shop`, `office`, `leisure`, `landuse`, `railway`, `public_transport` | Polygon or line places |
| OSM nodes tagged `amenity`, `shop`, `office`, `leisure`, `railway`, `public_transport`, or stops | Point places |
| Synthetic grids (tests only) | `ScenarioCompiler::place_buildings` puts schools, offices, malls and stores near stops |

Each place keeps its OSM tags, name, centre, geometry, the nearest road node
(`anchor_node`), and a coarse `demand_type` (school, office, mall, store) used
by the original building model.

## The taxonomy

`classify_place` sorts every place into one of 18 kinds:

| Kind | Modelled | Trip generator | Commercial |
|---|---|---|---|
| school, university, office, industrial, transport, hospital | yes | yes | no |
| retail, mall | yes | yes | yes |
| food | yes | no | yes |
| pharmacy, hotel, culture, park, bus_stop, parking | yes | no | no |
| residential, worship, other | no | no | no |

Generators are what bus stops follow (the *transit* coupling); commercial
places are what parking follows (the *commerce* coupling).

`GET /api/v1/view/place-kinds` returns the exact flags and this world's counts.
Unmodelled kinds stay at 1.0 all day and are hidden from the legend by default.

## Demand

Each modelled place's multiplier is its kind's diurnal profile, times its
couplings to the network around it, clamped to [1, 3]. The profiles and
couplings are tabulated in [Mathematical model:
demand](../concepts/mathematical-model.md#demand). Places push their excess
demand onto the roads within 400 m, which is how a school's 08:00 arrivals
turn the streets around it amber.

## Observing

```bash
curl -s 'localhost:8090/api/v1/view/places?kind=school&limit=5'
curl -s localhost:8090/api/v1/view/place-kinds
```

Each place reports `multiplier` (now), `baseline` (its schedule alone) and
`factors` (the couplings that explain the difference). See
[API reference: places](../api/reference.md#places).
