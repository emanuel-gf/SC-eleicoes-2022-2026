// Rampa sequencial azul (claro -> escuro) do design system de referência --
// ver skill "dataviz": magnitude usa um hue só, nunca arco-íris.
const SEQUENTIAL_BLUE_HEX = [
  "#cde2fb",
  "#b7d3f6",
  "#9ec5f4",
  "#86b6ef",
  "#6da7ec",
  "#5598e7",
  "#3987e5",
  "#2a78d6",
  "#256abf",
  "#1c5cab",
  "#184f95",
  "#104281",
  "#0d366b",
];

const NO_DATA_COLOR: [number, number, number] = [214, 211, 204];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const SEQUENTIAL_BLUE_RGB = SEQUENTIAL_BLUE_HEX.map(hexToRgb);

/** t em [0, 1] -> cor RGB interpolada na rampa sequencial. */
export function sequentialBlue(t: number): [number, number, number] {
  return interpolate(SEQUENTIAL_BLUE_RGB, t);
}

export function shareColor(share: number | null | undefined, maxShare: number): [number, number, number] {
  if (share == null || maxShare <= 0) return NO_DATA_COLOR;
  return sequentialBlue(share / maxShare);
}

// Divergente azul (ganhou votos) <-> vermelho (perdeu), meio cinza neutro --
// par divergente da skill "dataviz" (dois matizes + cinza no meio; nunca
// vermelho/verde, que daltônico não separa). O braço azul são passos da rampa
// sequencial acima; o vermelho foi montado com a MESMA luminosidade OKLab
// passo a passo (diferença <= 0,012), pra +N e -N pesarem igual no olho.
const DIVERGING_NEUTRAL = "#f0efec";
const DIVERGING_BLUE_HEX = ["#b7d3f6", "#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"];
const DIVERGING_RED_HEX = ["#f6c6bd", "#f0998b", "#e86a5c", "#d0403d", "#a92e2e", "#7d2020"];

const DIVERGING_BLUE_RGB = [DIVERGING_NEUTRAL, ...DIVERGING_BLUE_HEX].map(hexToRgb);
const DIVERGING_RED_RGB = [DIVERGING_NEUTRAL, ...DIVERGING_RED_HEX].map(hexToRgb);

function interpolate(ramp: [number, number, number][], t: number): [number, number, number] {
  const scaled = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.floor(scaled);
  const frac = scaled - i;
  const a = ramp[i];
  const b = ramp[Math.min(i + 1, ramp.length - 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

/** t em [-1, 1]: negativo = perda (vermelho), positivo = ganho (azul), 0 = cinza. */
export function divergingColor(t: number): [number, number, number] {
  return t >= 0 ? interpolate(DIVERGING_BLUE_RGB, t) : interpolate(DIVERGING_RED_RGB, -t);
}

export const DIVERGING_LEGEND_STOPS = {
  loss: DIVERGING_RED_HEX[DIVERGING_RED_HEX.length - 1],
  lossMid: DIVERGING_RED_HEX[2],
  neutral: DIVERGING_NEUTRAL,
  gainMid: DIVERGING_BLUE_HEX[2],
  gain: DIVERGING_BLUE_HEX[DIVERGING_BLUE_HEX.length - 1],
};

export { NO_DATA_COLOR };
