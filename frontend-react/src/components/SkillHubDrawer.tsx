import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronLeft, ArrowUpRight } from 'lucide-react';
import { useUI } from '@/stores/ui';
import { tauri, type SkillMeta, type SkillPreview } from '@/lib/tauri';

type Tab = 'installed' | 'discover' | 'community' | 'import';

export function SkillHubDrawer() {
  const open       = useUI((s) => s.skillsOpen);
  const closeSkills = useUI((s) => s.closeSkills);

  const [tab, setTab]   = useState<Tab>('installed');

  // Installed tab state
  const [installed, setInstalled]           = useState<SkillMeta[]>([]);
  const [installedLoading, setInstalledLoading] = useState(false);
  const [installedError, setInstalledError]   = useState<string | null>(null);

  // Discover tab state
  const [remote, setRemote]             = useState<SkillMeta[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError]   = useState<string | null>(null);
  const [remoteFetched, setRemoteFetched] = useState(false);

  // Community tab state
  const [community, setCommunity]               = useState<SkillMeta[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError]     = useState<string | null>(null);
  const [communityFetched, setCommunityFetched] = useState(false);

  // Detail panel state
  const [selected, setSelected]               = useState<SkillMeta | null>(null);
  const [content, setContent]                 = useState<string | null>(null);
  const [contentLoading, setContentLoading]   = useState(false);
  const [contentError, setContentError]       = useState<string | null>(null);
  const [installing, setInstalling]           = useState(false);
  const [overwritePending, setOverwritePending] = useState(false);
  const [removePending, setRemovePending]     = useState(false);

  // Import tab state
  const [importInput, setImportInput]   = useState('');
  /**
   * Where the currently-selected skill came from. The install command differs
   * per source because the host, not this drawer, now fetches the content —
   * the old single `install_skill(meta, content, overwrite)` let the caller
   * hand over the file body and its trust label together, which is exactly
   * the shape that could not be given to the agent.
   */
  const [origin, setOrigin] = useState<{ kind: 'catalogue' } | { kind: 'url'; url: string } | { kind: 'file'; path: string } | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError]   = useState<string | null>(null);

  // Load installed when drawer opens
  useEffect(() => {
    if (!open) return;
    loadInstalled();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function loadInstalled() {
    setInstalledLoading(true);
    setInstalledError(null);
    tauri.skills.listInstalled()
      .then(list => { setInstalled(list); setInstalledLoading(false); })
      .catch((e: unknown) => { setInstalledError(String(e)); setInstalledLoading(false); });
  }

  function reloadInstalled() {
    tauri.skills.listInstalled()
      .then(list => {
        setInstalled(list);
        const ids = new Set(list.map(s => s.id));
        const syncStatus = (s: SkillMeta) => ({
          ...s,
          install_status: ids.has(s.id) ? 'installed' : 'not_installed',
        });
        setRemote(prev => prev.map(syncStatus));
        setCommunity(prev => prev.map(syncStatus));
      })
      .catch(() => {});
  }

  function fetchRemote() {
    if (remoteFetched) return;
    setRemoteFetched(true);
    setRemoteLoading(true);
    setRemoteError(null);
    tauri.skills.fetchRemote()
      .then(list => { setRemote(list); setRemoteLoading(false); })
      .catch((e: unknown) => { setRemoteError(String(e)); setRemoteLoading(false); });
  }

  function fetchCommunity() {
    if (communityFetched) return;
    setCommunityFetched(true);
    setCommunityLoading(true);
    setCommunityError(null);
    // Load from bundled public/community-manifest.json — works in both dev (Vite) and prod (dist)
    fetch('/community-manifest.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<SkillMeta[]>; })
      .then(list => {
        // Cross-reference with installed skills to set install_status
        tauri.skills.listInstalled()
          .then(installed => {
            const ids = new Set(installed.map(s => s.id));
            setCommunity(list.map(s => ({ ...s, install_status: ids.has(s.id) ? 'installed' : 'not_installed' })));
          })
          .catch(() => { setCommunity(list); });
        setCommunityLoading(false);
      })
      .catch((e: unknown) => { setCommunityError(String(e)); setCommunityLoading(false); });
  }

  // Fetch a bundled local SKILL.md via browser fetch (public/ dir, no backend needed)
  async function fetchBundledContent(localPath: string): Promise<string> {
    const r = await fetch(localPath);
    if (!r.ok) throw new Error(`HTTP ${r.status}: skill content not found`);
    return r.text();
  }

  function openDetail(
    skill: SkillMeta,
    getContent: () => Promise<string>,
    from: { kind: 'catalogue' } | { kind: 'url'; url: string } | { kind: 'file'; path: string } = { kind: 'catalogue' },
  ) {
    setOrigin(from);
    setSelected(skill);
    setContent(null);
    setContentError(null);
    setContentLoading(true);
    setOverwritePending(false);
    setRemovePending(false);
    getContent()
      .then(c => { setContent(c); setContentLoading(false); })
      .catch((e: unknown) => { setContentError(String(e)); setContentLoading(false); });
  }

  function closeDetail() {
    setOrigin(null);
    setSelected(null);
    setContent(null);
    setContentError(null);
    setInstalling(false);
    setOverwritePending(false);
    setRemovePending(false);
  }

  async function doInstall(overwrite: boolean) {
    if (!selected || !origin) return;
    setInstalling(true);
    try {
      if (origin.kind === 'url') {
        await tauri.skills.installFromUrl(origin.url, overwrite);
      } else if (origin.kind === 'file') {
        await tauri.skills.installFromFile(origin.path, overwrite);
      } else {
        await tauri.skills.installFromCatalogue(selected.id);
      }
      setInstalling(false);
      setOverwritePending(false);
      setSelected(prev => prev ? { ...prev, install_status: 'installed' } : null);
      reloadInstalled();
    } catch (e: unknown) {
      setInstalling(false);
      setContentError(`Install failed: ${String(e)}`);
    }
  }

  async function tryInstall() {
    if (!selected) return;
    setInstalling(true);
    try {
      const exists = await tauri.skills.exists(selected.id);
      if (exists) {
        setInstalling(false);
        setOverwritePending(true);
      } else {
        await doInstall(false);
      }
    } catch (e: unknown) {
      setInstalling(false);
      setContentError(`Failed to check: ${String(e)}`);
    }
  }

  async function doRemove() {
    if (!selected) return;
    try {
      await tauri.skills.remove(selected.id);
      closeDetail();
      reloadInstalled();
    } catch (e: unknown) {
      setContentError(`Remove failed: ${String(e)}`);
      setRemovePending(false);
    }
  }

  async function doImport() {
    const input = importInput.trim();
    if (!input) return;
    setImportLoading(true);
    setImportError(null);
    try {
      const isUrl = input.startsWith('https://');
      const preview: SkillPreview = isUrl
        ? await tauri.skills.previewRemote(input)
        : await tauri.skills.previewLocal(input);
      setImportInput('');
      setImportError(null);
      openDetail(
        preview.meta,
        async () => preview.content,
        isUrl ? { kind: 'url', url: input } : { kind: 'file', path: input },
      );
    } catch (e: unknown) {
      setImportError(String(e));
    } finally {
      setImportLoading(false);
    }
  }

  const badgeColor: Record<string, string> = {
    local:        'bg-success/15 text-success',
    community:    'bg-brand/15 text-brand',
    bundled:      'bg-info/15 text-info',
    verified:     'bg-success/20 text-success',
    experimental: 'bg-warning/15 text-warning',
    unknown:      'bg-bg-hover text-text-muted',
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-30 bg-black/25"
            onClick={closeSkills}
          />

          {/* Drawer */}
          <motion.aside
            key="drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: 'easeInOut' }}
            className="fixed right-0 top-0 bottom-0 w-[400px] z-40 bg-bg-surface border-l border-border-subtle flex flex-col shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-border-subtle shrink-0">
              <span className="font-semibold text-sm text-text-primary">Skills</span>
              <button
                type="button"
                onClick={() => { closeSkills(); closeDetail(); }}
                className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            {/* Tabs — hidden when detail is open */}
            {!selected && (
              <div role="tablist" aria-label="Skills" className="flex border-b border-border-subtle shrink-0">
                {(['installed', 'discover', 'community', 'import'] as Tab[]).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setTab(t);
                      if (t === 'discover') fetchRemote();
                      if (t === 'community') fetchCommunity();
                    }}
                    role="tab"
                    aria-selected={tab === t}
                    className={`flex-1 py-2.5 text-2xs font-medium capitalize transition-colors border-b-2 -mb-px ${
                      tab === t
                        ? 'border-brand text-text-primary'
                        : 'border-transparent text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto scrollbar-hide p-3 flex flex-col gap-2">

              {/* Detail panel */}
              {selected ? (
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={closeDetail}
                    className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary w-fit"
                  >
                    <ChevronLeft size={13} />
                    Back
                  </button>

                  <div className="flex items-start justify-between gap-2">
                    <span className="font-bold text-sm text-text-primary">{selected.name}</span>
                    <span className={`text-micro font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0 ${badgeColor[selected.trust_label] ?? badgeColor.unknown}`}>
                      {selected.trust_label}
                    </span>
                  </div>

                  {/* Metadata */}
                  <div className="flex gap-3 flex-wrap text-2xs text-text-muted">
                    {selected.author && <span>{selected.author}</span>}
                    {selected.version && selected.version !== '0.0.0' && <span>v{selected.version}</span>}
                    {selected.license && <span>{selected.license}</span>}
                  </div>

                  {/* Tags */}
                  {selected.tags.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap">
                      {selected.tags.map(t => (
                        <span key={t} className="text-2xs px-2 py-0.5 rounded-full bg-bg-elevated text-text-muted">{t}</span>
                      ))}
                    </div>
                  )}

                  {/* Source link */}
                  {selected.source_url && (
                    <a
                      href={selected.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-2xs text-brand hover:underline w-fit"
                    >
                      View source <ArrowUpRight size={11} />
                    </a>
                  )}

                  {/* Content */}
                  <div className="border border-border-subtle rounded-lg overflow-hidden">
                    {contentLoading && <p className="text-xs text-text-muted p-3">Loading content…</p>}
                    {contentError && (
                      <p className="text-xs text-error p-3">
                        {contentError.includes('404') || contentError.includes('Not Found')
                          ? 'Skill content not found. The manifest URL may be outdated.'
                          : contentError}
                      </p>
                    )}
                    {content && !contentLoading && !contentError && (
                      <pre className="text-2xs leading-relaxed text-text-muted p-3 whitespace-pre-wrap break-words max-h-64 overflow-y-auto scrollbar-hide font-mono">{content}</pre>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="pt-2 border-t border-border-subtle">
                    {selected.install_status === 'installed' ? (
                      removePending ? (
                        <div className="space-y-2">
                          <p className="text-xs text-text-muted">Remove this skill from Cinderpaw? This cannot be undone in v1.</p>
                          <div className="flex gap-2">
                            <button type="button" onClick={() => void doRemove()}
                              className="px-3 py-1.5 text-xs rounded bg-error text-white hover:bg-error/90">
                              Confirm Remove
                            </button>
                            <button type="button" onClick={() => setRemovePending(false)}
                              className="px-3 py-1.5 text-xs rounded text-text-muted hover:bg-bg-hover">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" onClick={() => setRemovePending(true)}
                          className="px-3 py-1.5 text-xs rounded text-error border border-error/30 hover:bg-error/10 transition-colors">
                          Remove
                        </button>
                      )
                    ) : overwritePending ? (
                      <div className="space-y-2">
                        <p className="text-xs text-text-muted">A skill with this ID is already installed. Overwrite?</p>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => void doInstall(true)}
                            className="px-3 py-1.5 text-xs rounded bg-brand text-on-brand hover:bg-brand/90">
                            Overwrite
                          </button>
                          <button type="button" onClick={() => setOverwritePending(false)}
                            className="px-3 py-1.5 text-xs rounded text-text-muted hover:bg-bg-hover">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={() => void tryInstall()}
                        disabled={installing || content === null || contentError !== null}
                        className="px-3 py-1.5 text-xs rounded bg-brand text-on-brand hover:bg-brand/90 disabled:opacity-50 transition-colors">
                        {installing ? 'Installing…' : 'Install'}
                      </button>
                    )}
                  </div>
                </div>
              ) : tab === 'installed' ? (
                /* Installed tab */
                installedLoading ? (
                  <SkeletonList />
                ) : installedError ? (
                  <ErrorState message={installedError} onRetry={loadInstalled} />
                ) : installed.length === 0 ? (
                  <EmptyState message="No skills installed yet." hint="Use Discover or Import to add skills." />
                ) : (
                  installed.map(skill => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      action={{ label: 'Details', onClick: () =>
                        openDetail(skill, () => tauri.skills.getContent(skill.id))
                      }}
                      badgeColor={badgeColor}
                    />
                  ))
                )
              ) : tab === 'discover' ? (
                /* Discover tab */
                remoteLoading ? (
                  <SkeletonList />
                ) : remoteError ? (
                  <ErrorState message={remoteError} onRetry={() => { setRemoteFetched(false); fetchRemote(); }} />
                ) : remote.length === 0 ? (
                  <EmptyState message="No remote skills found." hint="Check your connection or try again." />
                ) : (
                  remote.map(skill => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      action={skill.install_status === 'installed'
                        ? { label: '✓ Installed', disabled: true, onClick: () => {} }
                        : { label: 'Preview', onClick: () =>
                            openDetail(skill, () =>
                              tauri.skills.previewRemote(skill.content_url ?? '')
                                .then((p: SkillPreview) => p.content)
                            )
                          }
                      }
                      badgeColor={badgeColor}
                    />
                  ))
                )
              ) : tab === 'community' ? (
                /* Community tab — ClawHub/community-attributed skills */
                communityLoading ? (
                  <SkeletonList />
                ) : communityError ? (
                  <ErrorState message={communityError} onRetry={() => { setCommunityFetched(false); fetchCommunity(); }} />
                ) : community.length === 0 ? (
                  <EmptyState message="No community skills found." hint="Check your connection or try again." />
                ) : (
                  <>
                    <p className="text-2xs text-text-muted px-1 pb-1">
                      Community skills are contributed by third-party authors and are not vetted or maintained by Cinderpaw.
                      Preview before installing.
                    </p>
                    {community.map(skill => (
                      <SkillCard
                        key={skill.id}
                        skill={skill}
                        showAuthor
                        action={skill.install_status === 'installed'
                          ? { label: '✓ Installed', disabled: true, onClick: () => {} }
                          : { label: 'Preview', onClick: () => {
                              const url = skill.content_url ?? '';
                              // Bundled local file (starts with /) → browser fetch; otherwise → backend
                              const getContent = url.startsWith('/')
                                ? () => fetchBundledContent(url)
                                : () => tauri.skills.previewRemote(url).then((p: SkillPreview) => p.content);
                              openDetail(skill, getContent);
                            }}
                        }
                        badgeColor={badgeColor}
                      />
                    ))}
                  </>
                )
              ) : (
                /* Import tab */
                <div className="flex flex-col gap-3">
                  <p className="text-xs text-text-muted leading-relaxed">
                    Paste a SKILL.md URL (https://raw.githubusercontent.com/…) or a local file path:
                  </p>
                  <input
                    type="text"
                    value={importInput}
                    onChange={e => setImportInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void doImport(); }}
                    placeholder="https://raw.githubusercontent.com/… or /path/to/SKILL.md"
                    className="w-full rounded-md border border-bg-hover bg-bg-elevated px-3 py-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
                  />
                  <button
                    type="button"
                    onClick={() => void doImport()}
                    disabled={importLoading || !importInput.trim()}
                    className="px-3 py-1.5 text-xs rounded bg-brand text-on-brand hover:bg-brand/90 disabled:opacity-50 transition-colors w-fit"
                  >
                    {importLoading ? 'Loading…' : 'Preview'}
                  </button>
                  {importError && <p className="text-xs text-error">{importError}</p>}
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// Sub-components

function SkillCard({
  skill, action, badgeColor, showAuthor = false,
}: {
  skill: SkillMeta;
  action: { label: string; onClick: () => void; disabled?: boolean };
  badgeColor: Record<string, string>;
  showAuthor?: boolean;
}) {
  const providerLabel: Record<string, string> = {
    clawhub: 'ClawHub',
    github:  'GitHub',
    local:   'Local',
  };

  return (
    <div className="bg-bg-elevated border border-border-subtle rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text-primary truncate">{skill.name}</span>
        <span className={`text-micro font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0 ${badgeColor[skill.trust_label] ?? badgeColor.unknown}`}>
          {skill.trust_label}
        </span>
      </div>
      {showAuthor && (skill.author || skill.source_provider) && (
        <div className="flex items-center gap-2 text-2xs text-text-muted">
          {skill.author && <span>by {skill.author}</span>}
          {skill.source_provider && (
            <span className="px-1.5 py-px rounded bg-bg-hover text-micro">
              {providerLabel[skill.source_provider] ?? skill.source_provider}
            </span>
          )}
        </div>
      )}
      {skill.description && (
        <p className="text-xs text-text-muted leading-relaxed line-clamp-2">{skill.description}</p>
      )}
      <button
        type="button"
        onClick={action.onClick}
        disabled={action.disabled}
        className={`text-xs px-2.5 py-1 rounded border transition-colors w-fit ${
          action.disabled
            ? 'border-success/30 text-success cursor-default opacity-80'
            : 'border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary'
        }`}
      >
        {action.label}
      </button>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="flex flex-col gap-2">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-bg-elevated border border-border-subtle rounded-xl p-3 space-y-2 animate-pulse">
          <div className="h-3.5 w-1/2 rounded bg-bg-hover" />
          <div className="h-3 w-5/6 rounded bg-bg-hover" />
          <div className="h-3 w-2/3 rounded bg-bg-hover" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ message, hint }: { message: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
      <p className="text-sm text-text-muted">{message}</p>
      <p className="text-xs text-text-muted/50">{hint}</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <p className="text-xs text-error">{message}</p>
      <button type="button" onClick={onRetry}
        className="text-xs px-2.5 py-1 rounded border border-border-subtle text-text-muted hover:bg-bg-hover w-fit">
        Retry
      </button>
    </div>
  );
}
