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
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (SEQUENTIAL_BLUE_RGB.length - 1);
  const i = Math.floor(scaled);
  const frac = scaled - i;
  const a = SEQUENTIAL_BLUE_RGB[i];
  const b = SEQUENTIAL_BLUE_RGB[Math.min(i + 1, SEQUENTIAL_BLUE_RGB.length - 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

export function shareColor(share: number | null | undefined, maxShare: number): [number, number, number] {
  if (share == null || maxShare <= 0) return NO_DATA_COLOR;
  return sequentialBlue(share / maxShare);
}
