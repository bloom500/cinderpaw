import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useCallSession } from '@/hooks/useCallSession';
import { useJevCallSession } from '@/hooks/useJevCallSession';
import { useLiveCallSession } from '@/hooks/useLiveCallSession';
import { useLiveKitCallSession } from '@/hooks/useLiveKitCallSession';
import { useChatScope } from '@/stores/chatScope';
import { useUI } from '@/stores/ui';
import { chime } from '@/lib/audio';
import { hangUpLandsOn, useCallPill } from '@/lib/callPill';
import type { ChatInputProps } from './ChatInput';
import { CallOverlay } from './CallOverlay';
import { JEV_PROVIDER_ID } from './JevKeyRow';

// Recordings and calls share one physical microphone, even in a split view.
export const useVoiceCapture = create<{ owner: symbol | null }>(() => ({ owner: null }));

export function claimVoiceCapture(owner: symbol) {
  if (useVoiceCapture.getState().owner !== null) return false;
  useVoiceCapture.setState({ owner });
  return true;
}

export function releaseVoiceCapture(owner: symbol) {
  if (useVoiceCapture.getState().owner === owner) useVoiceCapture.setState({ owner: null });
}

type Props = {
  send: ChatInputProps['sendFn'];
  onClose: () => void;
  onChangeEngine: () => void;
  onChangeStt: () => void;
};
type Session = ReturnType<typeof useCallSession | typeof useLiveCallSession | typeof useLiveKitCallSession | typeof useJevCallSession>;

function CallScreen({ call, onClose, onChangeEngine, onChangeStt, jev = false }: Props & { call: Session; jev?: boolean }) {
  const previous = useRef(call.phase);
  const open = useRef(call.open);
  useEffect(() => { open.current(); }, []);
  useCallPill(call);
  useEffect(() => {
    const last = previous.current;
    previous.current = call.phase;
    const connected = (phase: Session['phase']) => !['idle', 'ready', 'connecting'].includes(phase);
    if (!jev && connected(last) !== connected(call.phase)) chime(connected(call.phase) ? 'connect' : 'end');
    if (last !== 'idle' && call.phase === 'idle') onClose();
  }, [call.phase, jev, onClose]);

  return <CallOverlay phase={call.phase} stage={call.stage} heard={call.heard}
    level={call.level} notice={call.notice} youSpeaking={'youSpeaking' in call && call.youSpeaking}
    said={'said' in call ? call.said : undefined}
    handoffText={'handoffText' in call ? call.handoffText : undefined}
    handoffReply={'handoffReply' in call ? call.handoffReply : undefined}
    onAnswer={() => void call.begin()} onInterrupt={call.interrupt}
    onHangUp={() => {
      const next = hangUpLandsOn(call.phase);
      call.hangUp();
      if (next === 'ready') call.open();
    }}
    muted={'muted' in call ? call.muted : undefined}
    onMute={'setMuted' in call ? call.setMuted : undefined}
    onAskAloud={'askAloud' in call ? call.askAloud : undefined}
    onSay={call.say} onChangeEngine={onChangeEngine} onChangeStt={onChangeStt} />;
}

function PipelineCall(props: Props) {
  const call = useCallSession((text) => props.send(text, undefined, { surface: 'voice' }));
  return <CallScreen {...props} call={call} />;
}
function JevCall(props: Props) {
  const call = useJevCallSession(async (text) => { await props.send(text, undefined, { surface: 'voice' }); });
  return <CallScreen {...props} call={call} jev />;
}
function LiveCall(props: Props) {
  return <CallScreen {...props} call={useLiveCallSession()} />;
}
function LiveKitCall(props: Props) {
  return <CallScreen {...props} call={useLiveKitCallSession()} />;
}

export function ComposerCall(props: Props) {
  const scope = useChatScope();
  const engine = useUI((s) => s.callEngine);
  const provider = useUI((s) => s.s2sProvider);
  // Vendor voice agents and Jev answer as themselves. The transcribe/chat/speak
  // engine sends every turn through the selected teammate's mailbox.
  if (scope) return <PipelineCall {...props} />;
  if (provider === JEV_PROVIDER_ID) return <JevCall {...props} />;
  if (engine === 'livekit') return <LiveKitCall {...props} />;
  if (engine === 'live') return <LiveCall {...props} />;
  return <PipelineCall {...props} />;
}
