import {
  Calendar, Check, Clock, FileText, Home, Info, Link, MapPin, Star, Tag, Users, Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { cn } from '@/lib/utils';
import type { WidgetData, WidgetIcon } from '@/lib/widgets';

/** The fixed icon set `show_widget` names (WIDGET_ICONS in the sidecar). */
const ICON: Record<WidgetIcon, LucideIcon> = {
  calendar: Calendar, clock: Clock, 'map-pin': MapPin, wallet: Wallet, users: Users, star: Star,
  check: Check, info: Info, file: FileText, link: Link, tag: Tag, home: Home,
};

const CARD = 'rounded-2xl border border-border-default bg-bg-surface p-4';

function Title({ children, aside }: { children?: string; aside?: string }) {
  if (!children && !aside) return null;
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <span className="flex-1 text-sm font-semibold text-text-primary">{children}</span>
      {aside && <span className="shrink-0 text-2xs text-text-disabled">{aside}</span>}
    </div>
  );
}

function Bar({ share, className }: { share: number; className?: string }) {
  return (
    <span className={cn('block overflow-hidden rounded-full bg-border-subtle', className)}>
      <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%` }} />
    </span>
  );
}

/**
 * A picture the engine keeps in the profile (`imageFile`), or the warm
 * placeholder: when there is none, and when it fails to load. Never a
 * broken-image icon.
 */
function Picture({ file, className }: { file?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!file || failed) return <span aria-hidden className={cn('block bg-bg-active', className)} />;
  return (
    <img
      src={convertFileSrc(file)}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('block object-cover', className)}
    />
  );
}

function openLink(url: string) {
  void open(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
}

/**
 * A chat widget, drawn from data (spec 7.1). Every kind in `WidgetData`,
 * including `list`, the fallback for data that did not fit its kind.
 * Card and column pictures are files the engine fetched and keeps
 * (`imageFile`); the app never loads a remote image itself.
 */
export function ChatWidget({ w }: { w: WidgetData }) {
  switch (w.kind) {
    case 'facts':
      return (
        <div className={CARD}>
          <Title>{w.title}</Title>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {w.items.map((it) => {
              const Icon = it.icon ? ICON[it.icon] : null;
              return (
                <div key={it.label} className="flex min-w-0 items-start gap-2.5">
                  {Icon && (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-active text-brand">
                      <Icon size={16} />
                    </span>
                  )}
                  <span className="min-w-0">
                    <dt className="truncate text-2xs text-text-disabled">{it.label}</dt>
                    <dd className="truncate text-sm font-medium text-text-primary" title={it.value}>{it.value}</dd>
                  </span>
                </div>
              );
            })}
          </dl>
        </div>
      );
    case 'checklist': {
      const done = w.items.filter((it) => it.done).length;
      return (
        <div className={CARD}>
          <Title aside={`${done} of ${w.items.length} done`}>{w.title}</Title>
          <Bar share={done / w.items.length} className="mb-2 h-1.5" />
          <ul>
            {w.items.map((it, i) => (
              <li key={i} className="flex items-start gap-3 py-1.5">
                <span
                  aria-label={it.done ? 'Done' : 'Not done'}
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    it.done ? 'border-success bg-success text-white' : 'border-border-default',
                  )}
                >
                  {it.done && <Check size={12} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm', it.done ? 'text-text-muted line-through' : 'text-text-primary')}>{it.text}</span>
                  {it.note && <span className="block text-2xs text-text-disabled">{it.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case 'cards':
      return (
        <div>
          {w.title && <Title>{w.title}</Title>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {w.items.map((it, i) => {
              const body = (
                <>
                  <Picture file={it.imageFile} className="aspect-[4/3] w-full rounded-lg" />
                  <span className="mt-2 block truncate text-sm font-medium text-text-primary">{it.title}</span>
                  {it.subtitle && <span className="block truncate text-2xs text-text-disabled">{it.subtitle}</span>}
                </>
              );
              return it.url ? (
                <button key={i} type="button" onClick={() => openLink(it.url!)} title={it.url}
                  className="rounded-2xl border border-border-default bg-bg-surface p-2.5 text-left hover:border-brand/40 transition-colors">
                  {body}
                </button>
              ) : (
                <div key={i} className="rounded-2xl border border-border-default bg-bg-surface p-2.5">{body}</div>
              );
            })}
          </div>
        </div>
      );
    case 'breakdown': {
      const max = w.total ?? Math.max(...w.items.map((it) => it.value), 1);
      return (
        <div className={CARD}>
          <Title aside={w.total !== undefined ? `Total ${w.total.toLocaleString()}` : undefined}>{w.title}</Title>
          <div className="flex flex-col gap-2.5">
            {w.items.map((it) => (
              <div key={it.label} className="grid grid-cols-[6rem_minmax(0,1fr)_3.5rem] items-center gap-2.5 text-2xs">
                <span className="truncate text-text-muted">{it.label}</span>
                <Bar share={it.value / max} className="h-2" />
                <span className="text-right tabular-nums text-text-primary">{it.value.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case 'progress':
      return (
        <div className={CARD}>
          <Title aside={`${w.done} of ${w.total}`}>{w.title ?? w.label}</Title>
          <Bar share={w.done / w.total} className="h-1.5" />
          {w.title && <p className="mt-2 text-2xs text-text-disabled">{w.label}</p>}
        </div>
      );
    case 'table':
      return (
        <div className={cn(CARD, 'overflow-x-auto thin-scrollbar')}>
          <Title>{w.title}</Title>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th />
                {w.columns.map((c) => (
                  <th key={c.title} scope="col" className="px-2 pb-2 text-left align-bottom">
                    {c.imageFile && <Picture file={c.imageFile} className="mb-2 h-16 w-24 rounded-lg" />}
                    <span className="block font-semibold text-text-primary">{c.title}</span>
                    {c.subtitle && <span className="block text-2xs font-normal text-text-disabled">{c.subtitle}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {w.rows.map((r) => (
                <tr key={r.label} className="border-t border-border-subtle">
                  <th scope="row" className="py-2 pr-2 text-left text-2xs font-normal text-text-muted">{r.label}</th>
                  {r.cells.map((cell, i) => <td key={i} className="px-2 py-2 text-text-primary">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'verdict':
      return (
        <div className="rounded-2xl border border-brand/25 bg-bg-active p-4">
          <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-brand">{w.title ?? 'My take'}</p>
          <p className="text-sm text-text-primary">{w.text}</p>
        </div>
      );
    case 'followups':
      // Drawn at the end of the reply as chips (FollowUps), never in place.
      return null;
    case 'list':
      return (
        <div className={CARD}>
          <Title>{w.title}</Title>
          <ul className="list-disc pl-5 text-sm text-text-primary">
            {w.lines.map((l, i) => <li key={i} className="py-0.5">{l}</li>)}
          </ul>
        </div>
      );
  }
}
