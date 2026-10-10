import { BASEMAPS } from "../map/basemaps";

interface Props {
  current: string;
  onChange: (id: string) => void;
}

export function BasemapSwitcher({ current, onChange }: Props) {
  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        zIndex: 10,
        background: "rgba(255,255,255,0.95)",
        borderRadius: 8,
        padding: 8,
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      <select value={current} onChange={(e) => onChange(e.target.value)} style={{ border: "none", background: "transparent" }}>
        {BASEMAPS.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
    </div>
  );
}
