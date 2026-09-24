import { useEffect, useState } from "react";
import { startSession, type Screen } from "./session";

function shortcutPlace(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) return "your Start menu";
  if (ua.includes("mac")) return "your Applications folder";
  return "your app menu";
}

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  useEffect(() => {
    startSession(location.hash, (u, i) => fetch(u, i)).then(setScreen);
    // The code is single-use; keep it out of history and bookmarks.
    history.replaceState(null, "", location.pathname);
  }, []);

  if (screen === "loading") return <main className="center"><p className="muted">One moment...</p></main>;
  if (screen === "signed-out") {
    return (
      <main className="center">
        <h1>Open Cinderpaw from its shortcut to sign in.</h1>
        <p className="muted">Look for it in {shortcutPlace()}:</p>
        <div className="shortcut" aria-hidden="true">
          <span className="icon">🔥</span>
          <span>Cinderpaw</span>
        </div>
      </main>
    );
  }
  return (
    <main className="center">
      <h1>Cinderpaw is running on your computer.</h1>
      <p className="muted">You can leave this page open.</p>
    </main>
  );
}
