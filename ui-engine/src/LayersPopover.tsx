import { useEffect, useRef } from "react";
import { defaultLayers } from "./types";
import type { Layers, Snapshot, Topology } from "./types";

/**
 * Display layers are a frontend concern only. Toggling one changes what the
 * canvas draws; none of it is sent to the simulation core, and none of it
 * changes what the core computes.
 */
type Props = {
  layers: Layers;
  onChange: (layers: Layers) => void;
  onClose: () => void;
  topology: Topology | null;
  snapshot: Snapshot | null;
};

type Group = { title: string; items: [keyof Layers, string][] };

export function LayersPopover({
  layers,
  onChange,
  onClose,
  topology,
  snapshot,
}: Props) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      // The trigger button toggles the popover itself; ignore clicks on it.
      if (target instanceof Element && target.closest("[data-layers-trigger]"))
        return;
      if (target && !panel.current?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const vehicles =
    snapshot?.edges.reduce((sum, e) => sum + e.vehicle_count, 0) ?? 0;

  // Every layer the renderer honours, listed exactly once.
  const groups: Group[] = [
    {
      title: "Network",
      items: [
        ["roads", "Roads & links"],
        ["signals", "Traffic signals"],
        ["labels", "Street names"],
      ],
    },
    {
      title: "Traffic",
      items: [
        ["traffic", "Congestion colouring"],
        ["vehicles", `Flow markers (${vehicles.toLocaleString()} veh)`],
        ["buildings", `Places (${(topology?.features.length ?? 0).toLocaleString()})`],
      ],
    },
    {
      title: "Environment",
      items: [
        ["weather", "Weather cells"],
        ["flooding", "Flood hazard"],
      ],
    },
    {
      title: "Events",
      items: [
        ["incidents", `Incidents (${snapshot?.active_incidents.length ?? 0})`],
        ["events", "Demand events"],
      ],
    },
  ];

  const setAll = (value: boolean) =>
    onChange(
      Object.fromEntries(
        Object.keys(layers).map((k) => [k, value]),
      ) as unknown as Layers,
    );

  return (
    <div
      ref={panel}
      className="layers-popover"
      role="dialog"
      aria-label="Display layers"
    >
      <header>
        <span className="title">Display Layers</span>
        <div className="actions">
          <button type="button" className="text-button" onClick={() => setAll(true)}>
            Enable All
          </button>
          <span style={{ color: "var(--outline-variant)" }}>•</span>
          <button
            type="button"
            className="text-button muted"
            onClick={() => onChange({ ...defaultLayers })}
          >
            Reset
          </button>
        </div>
      </header>
      <div className="layer-groups">
        {groups.map((group) => (
          <div className="layer-group" key={group.title}>
            <span className="eyebrow">{group.title}</span>
            {group.items.map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={layers[key]}
                  onChange={(e) =>
                    onChange({ ...layers, [key]: e.target.checked })
                  }
                />
                {label}
              </label>
            ))}
          </div>
        ))}
      </div>
      <p
        className="t-body-sm"
        style={{
          margin: "12px 0 0",
          color: "var(--on-surface-variant)",
          borderTop: "1px solid rgb(60 73 77 / 30%)",
          paddingTop: 10,
        }}
      >
        Display only — these toggles change what is drawn, never what the
        simulation computes.
      </p>
    </div>
  );
}
