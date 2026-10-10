import { useEffect, useRef } from "react";

interface Props {
  onClose: () => void;
}

// Janela de boas-vindas que abre junto com o mapa. Fecha pelo botão, pelo X,
// com Esc ou tocando fora dela. No celular ocupa a largura da tela (com
// margem) e rola se o texto não couber na altura.
export function WelcomeModal({ onClose }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 20,
        background: "rgba(11, 11, 11, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        // Clique dentro da janela não pode fechar (só o fundo escuro fecha).
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 520,
          maxHeight: "100%",
          overflowY: "auto",
          boxSizing: "border-box",
          background: "#ffffff",
          borderRadius: 12,
          padding: "24px 24px 20px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          fontFamily: "system-ui, sans-serif",
          fontSize: 16,
          lineHeight: 1.55,
          color: "#0b0b0b",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 44,
            height: 44,
            border: "none",
            background: "transparent",
            fontSize: 22,
            color: "#52514e",
            cursor: "pointer",
            borderRadius: 8,
          }}
        >
          ✕
        </button>

        <h1 id="welcome-title" style={{ margin: "0 40px 12px 0", fontSize: 22, lineHeight: 1.25 }}>
          Mapa das Eleições
        </h1>

        <p style={{ margin: "0 0 12px" }}>
          Este é o mapa para as eleições de 2022 e 2026 com os votos no estado de Santa Catarina, incluindo a
          diferença, seja de ganho ou perda de votos, de um candidato que concorreu aos dois pleitos para o mesmo
          cargo.
        </p>
        <p style={{ margin: "0 0 12px" }}>
          O mapa é <strong>adaptativo e ajusta conforme você dá zoom</strong> . Dê zoom para mudar a agregação a nível
          municipal e dê mais zoom para ver o voto por seção eleitoral do TSE.
        </p>
         <p style={{ margin: "0 0 12px" }}>
          Todos os candidatos que concorreram estão na lista, contudo, os candidatos estão ordenados dado
           o seu <strong>nome de registro</strong> ao invés do apelido utilizado durante a campanha.
        </p>
        <p style={{ margin: "0 0 20px" }}>No mapa comparativo, a máxima granularidade é a nível municipal.</p>
        <p style={{ margin: "0 0 20px" }}>Elaborado por: <em>Emanuel Goulart</em>.</p>

        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          style={{
            width: "100%",
            minHeight: 44,
            border: "none",
            borderRadius: 8,
            background: "#2a78d6",
            color: "#ffffff",
            fontSize: 16,
            cursor: "pointer",
          }}
        >
          Explorar o mapa
        </button>
      </div>
    </div>
  );
}
