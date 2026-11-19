import { useEffect, useRef, useState, forwardRef, useImperativeHandle, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { tauri } from '@/lib/tauri';
import { Square, Phone, Clock, ChevronDown } from 'lucide-react';
import { SendIcon } from '@/components/ui/animated-icons/send';
import { AudioLinesIcon } from '@/components/ui/animated-icons/audio-lines';
import { useIconHover } from '@/components/ui/animated-icons/useIconHover';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AttachedFileChip, isLongPaste, pastedText, type AttachedFile } from './AttachedFileChip';
import { useAttachmentDraft } from './attachmentDrafts';
import { LinkChip } from './LinkChip';
import { VideoLinkCard } from './VideoLinkCard';
import { isVideoLink } from '@/lib/videoLinks';
import { splitLinks } from '@/lib/linkLabel';
import { FileAttachButton } from './FileAttachButton';
import { VoicePreview } from './VoicePreview';
import { VoiceProviderCard } from './VoiceProviderCard';
import { VoiceEngineCard } from './VoiceEngineCard';
import { ComposerPlaceholder } from './ComposerPlaceholder';
import { ModelPill } from './ModelPill';
import { ContextRing } from './ContextRing';
import { PermissionPill } from './PermissionPill';
import { MascotPerch } from './mascot/MascotPerch';
import { useMascotState } from './mascot/useMascotState';
import { useEmberRun } from './ember/useEmberRun';
import { EmberInvite } from './ember/EmberInvite';
import { EmberPanel } from './ember/EmberPanel';
import type { ChatMessage } from '@/stores/chat';
import { useChatApi, useChatScope, useChatView } from '@/stores/chatScope';
import { askUserFor } from '@/stores/askUser';
import { useUI } from '@/stores/ui';
import { useConversations } from '@/stores/conversations';
import { saveVoiceBlobToDisk, transcribeVoiceBlob, buildUserContent } from '@/hooks/useSendMessage';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import { ComposerCall, claimVoiceCapture, releaseVoiceCapture, useVoiceCapture } from './ComposerCall';
import { pendingFromClipboard, pendingFromPaths, type PendingAttachment } from '@/lib/attachments';
import { decodeToPcm16k, computePeaks } from '@/lib/audio';
import { ensureSttModel } from '@/lib/voiceModel';
import { stopActiveStream } from '@/lib/streamControl';
import { useNotifications } from '@/stores/notifications';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface ChatInputHandle {
  setText: (text: string) => void;
  focus: () => void;
  /** Attach files dropped anywhere on the chat page, not only on the composer. */
  attach: (dt: DataTransfer) => void;
  /** Attach files by path (Explorer's Send to > Cinderpaw). */
  attachPaths: (paths: string[]) => void;
}

export interface ChatInputProps {
  isEmpty?: boolean;
  /**
   * Sends a turn to the Cinderpaw Agent sidecar (`useCinderpawSendMessage`).
   * `images` carries attachment data URLs for vision-capable models.
   */
  sendFn: (
    text: string,
    images?: string[],
    opts?: {
      voice?: ChatMessage['voice'];
      existingUserId?: string;
      replaceFrom?: string;
      /** `'voice'` when the answer will be spoken aloud — see `cinderpaw_send_message`. */
      surface?: 'voice' | 'text';
    },
  ) => Promise<void | string>;
}

/**
 * The half-written message, kept where a reload cannot take it.
 *
 * The composer clears itself optimistically on send, and a failed send puts
 * the words back — so the only thing that ever lost a draft was leaving. Close
 * the app mid-sentence, reload the window, or click another chat, and what was
 * typed was gone with nothing to undo. Nobody types a long message twice; they
 * type a shorter, worse one.
 *
 * Per conversation, because a draft belongs to the thread it was aimed at.
 * Carrying one across a switch would put words in front of the wrong person.
 *
 * `localStorage` throws rather than returning null in a browser set to block
 * site data, so every call is wrapped: a composer that cannot remember a draft
 * still has to accept one.
 */
export const DRAFT_KEY = (id: string) => `cinderpaw.draft.${id}`;

export function readDraft(id: string): string {
  try {
    const key = DRAFT_KEY(id);
    const saved = window.localStorage.getItem(key);
    if (saved !== null || !id.startsWith('cowork:')) return saved ?? '';
    const legacy = window.sessionStorage.getItem(key);
    if (legacy !== null) {
      window.localStorage.setItem(key, legacy);
      window.sessionStorage.removeItem(key);
    }
    return legacy ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(id: string, text: string): void {
  try {
    // An empty draft is removed rather than stored. A sent message would
    // otherwise leave an empty string behind for every conversation ever
    // opened, which is a slow leak of keys nobody reads.
    if (text.trim()) window.localStorage.setItem(DRAFT_KEY(id), text);
    else window.localStorage.removeItem(DRAFT_KEY(id));
    if (id.startsWith('cowork:')) window.sessionStorage.removeItem(DRAFT_KEY(id));
  } catch {
    /* the draft is lost on reload, exactly as it always was */
  }
}

// Mobile UX (deferred): swap to Enter=newline + explicit send button.
export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
function ChatInput({ isEmpty, sendFn }, ref) {
  const chat = useChatApi();
  const scope = useChatScope();
  const sendIcon = useIconHover();
  const voiceIcon = useIconHover();
  const [text, setText] = useState('');

  // `'new'` for a conversation that has not been saved yet — it still has a
  // draft, and it is the single most likely one to be interrupted.
  const currentConversation = useConversations((s) => s.currentId);
  const sessionId = useChatView((s) => s.sessionId);
  const convId = scope ? sessionId : currentConversation ?? 'new';
  const { files: attachedFiles, links, setFiles: setAttachedFiles, setLinks, ready: attachmentsReady } = useAttachmentDraft(convId);
  // A question card above is waiting for THIS chat's answer. The reply cannot
  // finish until it is answered, so "it sends when this reply is done" was a
  // promise the field could not keep (seen 28 Oct with a red Stop beside it).
  const askingHere = askUserFor(sessionId)((s) => s.pending?.sessionId === sessionId);
  const [queued, setQueued] = useState<string | null>(null);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  const liveDraft = useRef<{ id: string; sessionId: string } | null>(null);
  // The live text, readable from a cleanup that must not re-run on every
  // keystroke. Assigned during render on purpose: a ref is not state, and this
  // one only ever mirrors what was just rendered.
  const textRef = useRef(text);
  textRef.current = text;
  // Text a caller typed in for the person (Teach, an artifact question). Those
  // start a new chat and fill the box in one go, and the draft restore below
  // would otherwise wipe it the moment the switch lands.
  const prefill = useRef<string | null>(null);

  /**
   * Restore this conversation's draft, and save the one being left behind.
   *
   * The save lives in the CLEANUP rather than in a second effect watching
   * `text`. React runs a cleanup before the next effect, and the closure still
   * holds the id the outgoing text belonged to — so switching chats writes the
   * old draft under the old id, instead of writing it under the new one a
   * moment before the restore overwrites the box.
   */
  useEffect(() => {
    const id = convId;
    liveDraft.current = { id, sessionId };
    const typed = prefill.current;
    prefill.current = null;
    setQueued(null);
    setText(typed ?? readDraft(id));
    return () => {
      writeDraft(id, [queuedRef.current, textRef.current].filter(Boolean).join('\n'));
      queuedRef.current = null;
      liveDraft.current = null;
    };
  }, [convId, sessionId]);
  // Declared after the restore on purpose: effects run in order, so a prefill
  // made together with a chat switch reaches the restore above first, and one
  // made without a switch is forgotten here before the next switch sees it.
  useEffect(() => { prefill.current = null; });

  /**
   * Closing the window is the case the cleanup above cannot cover.
   *
   * React unmounts nothing when a tab is closed or reloaded, so the effect
   * cleanup never runs and the draft dies exactly where it matters most.
   * `pagehide` fires for all of it — close, reload, and quitting the desktop
   * app — where `beforeunload` is unreliable and can prompt.
   */
  useEffect(() => {
    const save = () => writeDraft(convId, [queuedRef.current, textRef.current].filter(Boolean).join('\n'));
    window.addEventListener('pagehide', save);
    // A message typed mid-turn that arrived after the turn ended: it waits and
    // sends when the reply is done, like before steering existed. Kept in this
    // effect so the composer gains no hook (a live app hot-reloads it).
    const refused = (e: Event) => {
      const { text: back, sessionId: target } = (e as CustomEvent<{ sessionId: string; text: string }>).detail;
      if (target !== sessionId) return;
      setQueued((q) => (q ? `${q}\n${back}` : back));
    };
    window.addEventListener('cinderpaw:steer-refused', refused);
    return () => {
      window.removeEventListener('pagehide', save);
      window.removeEventListener('cinderpaw:steer-refused', refused);
    };
  }, [convId, sessionId]);
  const [dragOver, setDragOver] = useState(false);
  const status = useChatView((s) => s.streamStatus);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // In use until a press lands outside it. Not blur: the model menu and the
  // voice cards open in portals, and treating that focus move as "left" would
  // fold the row away under the menu the person just opened.
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    if (!engaged) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || composerRef.current?.contains(target)) return;
      if (target.closest('[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"]')) return;
      setEngaged(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [engaged]);
  const t = useT();
  const rec = useVoiceRecorder(sessionId);
  const voiceSendInFlight = useRef(false);
  const [sendingVoice, setSendingVoice] = useState(false);
  const [voicePeaks, setVoicePeaks] = useState<number[]>([]);
  const sttProvider = useUI((s) => s.sttProvider);
  const [providerCardOpen, setProviderCardOpen] = useState(false);
  // Long-press detection on the mic: a held press opens the provider card; a
  // normal tap records. `heldRef` suppresses the click that follows a long press.
  const micHoldTimer = useRef<number | null>(null);
  const micHeldRef = useRef(false);

  const [engineCardOpen, setEngineCardOpen] = useState(false);
  const [inCall, setInCall] = useState(false);
  const lease = useRef(Symbol('composer voice')).current;
  const owner = useVoiceCapture((s) => s.owner);
  const voiceBusy = owner !== null && owner !== lease;
  const recordingLease = useRef(false);
  const release = () => releaseVoiceCapture(lease);
  useEffect(() => {
    setInCall(false);
    recordingLease.current = false;
    return () => releaseVoiceCapture(lease);
  }, [lease, sessionId]);

  const openCall = () => {
    if (rec.state === 'recording' || recordingLease.current || !claimVoiceCapture(lease)) return;
    setInCall(true);
  };
  const closeCall = () => { setInCall(false); release(); };

  // When a recording finishes, compute peaks for the preview and warm the model.
  useEffect(() => {
    if (rec.state === 'preview' && rec.blob) {
      void decodeToPcm16k(rec.blob)
        .then((pcm) => {
          console.log('[voice] decoded for preview', { pcmLength: pcm.length });
          setVoicePeaks(computePeaks(pcm));
        })
        .catch((err) => console.error('[voice] decodeToPcm16k FAILED (preview)', err));
      // Only the local backend needs the 466 MB whisper model on disk; a cloud
      // user should never trigger that download.
      if (sttProvider === 'local') void ensureSttModel();
    }
  }, [rec.state, rec.blob, sttProvider]);

  const onMic = async () => {
    if (rec.state === 'recording') { rec.stop(); return; }
    // The RETURNED failure, not `rec.error`. Reading the state here read this
    // render's closure, which `start()` has not updated yet — so a first
    // refusal said nothing at all and the microphone button just went back to
    // idle. Being told nothing is the worst possible answer to "I pressed the
    // microphone and pressed Deny by accident".
    if (recordingLease.current || inCall || !claimVoiceCapture(lease)) return;
    recordingLease.current = true;
    const failure = await rec.start();
    if (failure) { recordingLease.current = false; release(); }
    if (failure === 'denied') useNotifications.getState().push('error', t('voice.permissionDenied'));
    if (failure === 'unsupported') useNotifications.getState().push('error', t('voice.unsupported'));
  };

  useEffect(() => {
    if (rec.state === 'preview' && recordingLease.current) {
      recordingLease.current = false;
      releaseVoiceCapture(lease);
    }
  }, [rec.state, lease]);

  // Press-and-hold the mic to (re)open the provider chooser; a normal tap
  // records. Holding is disabled while recording so "tap to stop" still works.
  const onMicPointerDown = () => {
    if (rec.state === 'recording') return;
    micHeldRef.current = false;
    micHoldTimer.current = window.setTimeout(() => {
      micHeldRef.current = true;
      setProviderCardOpen(true);
    }, 500);
  };
  const clearMicHold = () => {
    if (micHoldTimer.current !== null) {
      clearTimeout(micHoldTimer.current);
      micHoldTimer.current = null;
    }
  };
  // Also on unmount. Holding the mic button and then navigating away left the
  // 500 ms timer armed against a component that no longer exists, which React
  // reports as a state update on an unmounted component — and the provider card
  // it opens would have appeared over whatever the user moved on to.
  useEffect(() => clearMicHold, []);
  const onMicClick = () => {
    if (micHeldRef.current) { micHeldRef.current = false; return; } // long-press handled it
    if (sttProvider === null) { setProviderCardOpen(true); return; } // force first-use choice
    void onMic();
  };

  useImperativeHandle(ref, () => ({
    setText: (t: string) => {
      prefill.current = t;
      setText(t);
      setTimeout(() => taRef.current?.focus(), 0);
    },
    focus: () => taRef.current?.focus(),
    attach: (dt: DataTransfer) => attachLater(pendingFromClipboard(dt)),
    attachPaths: (paths: string[]) => attachLater(pendingFromPaths(paths)),
  }));

  // Auto-resize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const addFiles = (files: AttachedFile[]) =>
    setAttachedFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      return [...prev, ...files.filter((f) => !existing.has(f.path))];
    });

  // Each file shows at once with its name and a spinner, and fills in when it
  // has been read. Before, nothing appeared until every file was read, so a big
  // video looked like a frozen app (29 Oct 2026).
  const attachLater = (jobs: PendingAttachment[]) => {
    const ids = jobs.map(() => `pending://${crypto.randomUUID()}`);
    addFiles(jobs.map((j, i) => ({ name: j.name, path: ids[i], content: null, kind: 'binary', loading: true })));
    jobs.forEach((j, i) => {
      void j.ready.then((f) => setAttachedFiles((prev) => {
        if (!prev.some((p) => p.path === ids[i])) return prev;                         // removed while it was read
        if (prev.some((p) => p.path === f.path)) return prev.filter((p) => p.path !== ids[i]);  // already attached
        return prev.map((p) => (p.path === ids[i] ? f : p));
      }));
    });
  };
  const attachLaterRef = useRef(attachLater);
  attachLaterRef.current = attachLater;

  // Drag & drop: Tauri intercepts native file drops (the webview never sees
  // HTML5 drop events for OS files) and emits drag-drop events with paths.
  useEffect(() => {
    const webview = getCurrentWebview();
    const unlistenPromise = webview.onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'over' || payload.type === 'drop') {
        const scale = window.devicePixelRatio || 1;
        const target = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale);
        const panel = composerRef.current?.closest('[data-chat-drop-target]') ?? composerRef.current;
        const inside = !!target && !!panel?.contains(target);
        setDragOver(payload.type === 'over' && inside);
        if (payload.type === 'drop' && inside) attachLaterRef.current(pendingFromPaths(payload.paths));
      } else {
        setDragOver(false);
      }
    });
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  // HTML5 drop, the path that actually fires: `dragDropEnabled` is off in
  // tauri.conf.json (25 Aug, so chats can be dragged in the rail), and with it
  // off Tauri never emits the drag-drop events above, so a file dropped from
  // the OS did nothing (20 Sep). The browser app has no Tauri events at all,
  // so this is the one handler that works on every surface. A DataTransfer
  // is what the paste helper already takes.
  const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    // Leaving a child fires too; only a real exit of the composer clears it.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragOver(false);
    attachLater(pendingFromClipboard(e.dataTransfer));
  };

  // Ctrl+V / ⌘V: attach pasted screenshots and copied files. Keep text.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    const hasFile = !!items && Array.from(items).some((i) => i.kind === 'file');
    // A paste that is nothing but links becomes chips. A sentence with a link
    // in it stays text: the person is writing, not handing over an address.
    const pasted = e.clipboardData?.getData('text/plain').trim() ?? '';
    const parts = pasted ? splitLinks(pasted) : [];
    if (!hasFile && parts.length > 0 && parts.every((x) => x.kind === 'link' || !x.text.trim())) {
      e.preventDefault();
      const found = parts.flatMap((x) => (x.kind === 'link' ? [x.href] : []));
      setLinks((prev) => [...prev, ...found.filter((h) => !prev.includes(h))]);
      return;
    }
    // A long paste (a log, an article, a whole file) becomes one card instead
    // of filling the box: the text still goes with the message, in full.
    const raw = e.clipboardData?.getData('text/plain') ?? '';
    if (!hasFile && isLongPaste(raw)) {
      e.preventDefault();
      addFiles([pastedText(raw)]);
      return;
    }
    if (!hasFile) return;
    // Don't preventDefault — text+image paste should keep the text in the textarea
    // while also attaching the image. Preventing drops the text.
    attachLater(pendingFromClipboard(e.clipboardData));
  };

  const isStreaming = status === 'streaming';
  // A message written while a reply is still arriving. It waits here and goes
  // out when the reply is done, like Claude's "type to queue for later"; before,
  // Enter did nothing at all during a reply and nothing said why.
  const lastStatus = useRef(status);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = status;
    if (was !== 'streaming' || status === 'streaming' || queued === null || queuedRef.current === null) return;
    queuedRef.current = null;
    setQueued(null);
    // Done: it goes. Stopped or failed: it comes back to the box, so the person
    // decides, instead of a new turn starting on top of a problem.
    if (status === 'done') {
      const owner = liveDraft.current;
      void sendFn(queued).catch(() => {
        if (owner && liveDraft.current === owner) {
          setText((cur) => cur ? `${queued}\n${cur}` : queued);
        } else if (owner) {
          writeDraft(owner.id, [queued, readDraft(owner.id)].filter(Boolean).join('\n'));
        }
      });
    }
    else setText((cur) => (cur ? `${queued}\n${cur}` : queued));
  }, [status, queued, sendFn]);
  const agentPhase = useChatView((s) => s.agentPhase);
  const mascotState = useMascotState({
    streamStatus: status,
    agentPhase,
    isUserTyping: text.trim().length > 0,
    isUserRecording: rec.state === 'recording',
  });
  const ember = useEmberRun();
  // Kept as a name because several controls read it; nothing sets it from
  // model state any more. With no model, the agent's own error says so
  // (humanizeError: "No model is chosen yet", with a button to Models).
  const disabled = false;

  const trySend = async () => {
    if (voiceSendInFlight.current || !attachmentsReady) return;
    // Voice path: a recorded preview is pending — transcribe + send it instead
    // of the (empty) textarea content.
    if (rec.state === 'preview' && rec.blob) {
      if (isStreaming || disabled) return;
      const { blob, durationMs } = rec;
      const peaks = voicePeaks;
      const owner = liveDraft.current;
      voiceSendInFlight.current = true;
      setSendingVoice(true);
      const userId = crypto.randomUUID();
      try {
        const audioPath = await saveVoiceBlobToDisk(blob);
        if (liveDraft.current !== owner) return;
        const transcript = await transcribeVoiceBlob(blob, audioPath);
        if (liveDraft.current !== owner) return;
        const body = transcript || '(unintelligible)';
        const voice = { audioPath, durationMs, transcript, peaks };
        chat.getState().addMessage({
          id: userId,
          role: 'user',
          content: '',
          voice,
          voicePending: true,
          createdAt: Date.now(),
        });
        // Route the transcript exactly like a typed message, to the agent.
        // `existingUserId` fills in the optimistic bubble instead of adding a
        // duplicate.
        const turn = sendFn(body, undefined, { voice, existingUserId: userId });
        const started = chat.getState().messages.some((message) => message.id === userId && !message.voicePending);
        if (started) {
          void turn.catch((err) => console.error('[voice] turn FAILED', err));
        } else {
          await turn;
        }
        rec.reset();
        setVoicePeaks([]);
      } catch (err) {
        console.error('[voice] sendVoice FAILED', err);
        const bubble = chat.getState().messages.find((message) => message.id === userId);
        if (bubble && !bubble.voicePending) {
          rec.reset();
          setVoicePeaks([]);
          return;
        }
        if (bubble) chat.getState().removeMessage(userId);
        if (liveDraft.current !== owner) return;
        // Tauri's invoke rejects with the raw error *string*, not an Error
        // object, so read both shapes before matching the sentinels.
        const code = err instanceof Error ? err.message : String(err);
        if (code === 'model-missing') useNotifications.getState().push('info', t('voice.modelDownloading'));
        else if (code === 'voice-unavailable') useNotifications.getState().push('error', t('voice.unsupported'));
        else if (code === 'stt-no-key') setProviderCardOpen(true); // cloud chosen but key missing
        else if (code === 'stt-cloud-failed') useNotifications.getState().push('error', t('voice.cloudFailed'));
        else useNotifications.getState().push('error', 'Voice message not sent', 'Your recording is still here. Try sending it again.');
      } finally {
        voiceSendInFlight.current = false;
        setSendingVoice(false);
      }
      return;
    }
    if (isStreaming && text.trim() && attachedFiles.length === 0 && links.length === 0) {
      const next = text;
      setText('');
      // It joins the turn that is running (steering, 4 Nov). If the engine
      // cannot take it, it waits and sends when this reply is done, as before.
      if (askingHere) { setQueued((q) => (q ? `${q}\n${next}` : next)); return; }
      void tauri.raw.cinderpawSteer(sessionId, next).catch(() => setQueued((q) => (q ? `${q}\n${next}` : next)));
      return;
    }
    if ((!text.trim() && attachedFiles.length === 0 && links.length === 0) || isStreaming || disabled) return;
    if (attachedFiles.some((f) => f.loading)) return; // the button says so: it waits for the files
    const draftText = text;
    const draftLinks = links;
    // Links first, the way they sat in the composer; the words on the next line.
    const composed = links.length > 0
      ? `${links.join(' ')}${text.trim() ? `\n${text}` : ''}`
      : text;
    const content = composed;
    const files = attachedFiles;
    // Cleared optimistically, because waiting for the whole turn before the
    // box empties feels broken. That makes what someone typed live nowhere but
    // in these two consts until a bubble carries it — so if the send throws
    // before that bubble exists, the message is simply gone, and until now the
    // rejection was unhandled on top of it: an empty composer and silence.
    const before = chat.getState().messages.length;
    const owner = liveDraft.current;
    let posted = false;
    setText('');
    setAttachedFiles([]);
    setLinks([]);
    try {
      // Text attachments go inline in the content; image data URLs go
      // separately so the sidecar can pass real pixels to vision models.
      const images = files
        .filter((f) => f.kind === 'image' && f.dataUrl)
        .map((f) => f.dataUrl!);
      const turn = sendFn(buildUserContent(content, files), images.length > 0 ? images : undefined);
      posted = chat.getState().messages.length !== before;
      await turn;
    } catch (err) {
      // Put it back only if nothing made it onto the transcript. Once a user
      // bubble exists the words are safe there, and restoring the draft as
      // well would show them twice.
      const stillHere = liveDraft.current === owner;
      if (!posted && (!stillHere || chat.getState().messages.length === before)) {
        const restore = (current: string) => [draftText, current].filter(Boolean).join('\n');
        if (stillHere) setText(restore);
        else if (owner) writeDraft(owner.id, restore(readDraft(owner.id)));
        setLinks((current) => [...new Set([...draftLinks, ...current])]);
        setAttachedFiles((current) => [
          ...files.filter((file) => !current.some((next) => next.path === file.path)),
          ...current,
        ]);
      }
      useNotifications.getState().push(
        'error',
        'Message not sent',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as any).isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void trySend();
    }
    // Backspace in an empty box takes the last link chip back, like deleting
    // the character before the caret would have.
    if (e.key === 'Backspace' && text === '' && links.length > 0) {
      e.preventDefault();
      setLinks((prev) => prev.slice(0, -1));
    }
  };

  const removeFile = (path: string) =>
    setAttachedFiles((prev) => prev.filter((f) => f.path !== path));


  return (
    <TooltipProvider delayDuration={300}>
      {/* data-composer: ChatPage measures it to glide the dock with a side panel. */}
      {/* @container: the button row reads its own width (a side panel narrows
          it), not the window's, to decide which names fit. */}
      <div data-composer="" className={cn(
        '@container px-4 py-3 mx-auto w-full',
        // In a conversation the composer lines up with the transcript's
        // 700px column (MessageList, max-w-[748px] minus px-6), 16px wider
        // on each side as the canvas draws it, instead of spanning the pane.
        isEmpty ? 'max-w-2xl' : 'max-w-[764px]',
      )}>
        <EmberPanel run={ember} onClosed={() => taRef.current?.focus()} />
        <div
          ref={composerRef}
          onFocusCapture={() => setEngaged(true)}
          onPointerDownCapture={() => setEngaged(true)}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            // A pill, from the HextaUI AI chat input: 28px is half the collapsed
            // height, so the ends are round, and the corners stay soft once it
            // grows to two rows.
            'relative rounded-[28px] border bg-(--surface-typing) focus-within:border-brand transition-colors',
            // Same material as the rail and the popovers. Without these two it
            // was the only piece of chrome in the app that was merely tinted:
            // a flat rectangle sitting beside a sidebar made of glass.
            'liquid-glass liquid-glass-rim',
            dragOver ? 'border-brand border-dashed' : 'border-border-default',
          )}
        >
          {/* No overlay of its own: ChatPage draws the one "Drop to add to this
              chat" over the whole chat, the composer included. */}
          {/* Always. The perch is not decoration: it walks the composer's edge
              and carries the tool-call stack, so it is how a person sees WHAT
              is running. Hiding it on Home removed a working feature to fix a
              spacing complaint — the fix was room above the composer, which the
              greeting now leaves. */}
          {/* Except while the campfire game is open: the game has its own
              Cinderpaw, and the perch walked right under it, in the way of play. */}
          <div hidden={ember.open}>
            <MascotPerch baseState={mascotState} />
          </div>
          <EmberInvite run={ember} />
          {(attachedFiles.length > 0 || links.length > 0) && (
            <div className="flex flex-wrap gap-1 px-3 pt-2">
              {links.map((href) => {
                const remove = () => setLinks((prev) => prev.filter((h) => h !== href));
                return isVideoLink(href)
                  ? <VideoLinkCard key={href} href={href} onRemove={remove} />
                  : <LinkChip key={href} href={href} onRemove={remove} />;
              })}
              {attachedFiles.map((f) => (
                <AttachedFileChip
                  key={f.path}
                  file={f}
                  onRemove={() => removeFile(f.path)}
                />
              ))}
            </div>
          )}
          {rec.state === 'preview' && rec.blob && (
            <VoicePreview
              blob={rec.blob}
              durationMs={rec.durationMs}
              peaks={voicePeaks}
              busy={sendingVoice}
              onDelete={() => { rec.reset(); setVoicePeaks([]); }}
              onReRecord={() => {
                rec.reset();
                setVoicePeaks([]);
                // Same reason as the microphone button: a refusal here was
                // silent too, and this one happens after the person has already
                // recorded something once.
                void onMic();
              }}
            />
          )}
          {sendingVoice && <p role="status" className="px-4 pt-2 text-xs text-text-muted">Preparing your voice message…</p>}
          {queued !== null && (
            <div className="flex items-center gap-2 px-4 pt-2.5 text-xs text-text-muted" role="status">
              <Clock size={12} className="shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate">
                Sends when this reply is done: <span className="text-text-secondary">{queued}</span>
              </span>
              <button
                type="button"
                onClick={() => { setText((cur) => (cur ? `${queued}\n${cur}` : queued)); setQueued(null); }}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              >
                Edit
              </button>
            </div>
          )}
          {/* Two rows, after the 21st.dev prompt composer (MIT) Darius picked on
              1 Nov: the words get the whole width, and every button lives on
              one row under them. */}
          <div className="px-3 pt-2">
            <div className="relative min-w-0">
              <Textarea
                ref={taRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                // The visible placeholder is drawn below, animated; the box keeps
                // an accessible name so a screen reader still hears what it is for.
                aria-label={scope ? `Message ${scope.name}` : t('chat.placeholder.agent')}
                disabled={disabled}
                rows={1}
                className={cn(
                  // shadow-none and md:text-base undo the base Textarea's own
                  // box and its smaller desktop size: the field is the pill, and
                  // what is typed is the size of the placeholder it replaces.
                  'resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 max-h-[200px] px-2 pt-3 text-base md:text-base min-h-11 thin-scrollbar',
                )}
              />
              {text.length === 0 && rec.state !== 'preview' && (
                <div aria-hidden className="pointer-events-none absolute inset-x-2 top-3 overflow-hidden text-base leading-6">
                  <ComposerPlaceholder
                    // Cycling examples are onboarding: on Home and a new chat.
                    // In a conversation they ran for as long as it was open,
                    // forty blurred letters every 3.2 s behind the transcript
                    // and every streamed reply; there the field says what it is.
                    active={!!isEmpty && !engaged && !disabled}
                    fallback={askingHere
                      ? 'Answer the questions above to go on.'
                      : isStreaming ? 'Add something while it works…' : scope ? `Message ${scope.name}…` : t('chat.placeholder.agent')}
                  />
                </div>
              )}
            </div>
          </div>
          {/* Stable controls: focusing, sending and finishing a reply must not
              move the composer, mascot or transcript. The left group gives way
              (the model name truncates); the right group never does. */}
          <div className="flex items-center justify-between gap-2 px-2.5 pt-1 pb-2.5">
            <div className="flex min-w-0 items-center gap-1">
              <FileAttachButton onPathsSelected={(paths) => attachLater(pendingFromPaths(paths))} />
              <ModelPill />
              {/* ponytail: the "Shift+Enter for newline" hint is gone from this
                  row. Invisible until typing, it still took ~140px, and with every
                  button on one row it cut the model's name to "Claude S…". */}
              <PermissionPill />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <ContextRing />
              {!isStreaming && (
                // A split button (14 Nov, Darius): nobody guesses that holding
                // the mic opens the transcription choice, so a small arrow beside
                // it opens the same card in one visible click. Holding still works.
                <div className="flex h-8 items-center rounded-full border border-border-default bg-bg-hover">
                  <button
                    type="button"
                    disabled={sendingVoice || voiceBusy || inCall}
                    onClick={onMicClick}
                    onPointerDown={onMicPointerDown}
                    onPointerUp={clearMicHold}
                    onPointerEnter={voiceIcon.hover.onPointerEnter}
                    onPointerLeave={() => { clearMicHold(); voiceIcon.hover.onPointerLeave(); }}
                    onFocus={voiceIcon.hover.onFocus}
                    onBlur={voiceIcon.hover.onBlur}
                    aria-label={rec.state === 'recording' ? 'Stop recording' : 'Record voice message'}
                    className={cn(
                      'group flex h-full items-center px-2 transition-colors hover:bg-bg-active',
                      rec.state === 'recording' ? 'rounded-full text-error animate-pulse' : 'rounded-l-full text-text-secondary hover:text-text-primary',
                    )}
                  >
                    {rec.state === 'recording' ? <Square size={16} className="shrink-0" /> : <AudioLinesIcon ref={voiceIcon.ref} size={16} className="flex shrink-0" />}
                    <span className="composer-slide-label text-sm">{rec.state === 'recording' ? 'Stop' : 'Record'}</span>
                  </button>
                  {rec.state !== 'recording' && (
                    <button
                      type="button"
                      onClick={() => setProviderCardOpen(true)}
                      aria-label={t('voice.provider.title')}
                      title={t('voice.provider.title')}
                      aria-haspopup="dialog"
                      className="flex h-full items-center rounded-r-full border-l border-border-default pl-1 pr-1.5 text-text-muted transition-colors hover:bg-bg-active hover:text-text-primary"
                    >
                      <ChevronDown size={12} />
                    </button>
                  )}
                </div>
              )}
              {!isStreaming && (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={openCall}
                  disabled={disabled || voiceBusy || rec.state === 'recording'}
                  aria-label={scope ? `Call ${scope.name}` : t('call.aria')}
                  title={t('call.title')}
                  className="h-8 w-8 rounded-full border border-border-default bg-bg-hover text-text-secondary hover:bg-bg-active hover:text-brand"
                >
                  <Phone size={16} />
                </Button>
              )}
              {isStreaming ? (
                <Button
                  size="icon"
                  variant="destructive"
                  onClick={() => void stopActiveStream(sessionId)}
                  aria-label="Stop"
                  className="h-8 w-8 rounded-full"
                >
                  <Square size={12} />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => void trySend()}
                  disabled={sendingVoice || !attachmentsReady || (!text.trim() && attachedFiles.length === 0 && links.length === 0 && rec.state !== 'preview') || attachedFiles.some((f) => f.loading) || disabled}
                  aria-label="Send"
                  className="h-8 w-8 rounded-full"
                  {...sendIcon.hover}
                >
                  <SendIcon ref={sendIcon.ref} size={16} className="flex" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      <VoiceProviderCard open={providerCardOpen} onOpenChange={setProviderCardOpen} />
      <VoiceEngineCard open={engineCardOpen} onOpenChange={setEngineCardOpen} />
      {inCall && (
        <ComposerCall key={sessionId} send={sendFn} onClose={closeCall}
          onChangeEngine={() => setEngineCardOpen(true)} onChangeStt={() => setProviderCardOpen(true)} />
      )}
    </TooltipProvider>
  );
});
