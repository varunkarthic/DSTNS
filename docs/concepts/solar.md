# Sun and surface (DCM)

The **Deterministic Cosmic Model** is the city's energy source: where the Sun
is, how much of its light reaches each patch of ground, and how hot that
ground becomes. It deliberately models nothing else about the sky.

| | |
|---|---|
| **Provides** | Solar elevation and azimuth; extraterrestrial, direct-normal and diffuse irradiance; daylight; shortwave reaching each cell of the [environment grid](terrain.md#the-environment-grid); surface temperature per cell; background air temperature |
| **Reads** | The run's month and location ([calendar](../guide/seeds-and-places.md#when-month-and-day-type)); the clock; terrain normals; the active storms' cloud |
| **Data class** | *Simulated* (irradiance, temperatures) and *derived* (solar geometry) |
| **Runs** | Every 60 s of virtual time |
| **Switch** | Module `dcm` (`PUT /api/v1/control/modules/dcm`) |
| **Code** | `src/environment/solar.cpp`, `src/environment/runtime.cpp` |

## A month without a date

A run has a month but no day of the month, so the Sun follows the month's
**representative day**: Klein's mean day, the day whose extraterrestrial
radiation equals the monthly mean.

| Month | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Day of year \( n \) | 17 | 47 | 75 | 105 | 135 | 162 | 198 | 228 | 258 | 288 | 318 | 344 |

It is an internal approximation for solar geometry. It is never shown or
reported as a date.

## Solar position

**Clock to solar time.** The simulation clock is taken to be local standard
time on the city's nominal meridian \( \lambda_s = 15^\circ \operatorname{round}(\lambda / 15^\circ) \),
without daylight saving. Political time zones are not modelled. Solar time
corrects for the longitude offset (4 minutes per degree) and the equation of
time \( E \) (Spencer, in Duffie and Beckman's form):

\[
B = \frac{360^\circ (n - 81)}{364}, \qquad
E = 9.87 \sin 2B - 7.53 \cos B - 1.5 \sin B \;\;\text{min},
\]
\[
t_\text{solar} = t_\text{clock} + \frac{4(\lambda - \lambda_s) + E}{60} \;\;\text{h}, \qquad
H = 15^\circ (t_\text{solar} - 12).
\]

**Declination** (Cooper):

\[
\delta = 23.45^\circ \sin\!\Big(\frac{360^\circ}{365}(284 + n)\Big).
\]

**Elevation** \( \alpha \) and **azimuth** \( \psi \) (clockwise from north,
quadrant-aware through the two-argument arctangent), for latitude \( \varphi \):

\[
\sin\alpha = \sin\varphi \sin\delta + \cos\varphi \cos\delta \cos H,
\]
\[
\psi = \operatorname{atan2}\big(-\sin H \cos\delta,\;\; \cos\varphi \sin\delta - \sin\varphi \cos\delta \cos H\big) \bmod 360^\circ.
\]

It is daylight when \( \alpha > 0 \). The latitude and longitude are those of the
environment grid's centre.

## Irradiance

**Top of the atmosphere**, with the Earth–Sun distance correction:

\[
I_0 = 1361 \,\big(1 + 0.033 \cos(360^\circ n / 365)\big) \;\; \text{W/m}^2.
\]

**Clear sky.** Relative air mass (Kasten and Young, zenith \( z = 90^\circ - \alpha \) in degrees),
beam transmittance (Meinel), and a diffuse sky equal to a tenth of the beam (Laue):

\[
AM = \frac{1}{\cos z + 0.50572\,(96.07995 - z)^{-1.6364}}, \qquad
T_\text{atm} = 0.7^{AM^{0.678}},
\]
\[
I_\text{DNI} = I_0\, T_\text{atm}, \qquad I_\text{DHI} = 0.1\, I_\text{DNI}.
\]

**Cloud.** Each active storm casts a cloud shield 1.8 times its rain radius,
with cover \( c_k = \min(1, 0.6 + 0.4 I_k)\, W(d / 1.8 r_k) \), \( W \) the Wendland
C² kernel. Shields combine as independent cover, \( c = 1 - \prod_k (1 - c_k) \),
and attenuate both components (Kasten and Czeplak):

\[
C_\text{cloud} = 1 - 0.75\, c^{3.4}.
\]

**On the terrain.** With the cell's unit normal
\( \mathbf n = (-\partial_x z, -\partial_y z, 1)/\lVert\cdot\rVert \) and the unit vector
towards the Sun \( \mathbf s = (\sin\psi\cos\alpha, \cos\psi\cos\alpha, \sin\alpha) \) (x east, y north),
the shortwave reaching the surface is

\[
S = C_\text{cloud}\Big(I_\text{DNI} \max(0, \mathbf n\cdot\mathbf s) + I_\text{DHI}\,\frac{1 + \cos\beta}{2}\Big),
\]

where \( \beta \) is the cell's tilt. A west-facing slope therefore receives less in
the morning and more in the afternoon than flat ground. Shadows cast by
buildings are not modelled.

## Surface energy balance

Every cell is treated as a slab of aged asphalt (no land-cover classes yet). Its
temperature \( T_s \) follows

\[
C\,\frac{dT_s}{dt} = (1 - a)\,S + \varepsilon L_\downarrow - \varepsilon\sigma T_s^4
- h_c (T_s - T_a) - U (T_s - T_\text{deep}) + Q_\text{anthro}
\]

| Symbol | Meaning | Default | Units |
|---|---|---|---|
| \( C \) | Areal heat capacity: 5 cm of asphalt, \( \rho c = 2.1 \) MJ/m³K | 1.05 × 10⁵ | J/m²K |
| \( a \) | Albedo, aged asphalt | 0.12 | – |
| \( \varepsilon \) | Emissivity | 0.93 | – |
| \( \sigma \) | Stefan–Boltzmann constant | 5.670 × 10⁻⁸ | W/m²K⁴ |
| \( h_c \) | Convection, McAdams: \( 5.7 + 3.8u \), \( u \) the wind (3 m/s until the atmosphere model provides it) | 17.1 | W/m²K |
| \( U \) | Conduction to the layer beneath: \( k/\Delta z \), 0.75 W/mK over 15 cm | 5 | W/m²K |
| \( T_\text{deep} \) | That layer: the monthly mean air temperature plus 2 °C | | °C |
| \( Q_\text{anthro} \) | Optional anthropogenic heat; uncalibrated, so 0 | 0 | W/m² |

**Sky longwave** (Swinbank's clear-sky emissivity, raised by cloud):

\[
L_\downarrow = 9.365\times10^{-6}\, T_a^2 \;\sigma T_a^4\, (1 + 0.22 c^2), \qquad T_a \text{ in K}.
\]

**Air temperature.** Until the atmosphere model supplies a field, the air
follows a zonal approximation (not a climatology):

\[
\bar T(\varphi, m) = 29\cos^2\varphi + 0.18\,|\varphi|\cos\!\Big(2\pi\frac{m - m_\text{peak}}{12}\Big) \;\;°\text{C},
\]

with \( m_\text{peak} \) July in the north and January in the south; a diurnal swing
of 10 °C, \( T_a = \bar T + \Delta + 5\cos(2\pi (t_\text{solar} - 15)/24) \), coolest at
03:00 and warmest at 15:00 solar time; a daily anomaly \( \Delta \sim \mathcal N(0, 1.5^2) \)
drawn once from the run's own `das.climate` stream; and up to 3 °C cooler under
a storm's cloud. It gives Berlin about 19 °C in July and 1.5 °C in January.

**Numerics.** Explicit Euler over each 60 s interval. The slab's time constant,
\( C / (4\varepsilon\sigma T^3 + h_c + U) \), is about 40 minutes, so the step is
stable by a wide margin. At install a two-day spin-up under clear sky, in
10-minute steps (still stable), gives midnight temperatures on the periodic
diurnal cycle rather than a guess; it takes about 25 ms on an 11,664-cell grid.
Temperatures are stored as single precision.

## Scheduling and replay

The DCM updates on whole minutes of virtual time. The minute divides the 900 s
checkpoint interval, and the whole environment state is copied into every
checkpoint, so restoring one and replaying meets exactly the same update
instants: seeking back and forth reproduces every value (tested). Turning the
`dcm` module off holds the surface where it is; it does not catch up when
turned back on.

## Outputs

| Where | What |
|---|---|
| `GET /api/v1/view/environment` → `state.dcm` | Solar time, declination, equation of time, elevation, azimuth, daylight, extraterrestrial, direct-normal and diffuse irradiance (after cloud), clear-sky global, mean cloud, air temperature and its anomaly, the monthly mean, irradiance and surface temperature statistics, the representative day and its sun path, the surface parameters |
| `GET /api/v1/view/fields/irradiance` | Shortwave reaching each cell, W/m² |
| `GET /api/v1/view/fields/surface_temperature` | °C |
| `GET /api/v1/view/fields/cloud` | Cloud fraction |
| Observer | **City** tab, *Sun and surface* card with the sun path; **Solar irradiance** and **Surface temperature** field overlays |

## Validation

`tests/environment/solar_tests.cpp` (CTest `dstns_solar`):

| Case | Expectation |
|---|---|
| Equatorial noon, March | The Sun within 3° of the zenith |
| 52° N, June and December | Noon elevation \( 90^\circ - 52^\circ \pm 23.1^\circ \); 16.5 h and 7.7 h of daylight |
| Equator | About 12 h of daylight in every month |
| 34° S | December is summer; day lengths mirror the north's |
| Azimuth | Morning east, northern noon south, evening west, southern noon north |
| Equation of time | Within 17 minutes all year; 4 minutes of solar time per degree of longitude |
| Clear sky | About 1,000 W/m² at the zenith, nothing below the horizon; overcast passes a quarter |
| A July day (scenario G) | Dark before 03:00; morning forcing below noon's, evening falling; the surface warms by more than 10 °C, peaks in the early afternoon, is well above the air at noon and cools in the evening |
| Terrain | A west-facing slope gets less morning and more afternoon sun |
| Storms | Cloud cuts the light beneath a storm and nowhere far from it |
| Replay | Two runs are identical; a disabled module holds; seeking back and forward through the engine reproduces the environment and its fields |

On the bundled Berlin district at 13:30 in July the model gives 877 W/m² direct
normal, surface temperatures of 43.6 to 51.1 °C against 27.2 °C air, and a
visibly cooler patch under a passing storm.

## Limitations

- One surface type, asphalt, everywhere: no grass, water, roofs or trees. Parks
  run as hot as roads.
- No shadows from buildings or terrain; no reflected light.
- The air temperature is a zonal approximation: continentality, altitude,
  monsoons and coastal effects are ignored. A Mediterranean and a continental
  city at one latitude get the same climate.
- Time zones are nominal: a city whose clocks keep a zone far from its meridian
  (western China, Spain) sees solar noon at the "wrong" clock time compared with
  reality, consistently.
