import { useEffect, useRef, useState } from "react";
import { streamChat } from "./chatStream";
import { COPY } from "./copy";
import {
  commonFirst, fetchApi, firstOffers, load, manualCandidate, save, tryCandidate, tryKey,
  type Candidate, type KeyResult, type Provider, type Step,
} from "./onboarding";

type Tool = { id: string; tool: string; ok?: boolean };
type Line = {
  who: "agent" | "person";
  text: string;
  details?: string;
  link?: { href: string; label: string };
  reasoning?: string;
  tools?: Tool[];
};

/** "web_search" reads as "web search" to someone who has never seen code. */
const plain = (tool: string) => tool.replace(/[_.]/g, " ");

const api = fetchApi();
const OPENROUTER_KEYS = "https://openrouter.ai/keys";
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const pause = (ms: number) => new Promise((r) => setTimeout(r, reducedMotion() ? 0 : ms));

export function OnboardingChat() {
  const [lines, setLines] = useState<Line[]>([]);
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [local, setLocal] = useState<Candidate | undefined>();
  const [open, setOpen] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [answering, setAnswering] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const add = (l: Line) => setLines((ls) => [...ls, l]);
  const say = async (text: string, extra: Partial<Line> = {}) => {
    await pause(450);
    add({ who: "agent", text, ...extra });
  };
  const go = (s: Step, n = name, p = provider) => {
    setStep(s);
    save(localStorage, { step: s, name: n, providerId: p?.id });
  };

  // A block body on purpose: current Chrome returns a Promise from
  // scrollIntoView, and an effect that returns one makes React call it as a
  // cleanup function, which blanks the whole page.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines, step, busy, showAll]);

  useEffect(() => {
    const saved = load(localStorage);
    add({ who: "agent", text: COPY.hello });
    if (!saved?.name) return setStep("name");
    setName(saved.name);
    add({ who: "person", text: saved.name });
    if (saved.step === "done") {
      add({ who: "agent", text: COPY.awake(saved.name) });
      return setStep("done");
    }
    if (saved.step === "key" && saved.providerId) {
      api.catalog().then((all) => {
        const p = all.find((x) => x.id === saved.providerId) ?? null;
        setProviders(all);
        setProvider(p);
        if (p) add({ who: "agent", text: COPY.pasteKey(p.name) });
        setStep(p ? "key" : "brain");
      }).catch(() => askBrain(saved.name));
      return;
    }
    askBrain(saved.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finish(n: string, r: KeyResult) {
    if (!r.ok) return;
    if (r.mask) add({ who: "agent", text: COPY.savedAs(r.mask) });
    await say(COPY.itWorks);
    await say(COPY.awake(n));
    go("done", n);
  }

  /** Talk to the real agent (spec §6.1): same engine, same "chat" session as the terminal. */
  async function sendChat(raw: string) {
    const text = raw.trim();
    if (!text || answering) return;
    add({ who: "person", text });
    add({ who: "agent", text: "", tools: [] });
    setAnswering(true);
    const patch = (fn: (l: Line) => Line) =>
      setLines((ls) => [...ls.slice(0, -1), fn(ls[ls.length - 1])]);
    await streamChat((u, i) => fetch(u, i), text, (e) => {
      if (e.type === "text") patch((l) => ({ ...l, text: l.text + e.text }));
      else if (e.type === "reasoning") patch((l) => ({ ...l, reasoning: (l.reasoning ?? "") + e.text }));
      else if (e.type === "tool_start") patch((l) => ({ ...l, tools: [...(l.tools ?? []), { id: e.id, tool: e.tool }] }));
      else if (e.type === "tool_done")
        patch((l) => ({ ...l, tools: (l.tools ?? []).map((t) => (t.id === e.id ? { ...t, ok: e.ok } : t)) }));
      else if (e.type === "error")
        patch((l) => ({ ...l, text: l.text ? `${l.text}\n\n${COPY.chatError}` : COPY.chatError, details: e.detail }));
    });
    setAnswering(false);
  }

  function fail(r: KeyResult) {
    if (!r.ok) add({ who: "agent", text: r.line, details: r.details });
  }

  async function askBrain(n: string) {
    setBusy(true);
    const offers = await firstOffers(api);
    setLocal(offers.local);
    if (offers.existing) {
      await say(COPY.existingFound(offers.existing.label));
      await say(COPY.trying);
      const r = await tryCandidate(api, offers.existing);
      if (r.ok) {
        setBusy(false);
        return finish(n, r);
      }
    }
    await say(COPY.brain);
    if (offers.local) await say(COPY.localFound);
    setBusy(false);
    go("brain", n);
  }

  async function submitName(raw: string) {
    const n = raw.trim();
    if (!n) return;
    setName(n);
    add({ who: "person", text: n });
    await say(COPY.niceToMeet(n));
    askBrain(n);
  }

  async function showMe() {
    add({ who: "person", text: COPY.showMe });
    setBusy(true);
    const all = await api.catalog().catch(() => [] as Provider[]);
    const p = all.find((x) => x.id === "openrouter") ?? null;
    for (const [i, s] of COPY.showMeSteps.entries()) {
      await say(s, i === 1 ? { link: { href: p?.console_url ?? OPENROUTER_KEYS, label: COPY.openOpenRouter } } : {});
    }
    setBusy(false);
    if (p) {
      setProvider(p);
      go("key", name, p);
    } else {
      await say(COPY.offline);
      go("brain");
    }
  }

  async function haveKey() {
    add({ who: "person", text: COPY.haveKey });
    setBusy(true);
    try {
      setProviders(await api.catalog());
      await say(COPY.pickProvider);
      go("pick-provider");
    } catch {
      await say(COPY.offline);
    }
    setBusy(false);
  }

  async function pick(p: Provider) {
    add({ who: "person", text: p.name });
    setProvider(p);
    await say(COPY.pasteKey(p.name));
    go("key", name, p);
  }

  async function submitKey(raw: string) {
    if (!provider || !raw.trim()) return;
    add({ who: "person", text: "••••••••" });
    setBusy(true);
    await say(COPY.trying);
    const r = await tryKey(api, manualCandidate(provider), raw);
    setBusy(false);
    if (r.ok) return finish(name, r);
    fail(r);
  }

  async function useLocal() {
    if (!local) return;
    add({ who: "person", text: COPY.useLocal });
    setBusy(true);
    await say(COPY.trying);
    const r = await tryCandidate(api, local);
    setBusy(false);
    if (r.ok) return finish(name, r);
    fail(r);
  }

  return (
    <main className="chat">
      <div className="thread" aria-live="polite">
        {lines.map((l, i) => (
          <div key={i} className={`bubble ${l.who}`}>
            {l.reasoning && (
              <details className="reasoning">
                <summary>{COPY.thinking}</summary>
                <p>{l.reasoning}</p>
              </details>
            )}
            {l.tools?.map((t) => (
              <p key={t.id} className={`tool ${t.ok === false ? "bad" : ""}`}>
                {t.ok === undefined ? "⏳" : t.ok ? "✓" : "✗"}{" "}
                {t.ok === false ? COPY.toolFailed(plain(t.tool)) : COPY.working(plain(t.tool))}
              </p>
            ))}
            {(l.text || !l.tools) && <p className="text">{l.text || "…"}</p>}
            {l.link && (
              <a className="button" href={l.link.href} target="_blank" rel="noopener noreferrer">
                {l.link.label}
              </a>
            )}
            {l.details && (
              <>
                <button type="button" className="link" onClick={() => setOpen(open === i ? null : i)}>
                  {open === i ? COPY.hideDetails : COPY.showDetails}
                </button>
                {open === i && <pre className="details">{l.details}</pre>}
              </>
            )}
          </div>
        ))}
        {busy && <div className="bubble agent typing" aria-label="Cinderpaw is typing">…</div>}
        <div ref={endRef} className="end" />
      </div>

      {!busy && (
        <div className="controls">
          {step === "name" && <TextForm placeholder={COPY.namePlaceholder} send={COPY.nameSend} onSend={submitName} />}
          {step === "brain" && (
            <div className="choices">
              <button type="button" className="button big" onClick={showMe}>{COPY.showMe}</button>
              <button type="button" className="button quiet" onClick={haveKey}>{COPY.haveKey}</button>
              {local && <button type="button" className="button quiet" onClick={useLocal}>{COPY.useLocal}</button>}
            </div>
          )}
          {step === "pick-provider" && (
            <div className="choices wrap">
              {(showAll ? [...commonFirst(providers).common, ...commonFirst(providers).rest] : commonFirst(providers).common).map((p) => (
                <button key={p.id} type="button" className="button quiet" onClick={() => pick(p)}>{p.name}</button>
              ))}
              {!showAll && commonFirst(providers).rest.length > 0 && (
                <button type="button" className="link" onClick={() => setShowAll(true)}>{COPY.moreProviders}</button>
              )}
            </div>
          )}
          {step === "key" && <TextForm secret placeholder={COPY.keyPlaceholder} send={COPY.keySave} onSend={submitKey} />}
          {step === "done" && (
            <TextForm placeholder={COPY.messagePlaceholder} send={COPY.send} onSend={sendChat} disabled={answering} />
          )}
        </div>
      )}
    </main>
  );
}

function TextForm(props: { placeholder: string; send: string; secret?: boolean; disabled?: boolean; onSend: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="textform"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.disabled) return;
        props.onSend(v);
        setV("");
      }}
    >
      <input
        autoFocus
        type={props.secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        aria-label={props.placeholder}
        placeholder={props.placeholder}
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <button type="submit" className="button" disabled={!v.trim() || props.disabled}>{props.send}</button>
    </form>
  );
}
