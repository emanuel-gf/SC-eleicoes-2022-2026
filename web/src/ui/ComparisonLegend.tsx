import { DIVERGING_LEGEND_STOPS } from "../map/color";
import type { ComparacaoMetric } from "../duckdb/queries";

interface Props {
  metric: ComparacaoMetric;
  // Domínio simétrico da escala (max |diff|, ou 1 = 100% no modo %).
  domain: number;
}

const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 0 });

// Sem legenda um mapa divergente não se lê -- não dá pra saber o que é
// "muito azul". Só aparece no modo comparação.
export function ComparisonLegend({ metric, domain }: Props) {
  const { loss, lossMid, neutral, gainMid, gain } = DIVERGING_LEGEND_STOPS;
  const ticks: [number, string][] =
    metric === "pct"
      ? [
          [0, "≤ −100%"],
          [0.5, "0"],
          [1, "≥ +100%"],
        ]
      : [
          [0, `−${compact.format(domain)}`],
          [0.5, "0"],
          [1, `+${compact.format(domain)}`],
        ];

  return (
    <div
      style={{
        position: "absolute",
        bottom: 40,
        right: 16,
        zIndex: 10,
        background: "rgba(255,255,255,0.95)",
        borderRadius: 8,
        padding: "8px 12px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        color: "#52514e",
        width: 240,
      }}
    >
      <div style={{ color: "#0b0b0b", marginBottom: 6 }}>
        {metric === "pct" ? "Variação % 2022 p/ 2026" : "Diferença de votos 2022 p/ 2026"}
      </div>
      <div
        style={{
          height: 10,
          borderRadius: 4,
          background: `linear-gradient(to right, ${loss}, ${lossMid}, ${neutral}, ${gainMid}, ${gain})`,
        }}
      />
      <div style={{ position: "relative", height: 16, marginTop: 3 }}>
        {ticks.map(([pos, label]) => (
          <span
            key={pos}
            style={{
              position: "absolute",
              left: `${pos * 100}%`,
              transform: pos === 0 ? "none" : pos === 1 ? "translateX(-100%)" : "translateX(-50%)",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span>perdeu votos</span>
        <span>ganhou votos</span>
      </div>
      {metric === "diff" && (
        // Diferença absoluta é desenhada com curva raiz (ver diffIntensity em
        // layers.ts): o meio de cada lado da barra vale 1/4 do máximo, não 1/2.
        <div style={{ marginTop: 4, color: "#898781" }}>
          
        </div>
      )}
    </div>
  );
}
