# Building Generation and Demand (`dstns::ScenarioCompiler`, `dstns::SimulationEngine`)

## Purpose
Generates synthetic points of interest (Schools, Offices, Malls, Stores) around bus stop nodes and computes continuous temporal demand influence functions.

## Implemented Profiles
`ScenarioCompiler::place_buildings` assigns one of four types near eligible bus stops and stores Beta-window parameters on the selected node. `SimulationEngine::physics_step` combines those smooth windows with explicit point-of-interest rush windows and weekend multipliers. The canonical values live in those two functions; the component does not own a separate scheduler or service.

## Temporal Kernel Formulation
Each activity window $[t_{\text{start}}, t_{\text{end}}]$ uses a smooth Beta-style polynomial kernel with rise power $p$ and fall power $q$:
$$K(t) = \left( \frac{t - t_{\text{start}}}{t_{\text{end}} - t_{\text{start}}} \right)^p \left( \frac{t_{\text{end}} - t}{t_{\text{end}} - t_{\text{start}}} \right)^q \cdot \frac{(p+q)^{p+q}}{p^p q^q}$$
This guarantees $K(t) \in [0, 1]$ with peak exactly 1.0 and smooth derivative transitions at window boundaries.
