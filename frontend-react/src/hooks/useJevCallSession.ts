import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useBrowser } from '@/stores/browser';
import { tauri } from '@/lib/tauri';
import { useSpeechPlayer } from './useSpeechPlayer';
import { saveVoiceBlobToDisk, transcribeVoiceBlob } from './useSendMessage';
import { rms, isVoiced, TRAIL_SILENCE_MS, MAX_UTTERANCE_MS, NO_SPEECH_TIMEOUT_MS } from '@/lib/vad';
import { decide, earlyFingerprint, runsLeft, execute, installedApps, interpretReply, resetTarget, splitSteps, DESKTOP_CONTROL_OFF, DESKTOP_NO_TREE, MIN_CONFIDENCE, MIN_EARLY_CONFIDENCE, MIN_CLICK_ACTION_CONFIDENCE } from '@/lib/jev';
import { chime, decodeToPcm16k, wavBlob } from '@/lib/audio';
import { forSpeech, isLikelyHallucination } from '@/lib/speechText';
import { ensureSttModel } from '@/lib/voiceModel';
import { t } from '@/lib/i18n';
import { useAskUser, voiceAnswerFor } from '@/stores/askUser';
import { requestCinderpawStop } from '@/lib/cinderpawAgentStream';
import type { CallPhase, CallStage } from './useCallSession';

/**
 * A Jev call: listen → transcribe → Jev picks the command → execute → a word
 * back. No conversation model in the loop; that is what makes a command land
 * in under a second instead of after a full spoken answer.
 *
 * Shares the shape of the other call hooks so the overlay and the call pill
 * need no branch. `heard` is the transcript, `said` the confirmation. What
 * Jev does not recognise as a browser command is handed to `fallback` (the
 * agent, as a typed message), and the confirmation says so.
 */
const FRAME_MS = 60;
/**
 * Into the terminal that runs the app as well as the webview console: the
 * timings of a call (transcription, Jev, what ran early) are otherwise only
 * readable with the devtools open, on the machine, by the person testing.
 * Fire-and-forget, the way the conversation call logs; never a failed turn.
 */
const log = (message: string) => {
  console.info(`[jev] ${message}`);
  void tauri.raw.uiLog('jev', message).catch(() => {});
};
/**
 * A command can be one word. The conversation VAD wants 250 ms of voice before
 * it sends anything, and a plain "stop" is under that, so it never reached the
 * transcriber (21 Sep). Same trailing silence, same caps; only the floor moves.
 */
const MIN_COMMAND_VOICED_MS = 120;
/**
 * A pause this long inside a sentence sends what was said so far to the
 * transcriber and to Jev, while the sentence goes on. Shorter than the 900 ms
 * that ends a command: the point is that "open Spotify" is running before
 * "and play something" is out. Under this, a pause is a syllable.
 */
const PARTIAL_SILENCE_MS = 300;
/**
 * And this much voice with no pause at all sends one too: a sentence said in
 * one breath never pauses, and the demo it chases opens the browser on the
 * first syllable of the word (22 Sep). The transcriber usually completes a
 * cut word; Jev picks from the list of apps and sites, not from letters, and
 * below MIN_CONFIDENCE nothing runs. Each one is a transcription and a Jev
 * request (~$0.0001); a five-second sentence makes about ten.
 */
const PARTIAL_VOICED_MS = 700;
/**
 * A partial costs a request, and the cloud transcriber counts them: Groq's free
 * tier allows 20 a minute, and a round of six sentences hit the limit twice
 * (22 Sep). Under this much new voice, whatever was said is a syllable, not a
 * step: waiting for the pause is both cheaper and more likely to be a word.
 */
const MIN_PARTIAL_GROWTH_MS = 500;

/**
 * What execute says back is either the action done ("Opening YouTube.", or
 * nothing at all) or why it was not ("I could not find...", "Desktop control
 * is off..."). The chime has to tell the two apart before any voice does.
 */
export function toneFor(line: string): 'ok' | 'fail' {
  // "3 matches for pricing." is `find` succeeding: it chimed as a failure,
  // was spoken as one, and ended the rest of a chain that was going fine.
  // The window and screenshot replies are successes too, for the same reason.
  return !line || /^(Opening|Searching|Switching|Typing|Closing|Minimising|Maximising|Pick the area)\b|^\d+ match(es)? for /.test(line) ? 'ok' : 'fail';
}

/**
 * Why a sentence could not be transcribed, in the words the pipeline call
 * uses for the same failures. The codes are the host's; a person hears none
 * of them. A missing on-device model starts its own download, the way the
 * pipeline call does: without that, every sentence reported the same thing
 * and nothing ever fetched it.
 */
function transcriptionFault(e: unknown): string {
  const code = e instanceof Error ? e.message : String(e);
  if (code === 'model-missing') { void ensureSttModel(); return t('voice.modelDownloading'); }
  if (code === 'voice-unavailable' || code === 'stt-no-key') return `${t('voice.provider.title')}: ${t('voice.unsupported')}`;
  if (code === 'stt-cloud-failed') return t('voice.cloudFailed');
  return `${t('call.turnFailed')} (${code})`;
}

/**
 * What to say when an action fails. One reason is a sentence for the person
 * (desktop control is off, and where the switch is); it is said as it is, in
 * the pill too. Anything else is the host's wording and gets the short line;
 * the full text still lands in the notice.
 */
function spokenFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg === DESKTOP_CONTROL_OFF || msg === DESKTOP_NO_TREE || / is in front, and I never control /.test(msg) ? msg : 'That did not work.';
}

/** A Jev request that failed, in words for the person; the codes are the host's (`jev_decide`). */
function jevFault(e: unknown): string {
  const code = e instanceof Error ? e.message : String(e);
  if (code.includes('jev-no-key')) return 'Jev has no key. Add one on the call screen.';
  if (/jev-http-40[13]/.test(code)) return 'Jev refused the key. Check it on the call screen.';
  if (code.includes('jev-http-402')) return 'Jev is out of credit on this key.';
  if (code.includes('jev-http-429')) return 'Jev is busy. Say that again in a moment.';
  if (code.includes('jev-unreachable')) return 'Jev could not be reached. Check the connection.';
  return 'Jev did not answer. Say that again.';
}

/** Cinder's reply, cut for the ear: plain words, two sentences or so. */
export function spokenReply(markdown: string): string {
  const text = forSpeech(markdown).replace(/\s+/g, ' ').trim();
  if (text.length <= 240) return text;
  const cut = text.slice(0, 240);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/**
 * The agent's reply to the message just sent in chat `sid`, once it has
 * finished. The send returns as soon as the message is on its way, so the
 * reply is read off the chat when the stream stops: ten minutes at most, then
 * whatever is there. Another chat opened meanwhile has another last message,
 * which is nobody's answer to this: nothing is read then.
 */
async function agentReply(sid: string): Promise<string> {
  const deadline = Date.now() + 10 * 60_000;
  while (useChat.getState().streamStatus === 'streaming' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
  }
  if (useChat.getState().sessionId !== sid) return '';
  const last = [...useChat.getState().messages].reverse().find((m) => m.role === 'assistant');
  return last?.content ?? '';
}

/** Does `whole` keep at least half the words of `part`? Punctuation and case aside. */
export function keepsWordsOf(part: string, whole: string): boolean {
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const have = new Set(words(whole));
  const need = words(part);
  if (need.length === 0) return true;
  return need.filter((w) => have.has(w)).length * 2 >= need.length;
}

function commandEnded({ spoke, voicedMs, silenceMs, elapsedMs }: { spoke: boolean; voicedMs: number; silenceMs: number; elapsedMs: number }): 'continue' | 'end' | 'abort' {
  const worth = voicedMs >= MIN_COMMAND_VOICED_MS;
  if (spoke && silenceMs >= TRAIL_SILENCE_MS) return worth ? 'end' : 'abort';
  if (elapsedMs >= MAX_UTTERANCE_MS) return worth ? 'end' : 'abort';
  if (!spoke && elapsedMs >= NO_SPEECH_TIMEOUT_MS) return 'abort';
  return 'continue';
}

export function useJevCallSession(fallback: (text: string) => Promise<void>) {
  const sessionId = useChat((s) => s.sessionId);
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  /** The handoff the overlay keeps on screen: what went to Cinder, and what came back. Plain display, no phases. */
  const [handoffText, setHandoffText] = useState('');
  const [handoffReply, setHandoffReply] = useState('');
  const [level, setLevel] = useState(0);
  const [youSpeaking, setYouSpeaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  /** A line is being spoken: the phase says so while it lasts, and only then. */
  const [talking, setTalking] = useState(false);
  const { beginSpeech, feedSpeech, endSpeech, stop: stopSpeech } = useSpeechPlayer(sessionId);

  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const muteRef = useRef(false);
  /**
   * Lines being spoken right now. The microphone is deaf while this is above
   * zero: a question read aloud ("Allow the agent to click...? Options: Allow,
   * Deny.") was otherwise heard by the call itself and could answer itself.
   * Jev's own lines are short; there is no barge-in on them.
   */
  const speaking = useRef(0);
  /** True while a sentence handed to Cinder is being worked on. */
  const agentBusy = useRef(false);
  /** Set when "stop" ended Cinder's run: what it had written by then is not its answer. */
  const agentStopped = useRef(false);
  const hangUpRef = useRef<() => void>(() => {});
  /** The last partial's text and Jev's first answer on it, for the final to reuse. */
  const lastDecision = useRef<{ text: string; first: Awaited<ReturnType<typeof decide>> } | null>(null);
  /** Bumped on hang-up: a loop that sees a different number stops. */
  const generation = useRef(0);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  const releaseMic = useCallback(() => {
    try { recorder.current?.stop(); } catch { /* not recording */ }
    recorder.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void ctx.current?.close().catch(() => {});
    ctx.current = null;
    analyser.current = null;
  }, []);

  /**
   * One utterance, or null when nothing worth sending was said. `onPartial`
   * gets everything recorded so far at each short pause inside the sentence
   * (a breath between "open Spotify" and "and play..."): the whole recording
   * from the start, not the last piece, so no word is cut in half.
   */
  const listenOnce = useCallback((mine: number, onPartial: (blob: Blob) => void) => new Promise<{ blob: Blob; sincePartial: boolean } | null>((resolve) => {
    const s = stream.current;
    const a = analyser.current;
    if (!s || !a) return resolve(null);
    const rec = new MediaRecorder(s);
    recorder.current = rec;
    const chunks: Blob[] = [];
    let partialDue = false;
    /** Whether a partial has gone out at all, and whether voice came after the last one. */
    let anyPartial = false;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
      // Delivered only after `requestData`: the blob is built here, once the
      // piece up to the pause is in, not on the tick that asked for it.
      if (partialDue) { partialDue = false; onPartial(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })); }
    };
    const frame = new Float32Array(a.fftSize);
    const startedAt = Date.now();
    let spoke = false;
    let voiced = false;
    let voicedMs = 0;
    let quietSince = startedAt;
    /** Voice heard since the last partial, in ms: a longer pause sends nothing new twice. */
    let voicedSincePartial = 0;
    let verdict: 'continue' | 'end' | 'abort' = 'continue';
    const timer = window.setInterval(() => {
      if (generation.current !== mine) { verdict = 'abort'; rec.stop(); return; }
      // A line began while the person was mid-sentence (Cinder's reply lands
      // whenever it lands): the recording now holds that voice too, and read
      // back as a command it could act on words nobody said. Dropped.
      if (spoke && speaking.current > 0) { verdict = 'abort'; rec.stop(); return; }
      a.getFloatTimeDomainData(frame);
      const loud = muteRef.current || speaking.current > 0 ? 0 : rms(frame);
      setLevel(Math.min(1, loud * 8));
      voiced = isVoiced(loud, voiced);
      if (voiced) { spoke = true; voicedMs += FRAME_MS; quietSince = Date.now(); voicedSincePartial += FRAME_MS; }
      setYouSpeaking(voiced);
      const silenceMs = Date.now() - quietSince;
      verdict = commandEnded({ spoke, voicedMs, silenceMs, elapsedMs: Date.now() - startedAt });
      if (verdict !== 'continue') { rec.stop(); return; }
      // A partial at every short pause, and every PARTIAL_VOICED_MS of voice
      // without one: "open the browser" is running at "brow-", not after it.
      if (voicedSincePartial >= MIN_PARTIAL_GROWTH_MS && voicedMs >= MIN_COMMAND_VOICED_MS && (silenceMs >= PARTIAL_SILENCE_MS || voicedSincePartial >= PARTIAL_VOICED_MS)) {
        voicedSincePartial = 0;
        anyPartial = true;
        partialDue = true;
        rec.requestData();
      }
    }, FRAME_MS);
    rec.onstop = () => {
      window.clearInterval(timer);
      setYouSpeaking(false);
      // Every listen leaves a trace: "stop" said fifteen times and nothing
      // transcribed (21 Sep) is only diagnosable if the VAD says what it saw.
      if (verdict !== 'continue' || spoke) log(`listen ${verdict}: voiced ${voicedMs}ms over ${Date.now() - startedAt}ms`);
      resolve(verdict === 'end' ? { blob: new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), sincePartial: !anyPartial || voicedSincePartial > 0 } : null);
    };
    rec.start();
  }), []);

  /** The chime lands first and always; the spoken line follows when a voice engine exists. */
  const speak = useCallback(async (text: string, tone: 'ok' | 'fail' = 'ok') => {
    chime(tone);
    if (!text) return;
    setSaid(text);
    speaking.current += 1;
    setTalking(true);
    try {
      const ui = useUI.getState();
      await beginSpeech({ provider: ui.ttsProvider ?? undefined, voice: ui.ttsProvider ? ui.ttsVoice[ui.ttsProvider] : undefined });
      feedSpeech(text);
      await endSpeech();
    } catch {
      // No voice engine: the line is on screen in the pill and the overlay.
    } finally {
      speaking.current -= 1;
      if (speaking.current === 0) setTalking(false);
    }
  }, [beginSpeech, feedSpeech, endSpeech]);

  /**
   * A result that needs no voice: the chime and the line on the pill. Saying
   * "Opening YouTube in your browser" out loud kept the microphone closed for
   * two seconds after every command, while the page itself was the answer.
   * Failures and questions are still spoken.
   */
  const show = useCallback((text: string) => {
    chime('ok');
    if (text) setSaid(text);
  }, []);

  /**
   * A sentence Jev has no action for, handed to Cinder, and Cinder's reply
   * brought back to the pill and the speaker. It was sent and forgotten: with
   * the app parked, the answer landed in a chat nobody could see (21 Sep).
   * Not awaited by the listening loop: Cinder can take minutes and can ask a
   * question, which the loop has to be listening to hear.
   */
  const handOff = useCallback(async (text: string, mine: number) => {
    if (agentBusy.current) {
      // A second message would stop the first: a fresh send interrupts the
      // run in flight, so a video talking in the background, judged "for
      // Cinder", could kill a task half done.
      await speak('Cinder is still on the last one.', 'fail');
      return;
    }
    agentBusy.current = true;
    agentStopped.current = false;
    // The card keeps the pair on screen: the loop's next sentence rewrites `said`.
    setHandoffText(text);
    setHandoffReply('');
    show('Cinder is on it.');
    try {
      const sid = useChat.getState().sessionId;
      await fallbackRef.current(text);
      const reply = await agentReply(sid);
      if (generation.current === mine && !agentStopped.current && reply.trim()) {
        const out = spokenReply(reply);
        setHandoffReply(out);
        await speak(out);
      }
    } catch (e) {
      log(`hand-off to Cinder failed: ${String(e)}`);
      // The card would otherwise say "Cinder is on it." until the next handoff.
      setHandoffReply('Cinder could not take that.');
      if (generation.current === mine) await speak('Cinder could not take that.', 'fail');
    } finally {
      agentBusy.current = false;
    }
  }, [speak, show]);

  /**
   * With a question from Cinder open, is this sentence the answer? Jev reads
   * it against the options in whatever language it was said (see
   * `interpretReply`). Speech that is not an answer is not taken as one: a
   * command goes on as a command, a video talking is dropped by the
   * `addressed` check after. Without Jev, the words decide, as before.
   */
  const answerAsk = useCallback(async (text: string): Promise<boolean> => {
    const ask = useAskUser.getState().pending;
    if (!ask || ask.questions.length !== 1) return false;
    const q = ask.questions[0];
    const read = await interpretReply(q, text).catch(() => null);
    if (read && !read.reply) { log(`ask ${ask.id}: not an answer, taken as a command`); return false; }
    // Answered on the pill while Jev was reading it: nothing left to answer.
    if (useAskUser.getState().pending?.id !== ask.id) return true;
    const answer = !read ? voiceAnswerFor(q, text)
      : read.selected.length ? { question: q.question, selected: read.selected }
        : { question: q.question, selected: [], customText: text };
    setHeard(text);
    setSaid('');
    log(`ask ${ask.id} answered by voice: ${answer.selected.length ? answer.selected.join(', ') : 'in their own words'}`);
    useAskUser.getState().submit([answer]);
    chime('ok');
    return true;
  }, []);

  /**
   * One sentence, spoken or typed, through Jev and on to what it asks for. A
   * chain ("open youtube, search for X, then click the first one") is one
   * sentence and several steps: Jev says whether it is compound, code cuts
   * it, and each step gets its own decision on the page it finds. A step that
   * fails ends the chain: the steps after it were counting on it.
   *
   * `early` is the same road on a sentence still being said: only the
   * actions with an `earlyFingerprint` run, and the first step that is not
   * one (or is not sure yet) ends the pass; the sentence's end will run it.
   * `done` holds what an earlier pass of this sentence has already run, so
   * "open spot", "open spotify", "open spotify and play" open Spotify once.
   */
  const runCommand = useCallback(async (text: string, mine: number, typed = false, done = new Map<string, number>(), early = false) => {
    // One word is a verb with nothing to act on: "Open" alone launched an app
    // at 0.93 before "the browser" was out (22 Sep). The sentence's end runs it.
    if (early && text.trim().split(/\s+/).length < 2) return;
    let first: Awaited<ReturnType<typeof decide>>;
    try {
      // The end of a sentence is most often the text its last partial already
      // put to Jev; the same question again is ~450 ms for the same answer.
      first = !early && lastDecision.current?.text === text ? lastDecision.current.first : await decide(text, useBrowser.getState().url || null);
      if (early) lastDecision.current = { text, first };
    } catch (e) {
      // On the pill, and out loud: the overlay holding the notice is hidden
      // exactly when the call is parked, and every sentence failed in silence.
      log(`decide failed: ${String(e)}`);
      await speak(jevFault(e), 'fail');
      return;
    }
    if (!typed && !first.addressed) { log(`not addressed, ignored: ${text.length}ch in ${first.ms}ms`); return; }
    // Shown only now: what the transcriber invents over silence or hears
    // from a video ("don't forget to subscribe") was on the pill as if the
    // person had said it (21 Sep). The last result goes with it: `said` wins
    // on the pill, and the new sentence never showed after the first reply.
    setHeard(text);
    setSaid('');
    const steps = first.compound ? splitSteps(text) : [text];
    if (steps.length > 1 || first.compoundScore > 0.2) log(`compound=${first.compoundScore.toFixed(2)} steps=${steps.length}`);
    for (let i = 0; i < steps.length; i++) {
      if (generation.current !== mine) return;
      let r = first;
      if (!(i === 0 && steps.length === 1)) {
        try {
          r = await decide(steps[i], useBrowser.getState().url || null);
        } catch (e) {
          log(`decide failed: ${String(e)}`);
          await speak(jevFault(e), 'fail');
          return;
        }
      }
      const plan = r.plan;
      log(`${early ? 'early ' : ''}${steps.length > 1 ? `step ${i + 1}/${steps.length} ` : ''}${plan.action} conf=${plan.confidence.toFixed(2)} in ${r.ms}ms${r.desktop ? ' on the desktop' : ' in the app'}`);
      const fingerprint = earlyFingerprint(plan);
      // A partial runs a step at most once; the end of the sentence runs what
      // is left of its count ("close the last two tabs" = 2, minus any a
      // partial already closed). Counted per step: see `repeatCount`.
      const left = early ? (fingerprint && done.has(fingerprint) ? 0 : 1) : runsLeft(steps[i], fingerprint, done);
      if (left === 0) continue;
      if (early) {
        if (!fingerprint || plan.confidence < MIN_EARLY_CONFIDENCE) return;
        try {
          const line = await execute(plan, r.desktop);
          // A refusal is not said here: the sentence's end runs this step
          // again and reports it, once, with the whole sentence heard.
          if (toneFor(line) !== 'ok') return;
          show(line);
          done.set(fingerprint, (done.get(fingerprint) ?? 0) + 1);
        } catch (e) {
          log(`early ${plan.action} failed: ${String(e)}`);
          return;
        }
        continue;
      }
      // After the early run: a partial never hangs up (it has no fingerprint,
      // so it returned above); only the whole sentence does.
      if (plan.action === 'hang_up') {
        hangUpRef.current();
        return;
      }
      if (plan.action === 'stop') {
        // "Stop" is the brake on what Cinder was handed: it may be typing into
        // the wrong window, and the voice is the only brake the person has
        // with the app parked. It never ends the call; "hang up" does. With
        // Cinder idle, a second "stop" used to hang up, which the person using
        // it never knew and did not want (25 Sep).
        if (agentBusy.current) {
          agentStopped.current = true;
          await requestCinderpawStop(useChat.getState().sessionId).catch(() => {});
          await speak('Stopped Cinder.', 'ok');
        } else {
          await speak('Cinder is not working on anything.', 'ok');
        }
        return;
      }
      // One floor per action, checked once: with two gates in a row, a click
      // at 0.50 passed its own 0.35 and then fell through the general 0.6 to
      // Cinder, who spent two minutes on "click the first channel" (21 Sep).
      const floor = plan.action === 'click' ? MIN_CLICK_ACTION_CONFIDENCE : MIN_CONFIDENCE;
      if (plan.action === 'click' && plan.confidence < floor) {
        await speak('Not sure what to press; say it another way.', 'fail');
        return;
      }
      if (plan.action === 'none' || plan.confidence < floor) {
        // The rest of the chain goes with it: it may depend on this step.
        void handOff(steps.slice(i).join('; then '), mine);
        return;
      }
      try {
        // `left` times: once for most steps, N for "close the last two tabs",
        // minus what a partial already did. The pause lets a closed tab or a
        // scrolled page settle before the next key lands on it.
        for (let n = 0; n < left; n++) {
          if (n > 0) await new Promise((res) => setTimeout(res, 250));
          const line = await execute(plan, r.desktop);
          if (toneFor(line) !== 'ok') { await speak(line, 'fail'); return; }
          if (n === left - 1) show(line);
        }
        if (left > 1) log(`${plan.action} run ${left} times`);
      } catch (e) {
        // The notice lives in the overlay, which is hidden behind the pill
        // exactly when these happen; the console keeps the reason too.
        log(`${plan.action} failed: ${String(e)}`);
        await speak(spokenFailure(e), 'fail');
        return;
      }
    }
  }, [speak, show, handOff]);

  const transcribe = useCallback(async (blob: Blob, what: 'partial' | 'final', context?: string) => {
    const t0 = Date.now();
    // As WAV: the recording is cut while it runs, and a WebM cut that way has
    // no duration in it (see `wavBlob`).
    const wav = wavBlob(await decodeToPcm16k(blob));
    const lang = useUI.getState().callLanguage;
    const text = (await transcribeVoiceBlob(wav, await saveVoiceBlobToDisk(wav), context, lang && lang !== 'auto' ? lang : undefined)).trim();
    log(`${what} transcribed in ${Date.now() - t0}ms: ${JSON.stringify(text)}`);
    return text;
  }, []);

  const loop = useCallback(async (mine: number) => {
    while (generation.current === mine) {
      setPhase('listening');
      // What this sentence has already done, and the partial pass in flight.
      // Partials arrive faster than one is answered (every 400 ms of voice,
      // ~700 ms each): only the newest is kept, the ones behind it are
      // dropped, and the end of the sentence waits for the last one so it
      // never repeats an action a partial has just run.
      const done = new Map<string, number>();
      /** The last partial heard, kept for when the final transcript disagrees with it. */
      let lastPartial = '';
      let newest: Blob | null = null;
      let partials: Promise<void> | null = null;
      const drain = async () => {
        try {
          while (newest && generation.current === mine) {
            const sofar = newest;
            newest = null;
            const text = await transcribe(sofar, 'partial', lastPartial || undefined).catch(() => '');
            if (!text || isLikelyHallucination(text) || useAskUser.getState().pending) continue;
            lastPartial = text;
            await runCommand(text, mine, false, done, true);
          }
        } finally {
          partials = null;
        }
      };
      const heard = await listenOnce(mine, (sofar) => {
        newest = sofar;
        if (!partials) partials = drain();
      });
      if (generation.current !== mine) return;
      if (!heard) continue;
      setPhase('thinking');
      let text = '';
      try {
        // No voice since the last partial: that partial heard the whole
        // sentence, and transcribing the same audio again (a fourth time, with
        // the trailing silence) is where the final flipped language (22 Sep).
        const final = heard.sincePartial ? transcribe(heard.blob, 'final', lastPartial || undefined) : null;
        await partials;
        // `null` means no voice followed the last partial, so that partial IS
        // the whole sentence. A final that THREW is the opposite: the sentence
        // went on and we cannot read its end, and acting on the last partial
        // then ran "Okay, now click on the" as a click (22 Sep, after a rate
        // limit). One is the sentence; the other is half of one.
        text = final ? await final : lastPartial;
        if (!final) log(`final = last partial: ${JSON.stringify(text)}`);
      } catch (e) {
        // On the pill as well as the overlay: `said` is what the pill shows,
        // and the overlay is hidden exactly when the call is parked.
        log(`the end of the sentence did not transcribe, nothing run: ${e instanceof Error ? e.message : String(e)}`);
        setSaid(transcriptionFault(e));
        chime('fail');
        continue;
      }
      if (generation.current !== mine) return;
      // What the transcriber says over silence ("Thank you for watching", a
      // subtitle line in another script): never a command, never worth a request.
      // The final transcript of "Open Spotify and play something" came back as a
      // Romanian YouTube outro while its last partial had the sentence right (22
      // Sep). The partial is a prefix of what was said: a final that keeps
      // almost none of its words is the transcriber's invention, not the person's.
      if (lastPartial && !keepsWordsOf(lastPartial, text)) {
        log(`final disagrees with the last partial, using the partial: ${JSON.stringify(text)}`);
        text = lastPartial;
      }
      if (!text || isLikelyHallucination(text)) continue;
      if (await answerAsk(text)) continue;
      await runCommand(text, mine, false, done);
    }
  }, [listenOnce, transcribe, answerAsk, runCommand]);

  const open = useCallback(() => { setNotice(null); setPhase('ready'); }, []);

  const begin = useCallback(async () => {
    setNotice(null);
    setPhase('connecting');
    // A hang-up while the microphone is being asked for (a permission prompt
    // takes as long as the person does) bumps this; the call stays ended.
    // Without it the microphone arrived afterwards and the loop started: the
    // call came back on screen, listening, after the person had ended it.
    const asked = generation.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (generation.current !== asked) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      const c = new AudioContext();
      const a = c.createAnalyser();
      a.fftSize = 1024;
      c.createMediaStreamSource(s).connect(a);
      stream.current = s;
      ctx.current = c;
      analyser.current = a;
    } catch (e) {
      if (generation.current !== asked) return;
      const name = e instanceof DOMException ? e.name : '';
      setNotice(
        name === 'NotAllowedError' ? 'The microphone was refused. Allow it for Cinderpaw in your system settings.'
          : name === 'NotFoundError' ? 'No microphone was found. Plug one in and try again.'
            : `Microphone: ${String(e)}`,
      );
      setPhase('ready');
      return;
    }
    // The on-device model, fetched now rather than found missing after the
    // first sentence; a present one is a no-op (same as the pipeline call).
    const stt = useUI.getState().sttProvider;
    if (stt === null || stt === 'local') void ensureSttModel();
    // The installed apps, read now: the host completes the list in the
    // background, and "open Calculator" is often the first thing said.
    void installedApps();
    generation.current += 1;
    void loop(generation.current);
  }, [loop]);

  const hangUp = useCallback(() => {
    generation.current += 1;
    resetTarget();
    stopSpeech();
    releaseMic();
    setPhase('idle');
    setHeard('');
    setSaid('');
    setHandoffText('');
    setHandoffReply('');
    setLevel(0);
    setYouSpeaking(false);
    setMutedState(false);
    muteRef.current = false;
  }, [releaseMic, stopSpeech]);
  hangUpRef.current = hangUp;

  const interrupt = useCallback(() => { stopSpeech(); }, [stopSpeech]);
  const setMuted = useCallback((m: boolean) => {
    muteRef.current = m;
    setMutedState(m);
    stream.current?.getAudioTracks().forEach((t) => { t.enabled = !m; });
  }, []);
  /** A typed command takes the same road as a spoken one; typed, it is addressed by definition. */
  const say = useCallback((text: string) => {
    void runCommand(text, generation.current, true);
  }, [runCommand]);

  useEffect(() => () => { generation.current += 1; releaseMic(); }, [releaseMic]);

  // A question arriving mid-call is read out: the person is listening, not
  // watching, and the pill may be all they see.
  const pendingAsk = useAskUser((s) => s.pending);
  const spokenAsk = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingAsk || phase === 'idle' || phase === 'ready' || spokenAsk.current === pendingAsk.id) return;
    spokenAsk.current = pendingAsk.id;
    const q = pendingAsk.questions[0];
    const options = q.options.map((o) => o.label).filter(Boolean);
    void speak(`${q.question}${options.length ? ` Options: ${options.join(', ')}.` : ''}`);
  }, [pendingAsk, phase, speak]);

  // 'speaking' is what the pill says as "Cinder is speaking", and the loop
  // itself never speaks and listens at once: the phase is the loop's, except
  // while a line is actually being said.
  const shown: CallPhase = talking && phase !== 'idle' && phase !== 'ready' ? 'speaking' : phase;
  return { phase: shown, stage: null as CallStage, heard, said, handoffText, handoffReply, level, youSpeaking, notice, transcribing: false, open, begin, hangUp, interrupt, say, muted, setMuted };
}
