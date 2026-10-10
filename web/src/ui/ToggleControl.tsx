import type { ReactNode } from "react";

interface Props {
  side: "left" | "right";
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

// Botão sempre visível num canto do mapa que mostra/esconde o controle logo
// abaixo dele -- no celular os painéis cobriam boa parte da tela, assim o
// usuário esconde e vê o estado inteiro. Botão com 44px de altura (alvo de
// toque mínimo confortável pra dedo).
export function ToggleControl({ side, label, open, onToggle, children }: Props) {
  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        [side]: 16,
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        alignItems: side === "left" ? "flex-start" : "flex-end",
        gap: 8,
        maxWidth: "calc(100vw - 32px)",
        // O container é uma caixa que pode ser bem mais larga que o botão (ex.
        // painel aberto); a área vazia dele não pode engolir toque/clique de
        // quem estiver embaixo -- o botão do outro lado ou o próprio mapa.
        pointerEvents: "none",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? `Esconder ${label.toLowerCase()}` : `Mostrar ${label.toLowerCase()}`}
        style={{
          minHeight: 44,
          padding: "0 14px",
          border: "none",
          borderRadius: 8,
          background: "rgba(255,255,255,0.95)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          fontFamily: "system-ui, sans-serif",
          fontSize: 14,
          color: "#0b0b0b",
          cursor: "pointer",
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        {label}
      </button>
      {open && <div style={{ pointerEvents: "auto", maxWidth: "100%" }}>{children}</div>}
    </div>
  );
}
