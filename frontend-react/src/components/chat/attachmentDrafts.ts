import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { AttachedFile } from './AttachedFileChip';

interface AttachmentDraft {
  files: AttachedFile[];
  links: string[];
}

const STORE = 'drafts';
const empty: AttachmentDraft = { files: [], links: [] };
const drafts = new Map<string, AttachmentDraft>();
const loading = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
let database: Promise<IDBDatabase | null> | undefined;

function openDatabase(): Promise<IDBDatabase | null> {
  database ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const request = indexedDB.open('cinderpaw-composer-attachments', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => resolve(null);
  });
  return database;
}

function notify(id: string): void {
  listeners.get(id)?.forEach((callback) => callback());
}

function load(id: string): Promise<void> {
  if (drafts.has(id)) return Promise.resolve();
  const existing = loading.get(id);
  if (existing) return existing;

  const pending = openDatabase().then((db) => new Promise<AttachmentDraft | undefined>((resolve) => {
    if (!db) return resolve(undefined);
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result as AttachmentDraft | undefined);
    request.onerror = () => resolve(undefined);
  })).catch(() => undefined).then((saved) => {
    drafts.set(id, saved ?? { files: [], links: [] });
    loading.delete(id);
    notify(id);
  });
  loading.set(id, pending);
  return pending;
}

function update(id: string, change: (draft: AttachmentDraft) => AttachmentDraft): void {
  const current = drafts.get(id);
  if (!current) {
    void load(id).then(() => update(id, change));
    return;
  }
  const next = change(current);
  drafts.set(id, next);
  notify(id);
  const saved = { ...next, files: next.files.filter((file) => !file.loading).map((file) =>
    file.videoUrl?.startsWith('blob:') ? { ...file, videoUrl: undefined } : file) };
  void openDatabase().then((db) => {
    if (!db) return;
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    if (saved.files.length || saved.links.length) store.put(saved, id);
    else store.delete(id);
  }).catch(() => {});
}

export function useAttachmentDraft(id: string) {
  const subscribe = useCallback((callback: () => void) => {
    const group = listeners.get(id) ?? new Set<() => void>();
    group.add(callback);
    listeners.set(id, group);
    return () => {
      group.delete(callback);
      if (group.size === 0) listeners.delete(id);
    };
  }, [id]);
  const snapshot = useCallback(() => drafts.get(id) ?? empty, [id]);
  const draft = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { void load(id); }, [id]);
  return {
    ...draft,
    ready: draft !== empty,
    setFiles: (files: AttachedFile[] | ((current: AttachedFile[]) => AttachedFile[])) =>
      update(id, (current) => ({ ...current, files: typeof files === 'function' ? files(current.files) : files })),
    setLinks: (links: string[] | ((current: string[]) => string[])) =>
      update(id, (current) => ({ ...current, links: typeof links === 'function' ? links(current.links) : links })),
  };
}
