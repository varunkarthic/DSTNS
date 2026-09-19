/**
 * Tutorial content.
 *
 * Targets are semantic `data-tutorial` anchors, never coordinates. Only
 * controls that are always present are included: conditional runtime states
 * such as backpressure indicators or transient notifications are never
 * tutorial targets, because they may not exist while the tour is running.
 * The last step is the playback group, and its action starts the simulation.
 */
export const TUTORIAL_VERSION = "3";

export interface TutorialStep {
  target: string;
  title: string;
  body: string;
}

export const tutorialSteps: readonly TutorialStep[] = [
  {
    target: "map",
    title: "The network",
    body: "This is the live road network. Drag to pan and scroll to zoom. Hover a road, signal or place for its current state. Green is clear, amber moderate, red severe, and blue is flooded.",
  },
  {
    target: "zoom",
    title: "Map tools",
    body: "Zoom, fit the whole network, and search for a place by name. Geometry is in real metres, so zooming changes the picture and never the model.",
  },
  {
    target: "focus",
    title: "Auto Focus",
    body: "Auto Focus follows incidents, flooding and rain, framing each event's full extent. Rain is re-framed as it grows. Double-click to choose Round-Robin or Latest.",
  },
  {
    target: "dnd",
    title: "Do Not Disturb",
    body: "Silences the notification categories you choose in Settings. Every event is still recorded and can be reviewed, silenced or not, in the Notifications tab.",
  },
  {
    target: "settings",
    title: "Settings",
    body: "Auto Focus, Do Not Disturb categories, time format, reduced motion and the playback step sizes are all here.",
  },
  {
    target: "telemetry",
    title: "Live telemetry",
    body: "Network measures at the current instant, with Stack, News, Queue, Incidents and Notifications below. It collapses to a strip of compact figures, and each list then opens beside it without reopening the panel.",
  },
  {
    target: "layers",
    title: "Layers",
    body: "Choose what the map draws: traffic, signals, buildings, weather, flooding and more. Layers change the picture only, never the simulation.",
  },
  {
    target: "places",
    title: "Place legend",
    body: "Every marker the map draws, what it stands for, how many there are, and the demand the simulation models for it. Unclassified points are hidden until you ask for them.",
  },
  {
    target: "clock",
    title: "Time and progress",
    body: "The current simulation time. The outline fills as the day completes; hover for the percentage. Click to switch between 12 and 24 hour time everywhere.",
  },
  {
    target: "rate",
    title: "Speed",
    body: "Choose 0.25× to 10× the configured pace. The applied speed can be held lower while the interface catches up; your choice is restored automatically.",
  },
  {
    target: "seed",
    title: "Seed and new worlds",
    body: "The seed determines the city, district, weather and incidents. Click it to copy. The arrows generate a new world from a fresh seed.",
  },
  {
    target: "status",
    title: "Runtime status",
    body: "Online when data is current, Degraded when the interface is catching up, Offline when the simulator cannot be reached.",
  },
  {
    target: "transport",
    title: "You're ready.",
    body: "Back and Forward skip through the day, Step advances and holds, and Reset returns to 00:00. Start the simulation when you are ready to begin.",
  },
];
