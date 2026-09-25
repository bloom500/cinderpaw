import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useBrowser } from '@/stores/browser';
import { useSpeechPlayer } from './useSpeechPlayer';
import { saveVoiceBlobToDisk, transcribeVoiceBlob } from './useSendMessage';
import { rms, isVoiced, TRAIL_SILENCE_MS, MAX_UTTERANCE_MS, NO_SPEECH_TIMEOUT_MS } from '@/lib/vad';
import { decide, execute, installedApps, interpretReply, resetTarget, splitSteps, DESKTOP_CONTROL_OFF, MIN_CONFIDENCE, MIN_CLICK_ACTION_CONFIDENCE } from '@/lib/jev';
import { chime } from '@/lib/audio';
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
 * A command can be one word. The conversation VAD wants 250 ms of voice before
 * it sends anything, and a plain "stop" is under that, so it never reached the
 * transcriber (21 Sep). Same trailing silence, same caps; only the floor moves.
 */
const MIN_COMMAND_VOICED_MS = 120;

/**
 * What execute says back is either the action done ("Opening YouTube.", or
 * nothing at all) or why it was not ("I could not find...", "Desktop control
 * is off..."). The chime has to tell the two apart before any voice does.
 */
export function toneFor(line: string): 'ok' | 'fail' {
  // "3 matches for pricing." is `find` succeeding: it chimed as a failure,
  // was spoken as one, and ended the rest of a chain that was going fine.
  return !line || /^(Opening|Searching|Switching)\b|^\d+ match(es)? for /.test(line) ? 'ok' : 'fail';
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
  return msg === DESKTOP_CONTROL_OFF || / is in front, and I never control /.test(msg) ? msg : 'That did not work.';
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

  /** One utterance, or null when nothing worth sending was said. */
  const listenOnce = useCallback((mine: number) => new Promise<Blob | null>((resolve) => {
    const s = stream.current;
    const a = analyser.current;
    if (!s || !a) return resolve(null);
    const rec = new MediaRecorder(s);
    recorder.current = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const frame = new Float32Array(a.fftSize);
    const startedAt = Date.now();
    let spoke = false;
    let voiced = false;
    let voicedMs = 0;
    let quietSince = startedAt;
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
      if (voiced) { spoke = true; voicedMs += FRAME_MS; quietSince = Date.now(); }
      setYouSpeaking(voiced);
      verdict = commandEnded({ spoke, voicedMs, silenceMs: Date.now() - quietSince, elapsedMs: Date.now() - startedAt });
      if (verdict !== 'continue') rec.stop();
    }, FRAME_MS);
    rec.onstop = () => {
      window.clearInterval(timer);
      setYouSpeaking(false);
      // Every listen leaves a trace: "stop" said fifteen times and nothing
      // transcribed (21 Sep) is only diagnosable if the VAD says what it saw.
      if (verdict !== 'continue' || spoke) console.info(`[jev] listen ${verdict}: voiced ${voicedMs}ms over ${Date.now() - startedAt}ms`);
      resolve(verdict === 'end' ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
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
    show('Cinder is on it.');
    try {
      const sid = useChat.getState().sessionId;
      await fallbackRef.current(text);
      const reply = await agentReply(sid);
      if (generation.current === mine && !agentStopped.current && reply.trim()) await speak(spokenReply(reply));
    } catch (e) {
      console.warn('[jev] hand-off to Cinder failed:', e);
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
    if (read && !read.reply) { console.info(`[jev] ask ${ask.id}: not an answer, taken as a command`); return false; }
    // Answered on the pill while Jev was reading it: nothing left to answer.
    if (useAskUser.getState().pending?.id !== ask.id) return true;
    const answer = !read ? voiceAnswerFor(q, text)
      : read.selected.length ? { question: q.question, selected: read.selected }
        : { question: q.question, selected: [], customText: text };
    setHeard(text);
    setSaid('');
    console.info(`[jev] ask ${ask.id} answered by voice: ${answer.selected.length ? answer.selected.join(', ') : 'in their own words'}`);
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
   */
  const runCommand = useCallback(async (text: string, mine: number, typed = false) => {
    let first: Awaited<ReturnType<typeof decide>>;
    try {
      first = await decide(text, useBrowser.getState().url || null);
    } catch (e) {
      // On the pill, and out loud: the overlay holding the notice is hidden
      // exactly when the call is parked, and every sentence failed in silence.
      console.warn('[jev] decide failed:', e);
      await speak(jevFault(e), 'fail');
      return;
    }
    if (!typed && !first.addressed) { console.info(`[jev] not addressed, ignored: ${text.length}ch in ${first.ms}ms`); return; }
    // Shown only now: what the transcriber invents over silence or hears
    // from a video ("don't forget to subscribe") was on the pill as if the
    // person had said it (21 Sep). The last result goes with it: `said` wins
    // on the pill, and the new sentence never showed after the first reply.
    setHeard(text);
    setSaid('');
    const steps = first.compound ? splitSteps(text) : [text];
    if (steps.length > 1 || first.compoundScore > 0.2) console.info(`[jev] compound=${first.compoundScore.toFixed(2)} steps=${steps.length}`);
    for (let i = 0; i < steps.length; i++) {
      if (generation.current !== mine) return;
      let r = first;
      if (!(i === 0 && steps.length === 1)) {
        try {
          r = await decide(steps[i], useBrowser.getState().url || null);
        } catch (e) {
          console.warn('[jev] decide failed:', e);
          await speak(jevFault(e), 'fail');
          return;
        }
      }
      const plan = r.plan;
      console.info(`[jev] ${steps.length > 1 ? `step ${i + 1}/${steps.length} ` : ''}${plan.action} conf=${plan.confidence.toFixed(2)} in ${r.ms}ms${r.desktop ? ' on the desktop' : ' in the app'}`);
      if (plan.action === 'stop') {
        // "Stop" while Cinder is working means stop Cinder: it may be typing
        // into the wrong window, and the voice is the only brake the person
        // has with the app parked. Ending the call left it going. The call
        // stays; a second "stop" ends it.
        if (agentBusy.current) {
          agentStopped.current = true;
          await requestCinderpawStop(useChat.getState().sessionId).catch(() => {});
          await speak('Stopped Cinder.', 'ok');
          return;
        }
        hangUpRef.current();
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
        const line = await execute(plan, r.desktop);
        if (toneFor(line) === 'ok') show(line);
        else { await speak(line, 'fail'); return; }
      } catch (e) {
        // The notice lives in the overlay, which is hidden behind the pill
        // exactly when these happen; the console keeps the reason too.
        console.warn(`[jev] ${plan.action} failed:`, e);
        await speak(spokenFailure(e), 'fail');
        return;
      }
    }
  }, [speak, show, handOff]);

  const loop = useCallback(async (mine: number) => {
    while (generation.current === mine) {
      setPhase('listening');
      const blob = await listenOnce(mine);
      if (generation.current !== mine) return;
      if (!blob) continue;
      setPhase('thinking');
      let text = '';
      try {
        text = (await transcribeVoiceBlob(blob, await saveVoiceBlobToDisk(blob))).trim();
      } catch (e) {
        // On the pill as well as the overlay: `said` is what the pill shows,
        // and the overlay is hidden exactly when the call is parked.
        setSaid(transcriptionFault(e));
        chime('fail');
        continue;
      }
      if (generation.current !== mine) return;
      // What the transcriber says over silence ("Thank you for watching", a
      // subtitle line in another script): never a command, never worth a request.
      if (!text || isLikelyHallucination(text)) continue;
      if (await answerAsk(text)) continue;
      await runCommand(text, mine);
    }
  }, [listenOnce, answerAsk, runCommand]);

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
  return { phase: shown, stage: null as CallStage, heard, said, level, youSpeaking, notice, transcribing: false, open, begin, hangUp, interrupt, say, muted, setMuted };
}
