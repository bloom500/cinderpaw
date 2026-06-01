import { useCallback, useEffect, useState } from 'react';
import { tauri, type AgentConfig } from '@/lib/tauri';
import { ONBOARDING_KEY, DEFAULT_SCRATCH_PROMPT } from '../agentUtils';
import { OnboardingShell } from './OnboardingShell';
import { WelcomeStep }    from './steps/WelcomeStep';
import { PickPresetStep } from './steps/PickPresetStep';
import { NameAgentStep }  from './steps/NameAgentStep';
import { ReviewStep }     from './steps/ReviewStep';
import { DoneStep }       from './steps/DoneStep';

type Step = 'welcome' | 'pick_preset' | 'name_agent' | 'review' | 'done';

const STEP_INDEX: Record<Step, number> = {
  welcome:     1,
  pick_preset: 2,
  name_agent:  3,
  review:      4,
  done:        5,
};

interface Props {
  onDone: () => void;
  onSkip: () => void;
}

export function AgentsOnboarding({ onDone, onSkip }: Props) {
  const [step, setStep]       = useState<Step>('welcome');
  const [history, setHistory] = useState<Step[]>([]);

  // Draft choices
  const [selectedPreset, setSelectedPreset] = useState<AgentConfig | 'scratch' | null>(null);
  const [agentName, setAgentName]           = useState('');

  // Preset fetch state
  const [presets, setPresets]             = useState<AgentConfig[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetsError, setPresetsError]   = useState<string | null>(null);

  // Save state
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState('');

  // ── Navigation helpers ──────────────────────────────────────────────────────

  const advance = (to: Step) => {
    setHistory((h) => [...h, step]);
    setStep(to);
  };

  const back = () => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (prev) setStep(prev);
      return h.slice(0, -1);
    });
  };

  const skip = () => {
    localStorage.setItem(ONBOARDING_KEY, 'dismissed');
    onSkip();
  };

  // ── Preset loading ──────────────────────────────────────────────────────────

  const loadPresets = useCallback(async () => {
    setPresetsLoading(true);
    setPresetsError(null);
    try {
      const list = await tauri.agents.getPresets();
      setPresets(list);
    } catch (e) {
      setPresetsError(String(e));
    } finally {
      setPresetsLoading(false);
    }
  }, []);

  useEffect(() => { void loadPresets(); }, [loadPresets]);

  // ── When user picks a preset, prefill the name ──────────────────────────────

  const handleSelectPreset = (v: AgentConfig | 'scratch') => {
    setSelectedPreset(v);
    if (v === 'scratch') {
      setAgentName((prev) => prev || '');
    } else {
      setAgentName((prev) => prev || v.name);
    }
  };

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const preset = selectedPreset && selectedPreset !== 'scratch' ? selectedPreset : null;
      const cfg: AgentConfig = {
        // No id — backend generates a stable UUID via serde(default)
        name:          agentName.trim(),
        system_prompt: preset?.system_prompt ?? DEFAULT_SCRATCH_PROMPT,
        model_id:      '',
        tools:         preset?.tools ?? [],
      };
      await tauri.agents.save(cfg);
      setSavedName(cfg.name);
      localStorage.setItem(ONBOARDING_KEY, 'completed');
      advance('done');
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Step-specific continue guards ───────────────────────────────────────────

  const canContinuePickPreset = selectedPreset !== null;
  const canContinueName       = agentName.trim().length > 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (step === 'done') {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <DoneStep agentName={savedName} onViewAgents={onDone} />
      </div>
    );
  }

  return (
    <OnboardingShell
      step={STEP_INDEX[step]}
      totalSteps={5}
      onBack={history.length > 0 ? back : undefined}
      onSkip={skip}
      onContinue={
        step === 'welcome'     ? () => advance('pick_preset') :
        step === 'pick_preset' ? () => advance('name_agent')  :
        step === 'name_agent'  ? () => advance('review')      :
        step === 'review'      ? () => void handleSave()      :
        undefined
      }
      continueLabel={step === 'review' ? 'Save & finish →' : undefined}
      continueDisabled={
        step === 'pick_preset' ? !canContinuePickPreset :
        step === 'name_agent'  ? !canContinueName        :
        false
      }
      continueBusy={saving}
    >
      {step === 'welcome' && <WelcomeStep />}

      {step === 'pick_preset' && (
        <PickPresetStep
          presets={presets}
          loading={presetsLoading}
          error={presetsError}
          selected={selectedPreset}
          onSelect={handleSelectPreset}
          onRetry={loadPresets}
        />
      )}

      {step === 'name_agent' && (
        <NameAgentStep
          name={agentName}
          onChange={setAgentName}
          onSubmit={() => { if (canContinueName) advance('review'); }}
        />
      )}

      {step === 'review' && (
        <ReviewStep
          name={agentName}
          preset={selectedPreset}
          saveError={saveError}
        />
      )}
    </OnboardingShell>
  );
}
