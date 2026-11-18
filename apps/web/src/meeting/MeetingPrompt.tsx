// Feedback 18. 11.: Inhalt des kleinen Fensters oben rechts, wenn eine Meeting-App das Mikrofon einschaltet (Mac-App,
// detect.ts). Sieht aus wie ein Hinweis (elements.md, Abschnitt 4): Fläche und Schatten wie das Menü. Die Antwort geht
// ans Hauptfenster; das schließt dieses Fenster.
import { BasedButton } from "@based/ui/astryx";
import { useEffect } from "react";
import { PROMPT_ANSWER, promptText, type PromptAnswer } from "./detect.js";
import "./prompt.css";

async function answer(a: PromptAnswer) {
  try {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("main", PROMPT_ANSWER, a);
  } catch {
    // Hauptfenster weg: dann bleibt nur zu
  }
}

export function MeetingPrompt({ app }: { app: string }) {
  const text = promptText(app);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void answer("dismiss");
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <section className="meeting-prompt" aria-label={text.title} data-testid="meeting-prompt">
      <header className="meeting-prompt-head">
        <span className="meeting-prompt-dot" aria-hidden />
        <span className="meeting-prompt-title">{text.title}</span>
      </header>
      <p className="meeting-prompt-detail">{text.detail}</p>
      <footer className="meeting-prompt-actions">
        <BasedButton label="Not now" variant="ghost" onClick={() => void answer("dismiss")} />
        <BasedButton label="Start transcribing" variant="primary" onClick={() => void answer("start")} />
      </footer>
    </section>
  );
}
