// Caminho de um arquivo de `public/` respeitando o `base` do Vite. No dev o
// site roda na raiz ("/"), mas no GitHub Pages ele fica em
// "/SC-eleicoes-2022-2026/" -- com caminho absoluto "/data/..." tudo daria 404.
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}
