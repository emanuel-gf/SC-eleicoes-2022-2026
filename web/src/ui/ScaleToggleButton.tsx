interface Props {
  visible: boolean;
  onToggle: () => void;
}

export function ScaleToggleButton({ visible, onToggle }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={visible ? "Esconder escala" : "Mostrar escala"}
      style={{
        position: "absolute",
        bottom: 16,
        left: 16,
        zIndex: 10,
        background: "rgba(255,255,255,0.95)",
        border: "none",
        borderRadius: 8,
        padding: "6px 10px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      {visible ? "Esconder escala" : "Mostrar escala"}
    </button>
  );
}
