import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useSettings, type ByokProviderUpdate } from '@/stores/settings';
import type { ByokProvider } from '@/lib/tauri';

const PROVIDER_DEFS = [
  { id: 'openai',     name: 'OpenAI',         hasBaseUrl: true,  baseUrlHint: 'https://api.openai.com/v1',     availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'anthropic',  name: 'Anthropic',       hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'google',     name: 'Google Gemini',   hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'kimi',       name: 'Kimi',            hasBaseUrl: false, baseUrlHint: '',                              availableModels: ['kimi-for-coding'] as const,                                                                    keyPrefix: 'sk-kimi-' },
  { id: 'glm',        name: 'GLM (Z.ai)',      hasBaseUrl: false, baseUrlHint: '',                              availableModels: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'] as const,                       keyPrefix: undefined  },
  { id: 'minimax',    name: 'MiniMax',         hasBaseUrl: false, baseUrlHint: '',                              availableModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'] as const, keyPrefix: 'sk-cp-'   },
  { id: 'deepseek',   name: 'DeepSeek',        hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'groq',       name: 'Groq',            hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'mistral',    name: 'Mistral',         hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'openrouter', name: 'OpenRouter',      hasBaseUrl: true,  baseUrlHint: 'https://openrouter.ai/api/v1', availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'custom',     name: 'Custom Endpoint', hasBaseUrl: true,  baseUrlHint: 'https://your-endpoint/v1',      availableModels: undefined,                                                                                      keyPrefix: undefined  },
] as const;

type ProviderDef = typeof PROVIDER_DEFS[number];

function ProviderRow({ def, state }: { def: ProviderDef; state?: ByokProvider }) {
  const saveByokProvider = useSettings((s) => s.saveByokProvider);
  const testByokProvider = useSettings((s) => s.testByokProvider);

  const [open, setOpen]             = useState(false);
  const [enabled, setEnabled]       = useState(state?.enabled ?? false);
  const [apiKey, setApiKey]         = useState('');
  const [baseUrl, setBaseUrl]       = useState(state?.base_url ?? '');
  const [defaultModel, setDefModel] = useState(
    state?.default_model ?? (def.availableModels ? def.availableModels[0] : ''),
  );
  const [showKey, setShowKey]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [saveMsg, setSaveMsg]       = useState<string | null>(null);
  const [testing, setTesting]       = useState(false);
  const [testMsg, setTestMsg]       = useState<string | null>(null);

  const isActive = !!(state?.enabled && state?.has_api_key);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const p: ByokProviderUpdate = {
        providerId: def.id,
        enabled,
        apiKey,
        baseUrl: def.hasBaseUrl ? (baseUrl || null) : null,
        defaultModel: defaultModel || null,
      };
      await saveByokProvider(p);
      setSaveMsg('✓ Saved');
      setTimeout(() => setSaveMsg(null), 2000);
    } catch {
      setSaveMsg('Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const result = await testByokProvider({
        providerId: def.id,
        apiKey,
        baseUrl: def.hasBaseUrl ? (baseUrl || null) : null,
      });
      setTestMsg(result.ok ? '✓ Connected' : `Error: ${result.error ?? 'Unknown error'}`);
    } catch (e) {
      setTestMsg(`Error: ${String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const inputCls = 'w-full px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary';
  const btnSecCls = 'px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-border-subtle hover:bg-bg-hover transition-colors text-left">
        <span className="text-sm font-medium text-text-primary">{def.name}</span>
        <span className={cn(
          'text-xs px-2 py-0.5 rounded-full shrink-0',
          isActive ? 'bg-green-500/20 text-green-400' : 'bg-bg-hover text-text-muted',
        )}>
          {isActive ? 'Active' : 'Not configured'}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="px-4 pt-3 pb-4 border border-t-0 border-border-subtle rounded-b-lg space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={cn('w-10 h-6 rounded-full transition-colors relative shrink-0 overflow-hidden', enabled ? 'bg-blue-500' : 'bg-neutral-600')}
            >
              <span className={cn('absolute top-1 left-0 w-4 h-4 rounded-full bg-white transition-transform', enabled ? 'translate-x-5' : 'translate-x-1')} />
            </button>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-muted">API Key</label>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={state?.has_api_key ? 'Key saved — enter new key to update' : 'sk-...'}
                className={cn(inputCls, 'flex-1 font-mono')}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="px-2 py-1.5 rounded-md border border-border-subtle text-text-muted hover:bg-bg-hover"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {def.keyPrefix && apiKey.startsWith(def.keyPrefix) && (
              <p className="text-xs text-green-400 mt-1">✓ {def.name} key detected</p>
            )}
          </div>

          {def.hasBaseUrl && (
            <div className="space-y-1">
              <label className="text-xs text-text-muted">
                Base URL
              </label>
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={def.baseUrlHint || 'https://…'}
                className={inputCls}
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-text-muted">
              {def.availableModels ? 'Model' : 'Default model (optional)'}
            </label>
            {def.availableModels ? (
              <select
                value={defaultModel}
                onChange={(e) => setDefModel(e.target.value)}
                className={cn(inputCls, 'cursor-pointer appearance-none')}
              >
                {def.availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={defaultModel}
                onChange={(e) => setDefModel(e.target.value)}
                placeholder="gpt-4o"
                className={inputCls}
              />
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={() => void handleTest()} disabled={testing || !apiKey} className={btnSecCls}>
              {testing ? 'Testing…' : 'Test'}
            </button>
            <button type="button" onClick={() => void handleSave()} disabled={saving} className="px-3 py-1.5 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium disabled:opacity-50 transition-colors">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {testMsg && <span className={cn('text-xs', testMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400')}>{testMsg}</span>}
            {saveMsg && <span className={cn('text-xs', saveMsg.startsWith('✓') ? 'text-text-muted' : 'text-red-400')}>{saveMsg}</span>}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ByokTab() {
  const byok = useSettings((s) => s.byok);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Cloud Keys</h2>
        <p className="text-xs text-text-muted mt-1">Add API keys to use cloud AI providers alongside local models.</p>
      </div>
      <div className="space-y-2">
        {PROVIDER_DEFS.map((def) => (
          <ProviderRow key={def.id} def={def} state={byok.find((b) => b.id === def.id)} />
        ))}
      </div>
    </div>
  );
}
