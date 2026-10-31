// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * Tutorial content.
 *
 * Targets are semantic `data-tutorial` anchors, never coordinates. Telemetry details
 * are revealed for their step and the previous layout is restored. The last step is
 * the playback group, and its action starts the simulation.
 */
export const TUTORIAL_VERSION = "6";

export interface TutorialStep {
  target: string;
  /** The part of the interface this step belongs to. */
  chapter: string;
  title: string;
  body: string;
}

const MAP = "Map";
const TOOLS = "Tools";
const NOTIFICATIONS = "Notifications";
const TELEMETRY = "Telemetry";
const SESSION = "Session";
const WEBFABRIC = "WebFabric";

export const tutorialSteps: readonly TutorialStep[] = [
  { target: "map", chapter: MAP, title: "The live network", body: "The map displays the road network as simulated. Drag to pan and scroll to zoom. Hovering over a road, signal or place reports its current state. Distances are real metres. Vehicle markers represent aggregate flow and are not individually tracked journeys." },
  { target: "zoom", chapter: MAP, title: "Zoom and fit", body: "These controls change the magnification, and Fit returns the whole district to view. Camera controls affect only the picture, never the simulated traffic or time." },
  { target: "search", chapter: MAP, title: "Place search", body: "Search lists popular places and filters by name or kind as text is entered. Selecting a result moves the camera to that place and opens its details. Place names come from the loaded map, so availability varies between districts." },
  { target: "focus", chapter: TOOLS, title: "Auto Focus", body: "Auto Focus follows incidents, flooding and rain, framing the full extent of each event. Double-click to select Round-Robin, which cycles through active events, or Latest. The camera is held in place during this tutorial." },
  { target: "dnd", chapter: TOOLS, title: "Do Not Disturb", body: "Do Not Disturb silences the categories and severities selected in Settings. Silenced events remain in the notification history. System errors always take priority and cannot be silenced." },
  { target: "motion", chapter: TOOLS, title: "Reduced motion", body: "This control stops nonessential camera, interface and decorative animation. It does not affect the simulation or the playback speed. Adaptive Simulation Backpressure may hold it on while the interface recovers." },
  { target: "settings", chapter: TOOLS, title: "Settings", body: "Settings contains appearance, accessibility, Auto Focus, Do Not Disturb, clock format, playback intervals, data units and connected applications. All choices are stored in this browser." },
  { target: "notifications", chapter: NOTIFICATIONS, title: "Notifications", body: "New events appear here without displacing the surrounding controls, and related events are grouped. Expanding a notification shows its description, time, severity, location and technical details. A notification does not expire while it is open." },
  { target: "notifications", chapter: NOTIFICATIONS, title: "System errors and history", body: "A connection failure or failed action replaces the headline immediately, including under Do Not Disturb. Connection errors clear when service returns, and action errors may be dismissed. Earlier events are available in the Notifications view of the telemetry panel." },
  { target: "layers", chapter: MAP, title: "Layers", body: "Layers controls which elements the map draws: roads, traffic, vehicles, signals, buildings, names, weather and flooding. Hiding a layer does not disable the underlying model. Reset restores the configured defaults." },
  { target: "legend", chapter: MAP, title: "Road states", body: "Green indicates congestion below 35%, amber 35% to 70%, and red 70% or above, or a closure. Blue indicates a flooded road. The colours follow the colour vision option selected in Settings." },
  { target: "places", chapter: MAP, title: "Places", body: "Places lists each kind of marker with its count, and controls which kinds are drawn. Where the core models demand, the current multiplier on base demand is shown. Not modelled indicates that the map contains the place but the traffic model has no schedule for it." },
  { target: "hud", chapter: MAP, title: "Coordinates and scale", body: "Coordinates follow the pointer over the map and otherwise show the district anchor. The scale bar states the distance represented at the current zoom." },
  { target: "telemetry", chapter: TELEMETRY, title: "Live telemetry", body: "This panel reads the latest simulation snapshot, with network totals at the top and detailed views below. When collapsed, it becomes a narrow strip whose buttons open temporary panels. The panel is expanded for this tutorial and restored afterwards." },
  { target: "telemetry-roads", chapter: TELEMETRY, title: "Road edges", body: "This figure counts directional edges in the loaded topology, so the two directions of one road are two edges. Flowing counts the edges with at least one vehicle in the current snapshot." },
  { target: "telemetry-vehicles", chapter: TELEMETRY, title: "Vehicles and queues", body: "Vehicles is the sum of the current per-edge vehicle counts, and halting is the sum of the per-edge queues. Both are instantaneous model totals, not unique vehicles observed across the day." },
  { target: "telemetry-incidents-metric", chapter: TELEMETRY, title: "Active incidents", body: "The figure counts active scheduled incidents, and closed counts those that close a road. Flooded roads are not all included; consult the map and the incident details for the affected area." },
  { target: "telemetry-weather", chapter: TELEMETRY, title: "Weather", body: "Weather reports the strongest active rain cell and the number of cells. Intensity is normalized from zero to one, and the displayed rate is an indicative intensity × 8 mm/h. Overlapping cells are not added together." },
  { target: "telemetry-congestion", chapter: TELEMETRY, title: "Congestion index", body: "Each road combines 60% speed loss, 25% halting-to-vehicle ratio and 15% occupancy, bounded between zero and one. Closed roads score one. The network index weights traversable directions by length and lanes, and reports the current instant without smoothing." },
  { target: "telemetry-stack", chapter: TELEMETRY, title: "Stack", body: "Stack reports road-network identity, traffic activity, weather, signals, demand and runtime state. Adaptive Simulation Backpressure measures lag, frame time and stale data. It can reduce the applied rate, and escalates through Restricted and Async if recovery fails. Async suspends the interface while the simulation continues." },
  { target: "telemetry-events", chapter: TELEMETRY, title: "News", body: "News lists recent core messages in virtual-time order, including initialization, demand changes, weather, incidents and controls. An empty list indicates no recent messages, not that the engine has stopped." },
  { target: "telemetry-queue", chapter: TELEMETRY, title: "Queue", body: "Queue separates upcoming transitions, such as signal phases and demand changes, from those already executed, and can be filtered by category. Paging limits what is loaded without changing the schedule." },
  { target: "telemetry-incidents", chapter: TELEMETRY, title: "Incidents", body: "This view collects incident, safety, closure and flooding messages with their time and location. It is a history, so resolved incidents remain listed after the active count returns to zero." },
  { target: "telemetry-notifications", chapter: TELEMETRY, title: "Notification history", body: "This view records events that were shown, grouped, silenced or followed by Auto Focus, and its filters explain why a message did or did not appear. Do Not Disturb changes delivery, not whether simulation events occur." },
  { target: "telemetry-apps", chapter: WEBFABRIC, title: "WebFabric", body: "Independent applications connect through the Fabric API and appear here, in the design of DSTNS. They can add panels, map overlays, routes and animated vehicles along real roads. When this panel is collapsed, the WebFabric mark on the strip opens the same view." },
  { target: "settings", chapter: WEBFABRIC, title: "Application permissions", body: "Each application's settings and permissions are in Settings, under WebFabric. Applications may add to their own surfaces by default. Dialogs, their own web pages, and anything that changes the simulation require explicit permission." },
  { target: "clock", chapter: SESSION, title: "Simulation time", body: "The clock shows virtual simulation time, with the share of the day beneath it, and the timeline alongside marks the 24-hour day. Selecting the clock switches the whole interface between 12-hour and 24-hour format." },
  { target: "rate", chapter: SESSION, title: "Simulation speed", body: "Speed ranges from 0.25× to 20× the configured playback pace. Adaptive Simulation Backpressure can temporarily apply a lower rate while retaining the requested rate for recovery. A lock indicates that the core is holding the speed." },
  { target: "seed", chapter: SESSION, title: "Reproducible worlds", body: "The seed determines the city district and the deterministic scenario. Selecting the number copies it. Generate asks for confirmation before preparing a replacement; if preparation fails, the current world remains available. A new world starts paused at 00:00." },
  { target: "status", chapter: SESSION, title: "Runtime status", body: "Online indicates that current data is arriving, Degraded indicates stale data or backpressure, and Offline indicates that the simulator is unreachable. Hovering reports measured latency and throughput." },
  { target: "help", chapter: SESSION, title: "Reports and help", body: "Export Report saves an observation of the loaded run with its provenance, model figures and recorded events. About contains the licence and source link. This tutorial can be reopened from here without starting a new world." },
  { target: "transport", chapter: SESSION, title: "Playback", body: "Back and Forward move by the skip interval set in Settings, Step advances by the step interval and holds, and Play resumes. Reset asks for confirmation before returning to 00:00. Start Simulation closes this tutorial and plays the current world." },
];
