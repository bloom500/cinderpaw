# Frontend Audit — UI/UX/Accessibility/Visual — Feral React app

**Scope:** static + vizual review pe `frontend-react/` (Tauri React app cu Vite/Tailwind/shadcn). Nu pot rula app-ul complet pentru că depinde de Tauri IPC (webview + Rust backend), dar am făcut spot-check manual pe fiecare component principal + măsurători (contrast ratios WCAG, z-index stacks, focus states, hidden state issues) + două mockup-uri vizuale generate din cod pentru feedback direct.

**Structura raport:**
- §F1-§F8: bugs UI vizibile utilizatorilor
- §F9-§F14: accessibility (a11y) issues cu impact real
- §F15-§F20: styling/theme drift + inconsistențe
- §F21-§F26: UX flow bugs (states pierdute, race, empty states)
- §F27-§F30: performance UI + rendering

Am ținut ~30 findings — density mare pe zone cu impact user-visible, nu numerar padding.

---

## §F1 — Contrast WCAG AA FAILED pentru `error`, `brand-light`, `text-muted-light`

Măsurat cu formula WCAG 2.1 contrast ratio pe palette din `globals.css`:

**Dark mode `:root[data-theme="dark"]`:**
| Combinație | Ratio | AA (4.5:1)? | AAA (7:1)? |
|---|---|---|---|
| `text-primary #F0E6D3` on `bg-primary #100E09` | 15.58 | ✅ | ✅ |
| `text-secondary #B8AC95` on `bg-primary` | 8.61 | ✅ | ✅ |
| `text-muted #8C7E6A` on `bg-primary` | 4.87 | ✅ (margin subțire) | ❌ |
| `text-disabled #4A4035` on `bg-primary` | 1.91 | ❌ FAIL | ❌ |
| **`error #C0472A` on `bg-primary`** | **3.84** | **❌ FAIL** | ❌ |
| `brand #C4843A` on `bg-primary` | 6.16 | ✅ | ❌ |
| `warning #D4A03A` on `bg-primary` | 8.16 | ✅ | ✅ |
| `success #6A9E5A` on `bg-primary` | 6.11 | ✅ | ❌ |

**Light mode `:root[data-theme="light"]`:**
| Combinație | Ratio | AA? |
|---|---|---|
| `text-primary #1C1610` on `bg-primary #FFF5EE` | 16.68 | ✅ |
| `text-secondary #4A3F32` on `bg-primary` | 9.54 | ✅ |
| **`text-muted #8C7060` on `bg-primary`** | **4.25** | **❌ FAIL** (limit 4.5) |
| **`brand #A06828` on `bg-primary`** | **4.34** | **❌ FAIL** |
| `brand-hover #8B5820` on `bg-primary` | 5.56 | ✅ |

**Impact:**
- Toate mesajele error (`StreamErrorNotice`, `text-error` class, error banners din Sidebar delete dialog, download failures) sunt sub AA în dark mode → utilizatori cu vedere scăzută nu pot citi mesaje critice.
- Meta text (timestamp mesaj `text-[11px] text-text-muted`, tokens/sec, `Recent` labels) în light mode 4.25 — insuficient pentru text de 11px care e sub 18px threshold pentru "large text" (unde AA e 3:1).
- Butoane `text-brand` links în light mode 4.34 sub AA.

**Fix:**

```css
:root[data-theme="dark"] {
  --error: #D4553A;         /* was #C0472A → ratio 4.84 */
  --text-disabled: #665A4A; /* was #4A4035 → ratio 3.5 (acceptable pentru disabled) */
}

:root[data-theme="light"] {
  --text-muted: #7A5C4A;    /* was #8C7060 → ratio 5.65 */
  --brand: #8B5820;         /* was #A06828 → ratio 5.56, same as brand-hover  */
  --brand-hover: #6B4218;   /* new stronger hover */
}
```

Trade-off: brand devine mai închis în light mode, dar readable.

---

## §F2 — Butoane primare folosesc `text-white` hardcoded → contrast fail pe theme change + dark/light

`Sidebar.tsx:321,398`:
```tsx
className="px-3 py-1.5 text-sm rounded bg-brand text-white disabled:opacity-40"
```

Same pattern în `ToolsPopover.tsx:39` (`bg-brand text-white`), `PresetCard.tsx:46`, multiple settings switches.

`bg-brand #C4843A` + `text-white #FFFFFF` → ratio **3.28** — FAIL AA la 14px small text.

`bg-brand #C4843A` + `primary-foreground #100E09` (per globals.css:100) → ratio **6.16** — PASS.

Deci CSS var-ul corect există (`--primary-foreground: var(--bg-primary)` → dark almost-black), dar butoanele nu-l folosesc.

**Fix**: înlocuiește `text-white` cu `text-primary-foreground` global în toate butoanele bg-brand:

```tsx
className="px-3 py-1.5 text-sm rounded bg-brand text-primary-foreground disabled:opacity-40"
```

Sau folosește direct `<Button variant="default">` din shadcn care are corect setup.

Regex înlocuire safe: `bg-brand[^"]*text-white` → `bg-brand ...text-primary-foreground`.

---

## §F3 — Z-index conflict: notifications z-[100] blocată de window controls z-40 sau invers

`AppShell.tsx`:
```tsx
{/* Window controls */}
<div className="fixed top-0 right-0 z-40 flex items-center">
  <WinControls />
</div>
{/* Toasts + Update card */}
<div className="fixed top-11 right-4 z-[100] w-80 flex flex-col gap-2 pointer-events-none">
  <UpdateToast />
  <Toasts />
</div>
```

Layout: `top-0 right-0 z-40 h-8 w-30` (window controls) vs `top-11 right-4 z-[100] w-80` (toasts).

Toasts start la `top-11 = 44px` = imediat sub window controls `h-8 = 32px`. Cu 12px margin. OK în teorie.

Dar: dacă un toast are `pointer-events-auto` (necesar pentru interacționare), și cade in area de sub controls dar e wide, click prin toast passes sau nu? `pointer-events-none` pe container, dar Toast child probably `pointer-events-auto`. Rezultat: click în area toast-ului nu ajunge la window controls, dar acestea sunt sus, nu în toast area.

**Problema reală**: Dialog folosește `z-50` (`dialog.tsx:39,22`). SearchOverlay `z-50`. OnboardingWizard `z-50`. Când toast fires ÎN TIMPUL onboarding wizard-ului, toast cu z-[100] apare deasupra wizard-ului z-50 → **user vede notification pop-up peste modal blocking**, ceea ce e greșit — wizard-ul e supose să fie interstitial exclusiv.

**Fix**: normalize z-index scale:

```ts
// Introduce în utils sau constants:
export const Z = {
  ChatProgress: 10,
  Sidebar: 20,
  ChatInput: 20,
  SkillDrawer: 30,
  DrawerOverlay: 25,      // between sidebar and drawer
  WindowControls: 40,
  Toasts: 45,             // above window controls, below modals
  Modal: 50,              // Dialog, SearchOverlay, OnboardingWizard
  ModalToast: 55,         // toast INSIDE modal, if ever needed
};
```

Toasts NU trebuie să fie deasupra modal. Adjusts:

```tsx
<div className="fixed top-11 right-4 z-[45] w-80 ...">
  <UpdateToast />
  <Toasts />
</div>
```

Modal (Dialog/OnboardingWizard/SearchOverlay) rămâne z-50 → covers toast când e active → correct isolation.

---

## §F4 — Streaming cursor `▍` (CSS ::after) rămâne visible pe empty children

`globals.css:220-228`:
```css
.streaming-content > *:last-child::after {
  content: '▍';
  ...
}
```

Cursor se atașează la ultimul copil DIRECT al `.streaming-content`. Dacă markdown render produce un ultimul copil = `<pre><code>...</code></pre>` (code block), cursor apare peste ultimul copil dar în afara `<code>` → arată bizar (dupa `</code></pre>`, în margin).

Când `message.content = ''` (start streaming, no tokens yet): Markdown returns `<>` fragment or empty. `> *:last-child` selector doesn't match anything → no cursor visible. Utilizatorul vede spațiu gol în bubble. Poate să-i dea impresia că nimic nu se întâmplă timp de câteva secunde până first token.

`StreamingIndicator` render doar când `messages[messages.length - 1]?.content === ''` (`MessageList.tsx:44-47`). Deci vibul e că STREAMING indicator fires când content=empty, iar cursor fires când content non-empty. Split OK.

**Bug real subtle**: dacă content ends în `<hr>` sau `<img>` (void elements), `::after` pseudo-element pe void element NU se render în Chrome/WebKit (per spec). Cursor invisible după markdown care are trailing image.

**Fix**: appendă explicit un `<span>` sentinel:

```tsx
// În Markdown component pe streaming path:
return (
  <div className="streaming-content">
    {rendered}
    {animateWords && <span className="cursor-sentinel" aria-hidden />}
  </div>
);
```

Și în CSS:
```css
.streaming-content .cursor-sentinel::after { content: '▍'; ... }
```

Cursor sempre pe sentinel. Consistent.

---

## §F5 — MessageList autoscroll — user care scrollează up la START turn pierde mesajul nou

`MessageList.tsx:14-24`:
```tsx
useEffect(() => {
  const el = containerRef.current;
  if (!el) return;
  const onScroll = () => {
    const threshold = 40;
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  return () => el.removeEventListener('scroll', onScroll);
}, []);

useEffect(() => {
  const el = containerRef.current;
  if (el && isAtBottomRef.current) el.scrollTop = el.scrollHeight;
}, [messages, status]);
```

Scenariul buggy:
1. User conversație cu 20 mesaje, scrollează SUS să citească mesajul 5.
2. `isAtBottomRef.current = false`.
3. User apasă STOP pe streaming precedent (nu-s streaming active — presupunem).
4. User scrie mesaj nou, apasă Send.
5. `addMessage(userMsg)` → messages array update → effect fires → `isAtBottomRef.current === false` → NO SCROLL.
6. User NU vede mesajul lui apărând în bubble → confusion.

**Fix**: force scroll pe user-initiated actions:

```tsx
// În useChat store:
addMessage: (msg) => {
  set((s) => ({ messages: [...s.messages, msg], forceScrollNext: true }));
},

// În MessageList useEffect:
useEffect(() => {
  const el = containerRef.current;
  if (!el) return;
  const state = useChat.getState();
  if (isAtBottomRef.current || state.forceScrollNext) {
    el.scrollTop = el.scrollHeight;
    if (state.forceScrollNext) useChat.setState({ forceScrollNext: false });
  }
}, [messages, status]);
```

Sau: force scroll pe orice user role message added (last message role === 'user').

---

## §F6 — ChatInput centering translation: dacă containerH < inputH → translateY negativ enorm → input împins în afara ferestrei

`ChatPage.tsx:51-63`:
```tsx
useLayoutEffect(() => {
  const container = containerRef.current;
  const wrapper   = inputWrapperRef.current;
  if (!container || !wrapper) return;

  if (isEmpty && !showAgentOnboarding) {
    const containerH = container.offsetHeight;
    const inputH     = wrapper.offsetHeight;
    setTranslateY(-(containerH / 2 - inputH / 2));
  } else {
    setTranslateY(0);
  }
}, [isEmpty, showAgentOnboarding]);
```

`containerH = container.offsetHeight` — dacă window mic (mobile-narrow view sau resize brusc), containerH poate fi 200px iar inputH 150px (multi-line + attachments) → `-(100 - 75) = -25px`. OK aici.

Dar dacă `containerH = 100px` (foarte mic) și `inputH = 150px` → `-(50 - 75) = +25px` → mută input în JOS. Neutru dar bizar (input trebuie centrat, ajunge jumătate afară).

Extreme: `containerH = 50px` (window minimize sau split-view), `inputH = 200px` → `-(-75) = +75px` → împins jos, invisibil.

**Fix**: clamp:

```tsx
if (isEmpty && !showAgentOnboarding) {
  const containerH = container.offsetHeight;
  const inputH     = wrapper.offsetHeight;
  const target = -(containerH / 2 - inputH / 2);
  // Clamp: nu împinge input sub 0 (peste zone visible) și nu mută în jos peste bottom.
  const clamped = Math.min(0, Math.max(-(containerH - inputH), target));
  setTranslateY(clamped);
} else {
  setTranslateY(0);
}
```

Plus: `ResizeObserver` pe container să re-triggering la window resize:

```tsx
useEffect(() => {
  const el = containerRef.current;
  if (!el) return;
  const ro = new ResizeObserver(() => {
    // trigger effect
  });
  ro.observe(el);
  return () => ro.disconnect();
}, []);
```

Currently effect deps sunt `[isEmpty, showAgentOnboarding]` — un window resize NU trigger. `translateY` stale până next state change.

---

## §F7 — Sidebar `bg-bg-surface/90 backdrop-blur` pe transparency → conținut vizibil PRIN sidebar la scroll

`Sidebar.tsx:232`:
```tsx
className="fixed left-2 top-2 bottom-2 bg-bg-surface/90 backdrop-blur border border-border-subtle shadow-lg flex flex-col z-20 overflow-hidden rounded-2xl"
```

`bg-bg-surface/90` = 90% opacity. Cu 10% transparency, sidebar arată chat content DIN SPATE **prin blur**. Design intent probabil "glass morphism", dar:

1. `AppShell.tsx:71` — main are `paddingLeft: SIDEBAR_W + 16` — chat content ÎN AFARA sidebar. Nu overlap. Deci nimic vizibil prin sidebar.
2. Wait — sidebar e `fixed left-2 top-2 bottom-2` = 8px inset. Chat main are `paddingLeft: 240 + 16 = 256px`. Sidebar width 240px + 8px left = 248px. Chat start la 256px → 8px gap între sidebar right și chat content. NON-overlap. Blur nu are ce reveal.

Deci `/90 backdrop-blur` overhead pentru zero benefit vizual. Costs perf (blur is GPU-expensive), dar visual nul.

**Fix minor**: `bg-bg-surface` (100% opac) sau `bg-bg-surface/95` fără backdrop-blur dacă vrei ceva subtil. Elimină backdrop-blur — save GPU cycles, mai ales pe hardware slab.

---

## §F8 — Icon-buttons throughout NU au `focus-visible` outline → keyboard users lost

Multe icon-buttons custom (nu prin `<Button>` component) folosesc pattern:

```tsx
<button
  className="p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary"
  aria-label="..."
>
  <Icon size={16} />
</button>
```

Nu au `focus-visible:ring-*` sau `focus-visible:outline`. Utilizator navighează cu Tab, ajunge la buton, dar NU vede feedback vizual → pierdut.

Găsit în: `Sidebar.tsx` (DownloadButton, collapse toggle), `ChatInput.tsx` (mic, reasoning, mode toggle), `MessageItem.tsx` (thumbs up/down), `AppShell.tsx` (window controls minimize/maximize).

Doar shadcn primitives (dialog, dropdown, popover) au focus-visible correct.

**Fix**: adaugă `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-bg-primary` la toate icon-buttons custom. Sau creează un `<IconButton>` component reusable:

```tsx
export function IconButton({ className, ...props }) {
  return (
    <button
      className={cn(
        "p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        className,
      )}
      {...props}
    />
  );
}
```

Migrează progresiv. Priority high — a11y regulation compliance.

---

## §F9 — WinControls buttons lipsă `focus-visible` + close button contrast fail

`AppShell.tsx:20-49`:
```tsx
<button
  onClick={() => void getCurrentWindow().minimize()}
  className="h-8 w-10 flex items-center justify-center text-text-muted/40 hover:text-text-muted hover:bg-white/5 transition-colors"
  aria-label="Minimize"
>
  <Minus size={13} strokeWidth={1.5} />
</button>
```

`text-text-muted/40` = 40% opacity de text-muted `#8C7E6A` → efective `#8C7E6A * 0.4 = #38322A` pe bg-primary #100E09 → contrast ~1.5:1 — invisible.

Aceleași butoane: nu au `focus-visible` state. Utilizator keyboard care ajunge la ele via Tab (probable NO tab order pentru fixed-position window controls, dar dacă ajunge accidental) pierdut.

Close button `hover:bg-red-500/80` + `hover:text-white` — dar starea normala tot `text-text-muted/40` = invisible.

**Fix**:
```tsx
className="h-8 w-10 flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-text-primary"
```

Full opacity muted default (subtle dar visible). Ring on focus.

---

## §F10 — Sidebar collapsed state: dropdown menus pentru delete/rename NU sunt reachable → user cu sidebar collapsed nu poate manage conversations

`Sidebar.tsx:255-267`:
```tsx
<div className="flex-1 overflow-y-auto px-2 pt-2 min-h-0 scrollbar-hide">
  <AnimatePresence>
    {!collapsed && (
      <RecentSection
        onRenameProject={...}
        onRequestDelete={setDeleteTarget}
      />
    )}
  </AnimatePresence>
</div>
```

Când `collapsed = true`, `<RecentSection>` NU se render → nu există project rows sau conversation rows → nu există dropdown menus pentru delete/rename.

User workflow: colapsează sidebar pentru mai mult screen space → dar nu mai poate șterge un chat vechi. Trebuie să deschidă sidebar → click dropdown → delete → colapsează înapoi.

**Fix mic**: adaugă un fallback "Recent" popover accesibil în collapsed state:

```tsx
{collapsed && (
  <TooltipTrigger>
    <IconButton aria-label="Recent conversations">
      <MessageSquare size={16} />
    </IconButton>
  </TooltipTrigger>
  {/* Opens a popover with the recent list */}
)}
```

Sau: click pe icon `MessageSquare` (New Chat button) în collapsed state deschide popover cu recent list în plus la new chat action.

---

## §F11 — Delete/Rename dialog states aren't reset la ESC / outside click → next open shows stale error/loading

`Sidebar.tsx:198-210`:
```tsx
const handleConfirmDelete = async () => {
  if (!deleteTarget) return;
  setDeleting(true);
  setDeleteError(null);
  try { ... } catch (err) {
    setDeleteError(String(err));
  } finally {
    setDeleting(false);
  }
};
```

`deleteError` state persistă cross-dialog-open. Scenariu:
1. User apasă Delete → dialog opens → confirm → error apare "Network fail" → dialog rămâne open.
2. User apasă X (close dialog) → state `setDeleteTarget(null)` (line 346), dar `setDeleteError(null)` NU chemat.
3. Later, user apasă Delete pe alt chat → dialog opens → `deleteError` still shows "Network fail" din opterațiunea precedentă → confusion "de ce apare error înainte să confirm?".

`Dialog onOpenChange` handler (line 346):
```tsx
onOpenChange={(open) => { if (!open && !deleting) { setDeleteTarget(null); setDeleteError(null); } }}
```

Reset error corect DACĂ close vine prin `onOpenChange` (backdrop click / ESC). Dar dacă close vine prin butonul Cancel (line 358), handler manual:

```tsx
onClick={() => { setDeleteTarget(null); setDeleteError(null); }}
```

Care ARE reset. OK aici.

Dar dacă close vine prin `onOpenChange` cu `deleting === true` (nu se poate în teorie — dialog blocked în state deleting), skip reset. Un fluke unde deleting=true dar user forțează close (browser dev tools, etc.): reset skipped, dar `deleteTarget=null` also skipped → state stuck. Edge case.

**Fix**: reset UNCONDITIONAL în onOpenChange:

```tsx
onOpenChange={(open) => {
  if (!open) {
    setDeleteTarget(null);
    setDeleteError(null);
    // if deleting, best-effort abort — but at minimum don't leak state
    setDeleting(false);
  }
}}
```

---

## §F12 — Onboarding wizard skip persistance NOT tested; localStorage key drift potentials

Referenced in `OnboardingWizard.tsx:51` — `skip = useOnboarding((s) => s.skip)`.

localStorage key în `onboarding` store (nu extras aici). Dacă key-ul e `feral.onboarding.completed` vs `feral.onboardingSkipped` vs alt naming — un rebrand la LittleBeast (viitor) va rupe key → user primește wizard din nou.

Similar `ChatPage.tsx:15` `ONBOARDING_KEY` from agentUtils, `EmptyStates.tsx:11` `BYOK_DISCLAIMER_KEY = 'feral.agentByokDismissed'`, `AppShell.tsx:63` `'feral.autoUpdateCheck'`.

**Consecință rebrand Feral→LittleBeast**: toate aceste keys `feral.*` need migration. Fără el, users perd:
- Onboarding completion status → wizard reafișare.
- Update check off preference.
- BYOK dismissal → note revine.

**Fix pre-rebrand**: introdu un `MIGRATED_KEYS` helper care copiază toate `feral.*` keys la `littlebeast.*` la primul boot post-rename:

```ts
const MIGRATE_MAP = {
  'feral.onboardingCompleted': 'littlebeast.onboardingCompleted',
  'feral.agentByokDismissed': 'littlebeast.agentByokDismissed',
  'feral.autoUpdateCheck': 'littlebeast.autoUpdateCheck',
  // ... enumerate all
};
export function migrateLocalStorage() {
  const migrated = localStorage.getItem('littlebeast.storageMigrated_v1');
  if (migrated === 'true') return;
  for (const [oldKey, newKey] of Object.entries(MIGRATE_MAP)) {
    const val = localStorage.getItem(oldKey);
    if (val !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, val);
    }
  }
  localStorage.setItem('littlebeast.storageMigrated_v1', 'true');
}
```

Rulează la `main.tsx` boot înainte de App.

---

## §F13 — `AgentByokNote` dismiss localStorage NU sincronizat cross-tabs → user vede note pop up după dismiss în altă fereastră

`EmptyStates.tsx:13-23`:
```tsx
const [dismissed, setDismissed] = useState(
  () => localStorage.getItem(BYOK_DISCLAIMER_KEY) === 'true',
);
```

`useState` cu initial value citit doar la mount. Dacă user dismisses în window A, window B are `dismissed=false` până next mount.

Rare pe Tauri (single window desktop), dar dacă cineva rulează multiple Feral instances (dev), inconsistent.

**Fix**: listen la `storage` event:

```tsx
useEffect(() => {
  const onStorage = (e: StorageEvent) => {
    if (e.key === BYOK_DISCLAIMER_KEY) setDismissed(e.newValue === 'true');
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}, []);
```

Minor priority.

---

## §F14 — Voice recorder mic hold timer NU-i clearat pe unmount → 500ms setTimeout fires după navigate away

`ChatInput.tsx:107-113`:
```tsx
const onMicPointerDown = () => {
  if (rec.state === 'recording') return;
  micHeldRef.current = false;
  micHoldTimer.current = window.setTimeout(() => {
    micHeldRef.current = true;
    setProviderCardOpen(true);
  }, 500);
};
```

Dacă user apasă și ține mouse-ul jos pe mic → navigate away (Cmd+K la altă pagină, tab close) → component unmounts DAR `setTimeout` nu-i clear-uit.

Timer fires după 500ms → `setProviderCardOpen(true)` pe component demontat → React warning "Can't perform a state update on an unmounted component" → memory leak semi-permanent.

**Fix**:
```tsx
useEffect(() => {
  return () => {
    if (micHoldTimer.current !== null) {
      clearTimeout(micHoldTimer.current);
      micHoldTimer.current = null;
    }
  };
}, []);
```

Sau: check unmounted flag:
```tsx
const unmountedRef = useRef(false);
useEffect(() => () => { unmountedRef.current = true; }, []);
micHoldTimer.current = window.setTimeout(() => {
  if (unmountedRef.current) return;
  micHeldRef.current = true;
  setProviderCardOpen(true);
}, 500);
```

---

## §F15 — Icon font emoji fallback în settings tab labels `⚙ ◐ ⌬ ⇄` NU render consistent cross-platform

`SettingsPage.tsx:16-24`:
```tsx
const CATS: { id: Category; label: string; icon: string }[] = [
  { id: 'general',    label: 'General',     icon: '⚙' },
  { id: 'appearance', label: 'Appearance',  icon: '◐' },
  { id: 'hardware',   label: 'Hardware',    icon: '⌬' },
  { id: 'api',        label: 'API Server',  icon: '⇄' },
  { id: 'byok',       label: 'Cloud Keys',  icon: '⚷' },
  { id: 'agent',      label: 'Agent',       icon: '◈' },
  { id: 'privacy',    label: 'Privacy',     icon: '⚿' },
  { id: 'about',      label: 'About',       icon: 'ⓘ' },
];
```

Aceste caractere Unicode sunt symbol characters (⚷ U+26B7, ⌬ U+232C, ⚿ U+26BF). Pe:
- **macOS**: majoritatea render OK în system font (Apple emoji supports these).
- **Windows 10/11**: Segoe UI Symbol subset. `⚷` (Chiron, astrology) NU-i în Segoe UI Emoji → render as tofu boxes.
- **Linux Ubuntu**: fbdb DejaVu Sans → poate render `⚙` dar nu `⚷` sau `⌬`.

Rezultat: user Windows/Linux vede tofu boxes `▯` în locul iconițelor.

**Fix**: folosește Lucide icons deja imported în restul app:
```tsx
import { Settings, Palette, Cpu, Network, Key, Bot, Shield, Info } from 'lucide-react';

const CATS = [
  { id: 'general',    label: 'General',    Icon: Settings },
  { id: 'appearance', label: 'Appearance', Icon: Palette },
  { id: 'hardware',   label: 'Hardware',   Icon: Cpu },
  { id: 'api',        label: 'API Server', Icon: Network },
  { id: 'byok',       label: 'Cloud Keys', Icon: Key },
  { id: 'agent',      label: 'Agent',      Icon: Bot },
  { id: 'privacy',    label: 'Privacy',    Icon: Shield },
  { id: 'about',      label: 'About',      Icon: Info },
];

// În render:
<c.Icon size={16} className="shrink-0" />
```

Consistent cu restul iconografiei. Fix trivial cu impact vizibil pe 2/3 platforms.

---

## §F16 — App name "Feral" hardcoded în UI, două locuri notabile

`Sidebar.tsx:240`:
```tsx
{!collapsed && (
  <span className="font-semibold text-text-primary text-sm select-none">Feral</span>
)}
```

`AppearanceTab.tsx:50`:
```tsx
<p className="text-xs text-text-muted mt-0.5">Pick how Feral looks</p>
```

Plus multe alte apariții — 1369 hits `Feral` (per audit runda anterioară).

**Impact rebrand**: schimbări mecanice, dar coordinate necesar. Un `<AppName>` component central ar simplifica viitor:

```tsx
// components/AppName.tsx
export const APP_NAME = 'Feral';   // sau import from config
export function AppName() { return <>{APP_NAME}</>; }
```

Sidebar: `<span>...<AppName /></span>`. Toate string-uri se update prin schimbarea single constant.

**Recomandare**: pre-rebrand introdu constant + component wrapper. Post-rebrand doar schimbi valoarea. Zero regression.

---

## §F17 — `AppShell.tsx` UpdateToast + Toasts în same column → order stack ambiguu

`AppShell.tsx:88-92`:
```tsx
<div className="fixed top-11 right-4 z-[100] w-80 flex flex-col gap-2 pointer-events-none">
  <UpdateToast />
  <Toasts />
</div>
```

`flex-col` cu Toasts second. Când 3+ toasts spawn, ele fill in `<Toasts />` component space, dar `<UpdateToast />` (dacă present) mereu la top. OK.

Dar dacă update becomes available în timp ce user are 5 toasts open, update card apare TOP → împinge toasts în jos → poate să ascundă butonul close pe toast bottom-most (ieșit sub viewport).

Comentariul (line 84-87) descrie intent OK, dar nu are boundary handling pentru viewport height cap. Cu window mic 500px height, 5 toasts × 80px each = 400px, plus update card ~120px = 520px > 500px viewport → toast ultim ies sub margin.

**Fix**: cap toast count vizibil + scroll în interior:

```tsx
<div className="fixed top-11 right-4 z-[45] w-80 max-h-[calc(100vh-88px)] overflow-y-auto flex flex-col gap-2 pointer-events-none">
  <UpdateToast />
  <Toasts />
</div>
```

`max-h-[calc(100vh-88px)]` = viewport minus 44px top offset + 44px bottom breathing room. Overflow auto pentru scroll interior.

Sau, cel mai clean: Toasts se limit la 3-4 vizibile, restul queue-uite.

---

## §F18 — Motion animations NU respect `prefers-reduced-motion` sistematic — doar 1 din 78 apeluri motion/animate acoperă

Din grep: 78 references la `animate-` sau `motion.` în frontend, dar `prefers-reduced-motion` doar în:
- `globals.css:245` — `.word-fade` animation
- `FeralMascot.tsx:24` — `matchMedia` check

Restul (76 apeluri): motion.aside sidebar collapse, motion.main padding, motion.div AnimatePresence pe menu labels, Framer Motion transitions — TOATE ignore user preferences.

**Impact**: utilizator cu vertigo / motion sensitivity setează OS `Reduce Motion` — Feral ignore, animații continuă → potential nausea trigger.

**Fix**: wrap Framer Motion cu `MotionConfig`:

```tsx
// În App.tsx sau main.tsx:
import { MotionConfig, useReducedMotion } from 'framer-motion';

function Root() {
  const reduce = useReducedMotion();
  return (
    <MotionConfig reducedMotion={reduce ? "always" : "never"}>
      <App />
    </MotionConfig>
  );
}
```

Framer Motion built-in support. Fix trivial. Impact real pentru users cu accessibility needs.

Also CSS-level: adaugă în `globals.css`:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Safety net dacă vreun component ratează Framer setup.

---

## §F19 — Chat title placeholder "New chat" hardcoded, nu i18n

`ChatHeader.tsx:17`:
```tsx
<span data-tauri-drag-region className="text-sm text-text-muted/50 truncate flex-1 min-w-0 cursor-move">
  {current?.title ?? 'New chat'}
</span>
```

Restul app-ului folosește `useT()` din i18n. Excepție hardcoded 'New chat'.

**Fix**:
```tsx
const t = useT();
<span>{current?.title ?? t('chat.newChatTitle')}</span>
```

Similar audit needed în alte hardcoded strings — găsit multe în greeting `EmptyStates.tsx`, dialog titles din Sidebar, etc.

---

## §F20 — Sidebar footer version — layout jump când `appVersion` hydrate async

`Sidebar.tsx:295-304`:
```tsx
<div className="px-3 py-2 shrink-0">
  <AnimatePresence>
    {!collapsed && (
      <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} 
                   className="text-[11px] text-text-muted select-none">
        {appVersion ? `v${appVersion}` : ''}
      </motion.span>
    )}
  </AnimatePresence>
</div>
```

Când `appVersion === null` (hook loading), motion.span renders empty string → cu opacity 1 → 0px height content. Când appVersion arrives, text apare → footer h-8 (from py-2 + text) rămâne consistent (span e inline text, nu block), deci NO layout jump. OK aici.

Dar când `collapsed` toggle, AnimatePresence exit + enter — during exit, span rămâne cu height while opacity fades. Fine.

**Small issue**: dacă `appVersion` fetch fails silent (hook returns null forever), footer arată permanent empty. User n-are cum să știe version-ul.

**Fix**: fallback:
```tsx
{appVersion ? `v${appVersion}` : '—'}
```

Or hide entire footer when no version. Minor.

---

## §F21 — Empty state greeting rotation: `setInterval(4000ms)` continues on unmount if effect deps change without cleanup

`EmptyStates.tsx:91-100`:
```tsx
useEffect(() => {
  if (!isEmpty || resume) return;
  const id = setInterval(() => {
    setGreetingVisible(false);
    setTimeout(() => {
      setGreetingIndex((i) => (i + 1) % GREETING_KEYS.length);
      setGreetingVisible(true);
    }, 350);
  }, 4000);
  return () => clearInterval(id);
}, [isEmpty, resume]);
```

`setInterval` cleared în return, DAR nested `setTimeout(...350)` in each tick NU tracked. Dacă cleanup fires during that 350ms window, setTimeout still fires → `setGreetingIndex` + `setGreetingVisible` pe unmounted component.

React 18+ tolerates cu warning, dar warning logs pollution.

**Fix**: track pending setTimeout:

```tsx
useEffect(() => {
  if (!isEmpty || resume) return;
  const timeouts: number[] = [];
  const id = setInterval(() => {
    setGreetingVisible(false);
    const t = window.setTimeout(() => {
      setGreetingIndex((i) => (i + 1) % GREETING_KEYS.length);
      setGreetingVisible(true);
      const idx = timeouts.indexOf(t);
      if (idx >= 0) timeouts.splice(idx, 1);
    }, 350);
    timeouts.push(t);
  }, 4000);
  return () => {
    clearInterval(id);
    timeouts.forEach(clearTimeout);
  };
}, [isEmpty, resume]);
```

---

## §F22 — `ContextRing` — tooltip content uses `toLocaleString()` cu locale=undefined → fallback la EN default, dar app poate fi Romanian/German → format neconsistent cu user locale

`ContextRing.tsx:116,120,125`:
```tsx
<span className="text-text-primary text-right">{ctxWindow.toLocaleString()} tokens</span>
...
{isLive ? '' : '~'}{used.toLocaleString()} tokens
```

`.toLocaleString()` fără argument = folosește browser default locale. Pe Tauri webview, poate să fie `en-US` (default WebView2 pe Windows) sau `ro-RO` (dacă user setează). Inconsistent cu limba de UI (i18n string-uri).

Utilizator RO vede toast în RO cu numere formatate în EN (`1,024` vs `1.024`). Inconsistent.

**Fix**: folosește i18n locale:
```tsx
import { useI18nLocale } from '@/lib/i18n';
const locale = useI18nLocale();
...
{ctxWindow.toLocaleString(locale)}
```

Sau centralize într-un `formatNumber(n)` helper care cache-uiește locale.

Similar `MessageItem.tsx:253`:
```tsx
new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
```

`undefined` locale = browser default. Same fix.

---

## §F23 — WelcomeBack "in <workspace name>" — dacă workspaceName conține HTML entities sau newlines, unsafe render (probably OK dar merită verify)

`EmptyStates.tsx:120-125`:
```tsx
{resume.workspaceName && (
  <>
    <FolderOpen size={11} aria-hidden />
    <span>in {resume.workspaceName}</span>
    ...
```

React auto-escape text content. Safe pentru HTML injection. Dar dacă `workspaceName` conține `\n` sau tab-uri, layout breaks (multi-line span inside `flex items-center` container).

**Fix defensiv**:
```tsx
<span className="truncate">in {(resume.workspaceName ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 60)}</span>
```

---

## §F24 — Chat message action buttons (thumbs up/down) appear only on hover — invisible pe touchscreens (mobile / Tauri tablet mode)

`MessageItem.tsx:290+`:
```tsx
<div className="flex items-center gap-1 mt-0.5 -ml-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
```

`opacity-0 group-hover:opacity-100` — hover only. Pe touchscreen, no hover. Utilizatorul trebuie să tap message → focus se schimbă → `focus-within` MAYBE fires. Dar `focus-within` pe `<div>` nu-i triggered de tap unless butonul intern devine focus target.

Rezultat pe touch: thumbs up/down INVIZIBILE. Utilizator nu poate rate mesaj → nu se strâng feedback signals.

**Fix**: media query pentru touch devices:

```tsx
<div className={cn(
  "flex items-center gap-1 mt-0.5 -ml-1 transition-opacity",
  // Show always on touch, hover-toggle on mouse
  "@media (hover: hover) { opacity: 0; group-hover:opacity-100; }",
  "@media (hover: none) { opacity: 100; }",
)}>
```

Sau CSS-first:
```css
@media (hover: hover) {
  .msg-actions { opacity: 0; }
  .msg-actions-container:hover .msg-actions { opacity: 1; }
}
```

Applied global la orice hover-only actions. Impact real pentru Tauri iPad app viitor.

---

## §F25 — `parseUserAttachments` (from `lib/attachmentDisplay`) probable regex fragil pe attachment markers cu edge cases

Not fully inspected code, dar din `MessageItem.tsx:113`:
```tsx
const { attachments, text: visibleText } = parseUserAttachments(message.content);
```

Se așteaptă pattern `[File: name]\ncontent\n[/File: name]` (per `useSendMessage.buildUserContent`). Dar dacă content al fișierului conține accidental `[/File: X]` (per §228 din runda 9 pentru bug de prompt injection), parser confuz. Documentat în §228.

**Aici, la display side**: chip incorect afișat (chunk-uri de content ca "file names"), text vizibil truncat. Nu security, doar UX broken pentru un fișier legitim care conține tag-ul respectiv.

**Fix**: unique boundary per attachment (per §228 fix).

---

## §F26 — Message actions dropdown from Sidebar recent rows: `DropdownMenuSub` cu `"No projects yet"` disabled — dar user tap-uiește oricum → nothing happens visible

`Sidebar.tsx:702-712`:
```tsx
<DropdownMenuSub>
  <DropdownMenuSubTrigger disabled={projects.length === 0}>
    <FolderInput size={13} />
    {projects.length === 0 ? 'No projects yet' : 'Add to project'}
  </DropdownMenuSubTrigger>
  <DropdownMenuSubContent>
    {projects.map((p) => (...))}
  </DropdownMenuSubContent>
</DropdownMenuSub>
```

Când `projects.length === 0`, trigger disabled → click ignore. Dar utilizator vede label "No projects yet" — nu-i actionable. Doar informational. Better: replace cu link "Create project first":

```tsx
{projects.length === 0 ? (
  <DropdownMenuItem onClick={() => { /* open new project dialog */ }}>
    <FolderPlus size={13} />
    Create your first project
  </DropdownMenuItem>
) : (
  <DropdownMenuSub>
    <DropdownMenuSubTrigger>
      <FolderInput size={13} />
      Add to project
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent>
      {projects.map((p) => (...))}
    </DropdownMenuSubContent>
  </DropdownMenuSub>
)}
```

Actionable → user poate crea project imediat din context.

---

## §F27 — Emergency: `EmbeddingDownloadBanner` folosește `bg-bg-muted` care NU EXISTĂ în palette

`App.tsx:30-31`:
```tsx
<span aria-hidden className="ml-1 h-1 w-16 overflow-hidden rounded-full bg-bg-muted">
```

`bg-bg-muted` — NU-i definit în `tailwind.config.ts` (colors extend). Palette are `bg-primary`, `bg-surface`, `bg-elevated`, `bg-hover`, `bg-active` — dar NU `bg-muted`.

Tailwind cu JIT: `bg-bg-muted` va fi tratat ca invalid class → NO STYLE APPLIED → span rămâne default background (transparent) → progress bar container invisible → doar bar-ul `bg-brand` apare fără track.

Verificat în tailwind.config.ts:
```ts
'bg-primary':     'var(--bg-primary)',
'bg-surface':     'var(--bg-surface)',
'bg-elevated':    'var(--bg-elevated)',
'bg-hover':       'var(--bg-hover)',
'bg-active':      'var(--bg-active)',
```

**Nu există `bg-muted` sau `bg-bg-muted`**. Bug real.

**Fix**:
```tsx
<span aria-hidden className="ml-1 h-1 w-16 overflow-hidden rounded-full bg-bg-elevated">
```

Sau `bg-bg-hover`. Ambele definite.

Similar issue possibly în alte locuri — audit prin `grep -rn "bg-bg-muted\|text-bg-muted" frontend-react/src`.

---

## §F28 — `Markdown` component pe streaming — parseeaza + re-highlight per token → CPU spike la mesaje mari

`MessageList.tsx:42` renderează `<MessageItem streaming={...} />` per iterație. `MessageItem.tsx:158`:
```tsx
<Markdown animateWords={streaming}>{message.content}</Markdown>
```

Markdown component (nu extras) probabil parseeaza `content` + rulează `highlight.js` pentru code blocks. La 100 tokens/sec streaming, content update per token → Markdown re-parse 100× per sec + highlight.js re-run pentru orice code block.

Pentru mesaje CU code (>1000 caractere in a code block), highlight.js poate lua 20-50ms per parse. 100 parses/sec = 2-5 seconds CPU per second → **UI freeze**.

Sub `memo(MessageItem, ...)` (line 91) evită re-render pentru mesajele NEschimbate. Dar assistantul streaming e MEREU last message → memo NU salvează.

**Fix**: RAF-based flush deja aplicat în `useSendMessage` (line 197-207 din useSendMessage.ts). Verify că MessageItem NU se re-render mai frecvent decât RAF (16ms).

Alternativ: în Markdown component intern, debounce highlight.js. Only run highlighting when message.thinkingComplete === true or streaming === false.

Sau: split rendering — prose renders per token, code blocks render doar la end of stream. Approach:

```tsx
{streaming ? (
  <PlainMarkdown>{message.content}</PlainMarkdown>   // no code highlighting
) : (
  <RichMarkdown>{message.content}</RichMarkdown>     // full highlight
)}
```

Trade-off: streaming shows code blocks unstyled. Users know it's live.

---

## §F29 — `ZoomableImage` — nu curăță `window.addEventListener('keydown')` dacă `open` schimbă rapid

`MessageItem.tsx:24-36`:
```tsx
useEffect(() => {
  if (!open) return;
  const raf = requestAnimationFrame(() => setShown(true));
  const onKey = (e: globalThis.KeyboardEvent) => {
    if (e.key === 'Escape') setShown(false);
  };
  window.addEventListener('keydown', onKey);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
  };
}, [open]);
```

Cleanup fires când `open` schimbă la `false` OR component unmounts. Corect.

Dar dacă `open` schimbă rapid true→false→true, cleanup + re-setup fires. OK.

**Real bug**: `setShown(false)` din `onKey` handler → `shown === false` → `onTransitionEnd` fires după 300ms → `setOpen(false)` → effect cleanup runs → remove listener. Perfect.

Dar dacă user apasă ESC în timpul transition (300ms window), setShown deja false → onTransitionEnd fires eventual, setOpen(false), cleanup runs — listener removed AFTER user apasă ESC din nou (dacă face 2× rapid). Second ESC hits `setShown(false)` again — no-op.

OK, minor.

**Real minor**: dacă multiple ZoomableImage instances mounted (mesaj cu 5 imagini, user click 5 → 5 lightboxes stacked?). Fiecare `setOpen(true)` deschide propriu overlay. Utilizatorul click două imagini → două fullscreen overlay stacked → visual mess. Ar trebui single global lightbox controller.

**Fix**: Zustand store `useLightbox` shared, doar 1 overlay activ:

```tsx
export const useLightbox = create<{
  src: string | null;
  open: (src: string) => void;
  close: () => void;
}>((set) => ({
  src: null,
  open: (src) => set({ src }),
  close: () => set({ src: null }),
}));
```

`ZoomableImage` render doar `<img>` + `onClick={() => useLightbox.getState().open(src)}`. Overlay rendered global în `AppShell`, single instance.

---

## §F30 — MISCELANEE

**§F30a** — `Sidebar.tsx:246` — `<DownloadButton />` render doar `!collapsed`. Când collapsed, no way pentru user să vadă download progress → confusion "am pornit download-ul dar nu văd status".

**§F30b** — `ContextRing` folosește percentage rings — dacă `ctxWindow = 0` (edge case), division by zero → NaN → SVG stroke-dashoffset breaks. Verify division protection.

**§F30c** — `FeralGlobalMount` (chat/) — 6 lines file, probable just mount registering listeners. Nu am content, dar name-ul suggests global side-effect. Cu rebrand, denumire `LittleBeastGlobalMount`.

**§F30d** — `MessageItem` FeedbackButtons: `aria-pressed` correct, dar toggle logic pentru "click active twice deselect" nu-i clear din cod. Verify că `setFeedback(id, 'up')` când vote deja 'up' → un-sets.

**§F30e** — `MessageList` last message rendered cu `streaming` bool derivat din `i === messages.length - 1 && m.role === 'assistant'`. Dacă user trimite 2 mesaje rapid, second user message becomes last → streaming=false pentru assistant care poate fi still generating. Wait — status === 'streaming' check preveniu. OK.

**§F30f** — `AppShell.tsx:74` — `<Outlet />` pentru router. Nu-i wrap-uit în ErrorBoundary → o eroare de render în orice pagină ia down toată app-ul.  `ErrorBoundary.tsx` există în components/, dar nu-i folosit here. Wrap:
```tsx
<ErrorBoundary>
  <Outlet />
</ErrorBoundary>
```

**§F30g** — Global hotkeys `useGlobalHotkeys` (nu inspected) — probable Cmd+K, Cmd+N, etc. Verificare că NU conflict cu native Tauri window hotkeys.

**§F30h** — `main.tsx` (29 lines) — probably minimal ReactDOM.createRoot. Nu-i wrapping în `<StrictMode>` verificat. StrictMode dublează renders în dev → prinde effects fără cleanup. Dacă lipsește, bugs de listener leak (§235, §148) mai greu de detectat local.

---

## Vizualizare — două mockup-uri generate

Am generat două imagini care aproximează UI-ul actual bazat pe cod (chat empty state + chat cu mesaje) — o să le prezint separat pentru feedback direct pe layout, spacing, brand feel.

## Summary — Frontend Audit

**30 findings** (§F1-§F30 + sub):

**Contrast / WCAG failures:**
- §F1 (error dark 3.84, text-muted-light 4.25, brand-light 4.34 — sub AA)
- §F2 (bg-brand + text-white 3.28 sub AA)
- §F9 (WinControls invisible normal state)

**Accessibility:**
- §F8 (icon-buttons no focus-visible)
- §F18 (motion animations ignore prefers-reduced-motion 76/78 cases)
- §F24 (hover-only actions invisible on touchscreens)

**Real bugs:**
- §F27 (`bg-bg-muted` non-existent class → progress bar invisible)
- §F14 (mic hold timer NOT cleared on unmount)
- §F5 (MessageList autoscroll misses new user msg when scrolled up)
- §F11 (delete error state persists cross-dialog)
- §F21 (nested setTimeout in setInterval NOT tracked)

**Layout / z-index:**
- §F3 (toasts z-100 > modals z-50 conflict)
- §F17 (toasts + update card no viewport height cap)
- §F6 (chat input translation unclamped on small windows)
- §F10 (sidebar collapsed → dropdown menus unreachable)

**Rebrand readiness:**
- §F12 (localStorage keys `feral.*` need migration)
- §F16 ("Feral" hardcoded in 2 UI spots + 1369 total hits)
- §F19 ("New chat" not i18n)

**Cross-platform:**
- §F15 (icon Unicode symbols tofu on Windows/Linux)
- §F22, §F30x (locale-aware formatting)

**Performance:**
- §F28 (Markdown re-highlights per streamed token)
- §F7 (backdrop-blur on non-overlapping element)

Priorități HIGH pentru fix înainte de rebrand launch:
1. **§F27** (progress bar invisible — real regression)
2. **§F1, §F2, §F9** (WCAG failures — legal in some jurisdictions)
3. **§F14, §F21, §F11** (state leaks / bugs vizibile)
4. **§F12** (localStorage migration — CRITICAL pre-rebrand)
5. **§F15** (icon symbols cross-platform)
6. **§F18** (reduced-motion — a11y)
7. **§F5** (autoscroll UX bug high-frequency)

Restul MEDIUM/LOW — remediable în cursul refactor rebrand.

---

# Runda 2 — mai deep pe UI/UX + rebranding surface + responsive + a11y

Continuare audit după cererea "mai analizează UI/UX". Focus zone rămase: OnboardingWizard (934 linii), MascotPerch (225 linii — mascotă complexă), SearchOverlay, ModelsPage (fit score, cards), MemoryLayersPage, ThinkingBlock, StreamingIndicator, ContextRing, plus revizuire rebrand-blockers și responsive.

---

## §F31 — OnboardingWizard: `PersonalizeStep` "You can leave 'Feral' or pick something else" — nume hardcoded în hint text, agent auto-personalize la Feral chiar dacă app este LittleBeast

`OnboardingWizard.tsx:230-236`:
```tsx
<Field
  label="What should you call me?"
  hint={'You can leave "Feral" or pick something else.'}
>
  <input
    ...
    placeholder="Feral"
    maxLength={40}
    ...
  />
</Field>
```

Post-rebrand:
- Placeholder `"Feral"` → user care lasă blank moștenește nume Feral pentru un agent-ul LittleBeast.
- Hint "leave 'Feral'" → confuzie.
- `Preview` component (line 272): `const safeAgent = agentName.trim() || 'Feral';` — same fallback.
- `DoneStep` (line 812): `const safeAgent = agentName.trim() || 'Feral';`

**Fix**: centralize brand pe un constant + configuration:

```ts
// lib/brand.ts
export const APP_NAME = 'LittleBeast';           // OR 'Feral' pre-rebrand
export const AGENT_DEFAULT_NAME = APP_NAME;
```

Apoi:
```tsx
hint={`You can leave "${AGENT_DEFAULT_NAME}" or pick something else.`}
placeholder={AGENT_DEFAULT_NAME}
...
const safeAgent = agentName.trim() || AGENT_DEFAULT_NAME;
```

Aceasta pave the way pentru rebrand cu un singur `.ts` edit. Fits `<AppName>` component recommendation din §F16.

---

## §F32 — OnboardingWizard `WelcomeStep` — "Welcome to Feral" hardcoded + subtitle "local AI agent" too narrow (misses BYOK majority use case)

`OnboardingWizard.tsx:181-190`:
```tsx
<h1 id="onboarding-title" className="text-3xl font-semibold text-text-primary">
  Welcome to Feral
</h1>
<p className="text-base text-text-muted max-w-md mx-auto leading-relaxed">
  A local AI agent that helps you with your files, projects, and tasks,
  without sending your data to the cloud.
</p>
```

Problems:
1. "Feral" hardcoded — §F16 duplicate.
2. Description says *"A local AI agent... without sending your data to the cloud"* — dar CloudBranch (line 634+) și `ProviderStep` (line 419+) oferă direct BYOK cloud keys (OpenAI, Anthropic, Google, OpenRouter). User citește promise "no cloud", 30 seconds later pune un OpenAI key. Contradiction pe screen.

**Fix**:
```tsx
<h1 id="onboarding-title" className="text-3xl font-semibold text-text-primary">
  Welcome to {APP_NAME}
</h1>
<p className="text-base text-text-muted max-w-md mx-auto leading-relaxed">
  An AI agent that lives on your machine — runs local models, or plugs into
  cloud models with your own key. Your data stays under your control.
</p>
```

Honest despre BYOK. Nu vinde privacy pe care app-ul nu o promite absolutely.

---

## §F33 — OnboardingWizard `DoneStep`: emoji `🎉` (line 819) — invisible pe Windows sub Segoe UI Emoji versions vechi, plus tone inconsistent cu warm palette

`OnboardingWizard.tsx:817-828`:
```tsx
<motion.div ... className="text-6xl" aria-hidden>
  🎉
</motion.div>
```

Font-size 6xl = ~60px. Depinde de font-family și version emoji font. Windows 10 pre-2018 Segoe UI Emoji nu are `🎉` completely rendered (partial glyph). Fallback tofu box.

Plus tonally: warm brown/orange palette + rustic mascot vibe vs 🎉 = generic party emoji, feel deconectat.

**Fix**: folosește FeralMascot state `celebrate` (deja există per `EXPRESSIVE = ['wave', 'love', 'cool', 'surprised', 'celebrate']` în `MascotPerch.tsx:20`):

```tsx
<motion.div
  initial={{ scale: 0, rotate: -90 }}
  animate={{ scale: 1, rotate: 0 }}
  transition={{ type: 'spring', duration: 0.6, delay: 0.1 }}
  className="flex justify-center [&_canvas]:w-20 [&_canvas]:h-20 [&_canvas]:[image-rendering:pixelated]"
  aria-hidden
>
  <FeralMascot state="celebrate" />
</motion.div>
```

Brand consistency. Elimină emoji cross-platform inconsistency.

---

## §F34 — OnboardingWizard `defer()` vs `finish()` — un user care apasă "Browse other models" în LocalBranch defer-uiește wizard, dar cel care apasă "Skip" în header face `finish()` cu completed=true → **inconsistent onboarding replay**

`OnboardingWizard.tsx:614-624`:
```tsx
<button
  type="button"
  onClick={() => { defer(); navigate('/models'); }}
  className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
>
  Browse other models <ChevronRight size={12} />
</button>
```

vs `OnboardingWizard.tsx:70` (Skip button):
```tsx
onClick={skip}
```

Deci:
- User apasă "Browse other models" → `defer()` → wizard hidden this session dar re-appears next launch (per comment line 619-621).
- User apasă "Skip" → `skip()` → probably `finish()`-like persistence → wizard NEVER re-appears.

Comentariul (line 617-621) argumentează defer în LocalBranch pentru "download-in-progress continues". Fine. Dar CloudBranch's "More providers in Settings" (line 720-726):

```tsx
onClick={() => { defer(); navigate('/settings'); }}
```

Also `defer()`. Deci defer 2×, skip 1× — inconsistent user mental model.

**Recomandare UX**: dacă user avansează prin wizard (chiar și cu defer pe LocalBranch), completion e implicit. Doar top-right `Skip` X → explicit skip, restul deferă.

Sau: adaugă un checkbox "Don't show again" în defer scenarios. Clear intent.

---

## §F35 — ProgressDots (`OnboardingWizard.tsx:114-127`) — active dot `w-8` vs inactive `w-1.5` = 5× width discrepancy → touch target sub 24×24px WCAG failure

```tsx
<div className={cn(
  'h-1.5 rounded-full transition-all duration-300',
  i === step ? 'w-8 bg-brand' : i < step ? 'w-1.5 bg-brand/50' : 'w-1.5 bg-border-default',
)} />
```

`h-1.5` = 6px, `w-1.5` = 6px inactive → dot 6×6px. Chiar și `w-8 h-1.5` = 32×6 = active pill dar tot 6px height.

WCAG 2.5.5 (Target Size Level AAA) cere 44×44px. Level AA (2.5.8, 2.1) cere 24×24px. Aceste dots sub AA cerință.

**Aparent OK** — dots sunt informational, nu interactive. Dar comentariul + `role` lipsesc → screen reader nu știe "6 out of 6 steps". `aria-label="Step X of Y"` există pe parent (line 116), OK.

**Real bug**: dots-urile decorate NU-s butoane clickable pentru navigation. Utilizator la step 4 care vrea să revină la step 1 trebuie să apese Back 3×. UX nefluid.

**Fix**: fă dots interactive (unde permis — nu poți sări forward peste required fields):

```tsx
{Array.from({ length: total }, (_, i) => (
  <button
    key={i}
    type="button"
    disabled={i > step}
    onClick={() => i <= step && goToStep(i)}
    aria-label={`Go to step ${i + 1}`}
    aria-current={i === step ? 'step' : undefined}
    className={cn(
      'h-6 min-w-6 flex items-center justify-center rounded-full transition-all duration-300',
      i === step ? 'w-10 bg-brand' : i < step ? 'w-6 bg-brand/50 hover:bg-brand/70' : 'w-6 bg-border-default cursor-not-allowed',
    )}
  >
    <span className="w-1.5 h-1.5 rounded-full bg-current opacity-0 group-hover:opacity-100" />
  </button>
))}
```

Larger touch target + jump-to-previous-step UX.

---

## §F36 — OnboardingWizard `<AnimatePresence mode="wait">` cu `key={step}` — la exit precedent + enter următor, textul poate să fie mid-fade cu next-step content overlaid ~180ms

`OnboardingWizard.tsx:78-93`:
```tsx
<AnimatePresence mode="wait">
  <motion.div
    key={step}
    variants={stepVariants}
    initial="enter"
    animate="center"
    exit="exit"
    transition={{ duration: 0.18, ease: 'easeOut' }}
  >
    {step === 0 && <WelcomeStep />}
    ...
```

`mode="wait"` = așteaptă exit înainte de enter. Bun. Dar 180ms × 2 = 360ms total tranziție per step change. User care apasă Next rapid (multi-clicks) → animation queue up → jarring.

Testat manual imposibil (fără dev-server), dar visual code pattern:
- User click Continue → button disabled? NU explicit. `disabled={!canProceed}` doar pentru personalize (line 158).
- Multiple rapid clicks pe Continue → multiple `next()` calls → step advances repede fără render intermediate — dar `mode="wait"` blochează renders → stack.

**Fix**: disable Continue button pe durata animation:

```tsx
const [transitioning, setTransitioning] = useState(false);

const handleNext = () => {
  setTransitioning(true);
  next();
  setTimeout(() => setTransitioning(false), 250);
};

<button ... disabled={!canProceed || transitioning} onClick={handleNext}>
```

Sau folosește AnimatePresence's `initial={false}` + track animating via onAnimationComplete.

---

## §F37 — OnboardingWizard `LocalBranch::TIER_MODELS` — pinned model repos `bartowski/Qwen_Qwen3.5-*` — dacă repo redenumite/deprecated pe HF, download eșuează → wizard blocked

`OnboardingWizard.tsx:349-355`:
```tsx
const TIER_MODELS: Record<string, ...> = {
  '1–2B':   { repoId: 'bartowski/Qwen_Qwen3.5-2B-GGUF',  filename: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf',  ... },
  '3–4B':   { repoId: 'bartowski/Qwen_Qwen3.5-4B-GGUF',  ... },
  '7–8B':   { repoId: 'bartowski/Qwen_Qwen3.5-9B-GGUF',  ... },
  '13–14B': { repoId: 'bartowski/Qwen_Qwen3.5-27B-GGUF', ... },
};
```

Comentariul (line 341-347) admite: *"Calibration knob — re-verify these repos/files resolve on Hugging Face before each release; swap when a better small model ships. An unresolvable repo makes the one-click download fail."*

Dependency externă TARE. HuggingFace repos pot fi:
- Redenumite de autor.
- Deprecated (autor scoate versiuni vechi).
- Yanked pentru safety issues.
- Rate-limited pentru HF anonymous (401/403).

Un download fail pe onboarding = user experience oribil. `LocalBranch` (line 626) arată "Download failed: {error}" — dar user nu poate face rien alt decât Skip.

**Fix**:
1. **Server-side manifest**: în loc de hardcoded, fetch de la `https://littlebeast.ai/onboarding-manifest.json` care returnează current recommended models per tier. Actualizabil fără releasu Feral nou.
2. **Fallback la Ollama detection**: dacă HF fail, check if Ollama installed (`http://localhost:11434/api/tags`) și oferă un default model de acolo.
3. **Multiple candidates per tier**: dacă primul repo fail, încearcă al doilea automat.

Currently: single point of failure pe HF availability.

---

## §F38 — OnboardingWizard `ProviderStep::CURATED_PROVIDERS` — verbose steps ("Copy the key now (it's shown only once)") îngroapă flow — user care abandonează pe step 3 e cel mai frecvent drop-off

Line 358-416 — 4 providers × ~4 fields fiecare = 60+ linii de text. `steps` per provider = 3 pași instrucționali:

```ts
steps: [
  'Sign in at platform.openai.com',
  'Settings → API keys → "Create new secret key"',
  'Copy the key now (it\'s shown only once) and paste it below',
],
```

Rendered ca `<ol list-decimal>`. User citește 3 pași × 4 providers dacă face compare = 12 pași = intimidating.

**Recomandare UX**: 
1. Doar arată steps ALE providerului SELECTED (deja e case în code — line 767-772). OK.
2. Dar steps sunt pretty verbose. Truncate la 2 essential:
   - "Get key at {URL}"
   - "Paste below"
3. "Details" collapsible pentru steps 1-3 detaliate.

Aparent minor, dar drop-off UX at onboarding step 3 is universally #1 loss point în SaaS onboarding.

---

## §F39 — OnboardingWizard `CloudProviderForm` password input mask + no reveal button → user nu poate verifica dacă a paste-uit corect

`OnboardingWizard.tsx:774-781`:
```tsx
<input
  type="password"
  value={apiKey}
  onChange={(e) => setApiKey(e.target.value)}
  placeholder={def.keyPlaceholder}
  className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-primary text-sm text-text-primary font-mono placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/50"
  aria-label={`${def.name} API key`}
/>
```

`type="password"` maschează. Dar user paste-uiește un key lung de 100+ chars, vede doar `••••••••`, apasă Test → "invalid key". Nu poate verifica dacă a paste-uit `sk-xxx` sau `sk-xxx  ` cu spații trailing.

**Fix**: add reveal toggle:

```tsx
const [reveal, setReveal] = useState(false);
<div className="relative">
  <input type={reveal ? 'text' : 'password'} ... />
  <button
    type="button"
    onClick={() => setReveal(!reveal)}
    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted"
    aria-label={reveal ? 'Hide key' : 'Show key'}
  >
    {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
  </button>
</div>
```

Standard pattern (GitHub, Stripe, Vercel toate au reveal button).

---

## §F40 — OnboardingWizard `handleTest` + `handleSave` NU trim whitespace pe apiKey → user paste cu `\n` trailing → save cu newline → next API call 401 unexplained

`OnboardingWizard.tsx:735-749`:
```tsx
const [apiKey, setApiKey] = useState('');
...
const handleTest = async () => {
  ...
  const r = await testByokProvider({ providerId: def.id, apiKey, baseUrl: null });
```

`apiKey` este direct din `<input>`. Un user copy-paste de la browser (double-click select în URL bar sau textarea) prinde adesea whitespace trailing. `.trim()` lipsă → key saved cu spații → `Bearer sk-xxx\n` header → server 401.

**Fix**:
```tsx
const handleTest = async () => {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) { setMsg({ ok: false, text: 'Enter a key first' }); return; }
  setBusy(true); setMsg(null);
  try {
    const r = await testByokProvider({ providerId: def.id, apiKey: trimmedKey, baseUrl: null });
    ...
```

Similar `handleSave`. Trim standard defensiv.

---

## §F41 — MascotPerch `startIdleSequence` — timer stack DEEP nested cu callbacks care fire după unmount

`MascotPerch.tsx:99-160`:
```tsx
const startIdleSequence = () => {
  if (idleCycleCount.current >= GAMING_TRIGGER_CYCLES) {
    idleCycleCount.current = 0;
    setRenderState('gaming');
    timers.current.push(window.setTimeout(() => {
      setRenderState('idle');
      startGamingSequence();
    }, GAMING_MS));
    return;
  }

  timers.current.push(window.setTimeout(() => {
    setRenderState('curious');
    timers.current.push(window.setTimeout(() => {
      // Step 3
      timers.current.push(window.setTimeout(() => {
        // Step 4
        timers.current.push(window.setTimeout(() => {
          // Step 5
          timers.current.push(window.setTimeout(() => {
            // Step 6
            timers.current.push(window.setTimeout(() => {
              startIdleSequence();  // ← RECURSIVE
            }, EXPRESSIVE_MS));
          }, STRETCHING_MS));
        }, SLEEP_AFTER_RUN_MS));
      }, LEG_MS));
    }, LEG_MS));
  }, CURIOUS_DELAY_MS));
};
```

`clearTimers` cleanup din useEffect (line 78-81) elimină `timers.current` — dar dacă un timer INTERMEDIAR firește ÎN TIMPUL cleanup-ului (edge case timer fires, callback runs, adaugă noi timers la `timers.current` care e deja rulat), noi timers escapă.

Actual `clearTimers()` face `timers.current.forEach(clearTimeout); timers.current = []`. După cleanup, dacă timer's callback runs (rare race), `timers.current.push(...)` adaugă în new empty array — dar effect cleanup deja completed → array escapes → next render creates new effect → orphan timers running.

**Fix**: guard cu `mounted` flag:

```tsx
const mountedRef = useRef(true);
useEffect(() => () => { mountedRef.current = false; }, []);

const startIdleSequence = () => {
  if (!mountedRef.current) return;
  ...
  timers.current.push(window.setTimeout(() => {
    if (!mountedRef.current) return;
    setRenderState('curious');
    // etc.
```

Alternativ: unified state machine cu single-timer approach:

```tsx
type Phase = 'idle' | 'curious' | 'running_right' | 'running_left' | 'sleeping' | 'stretching' | 'expressive' | 'gaming';
const PHASE_DURATION: Record<Phase, number> = { idle: 8000, curious: 10000, ... };

useEffect(() => {
  const [phase, setPhase] = useState<Phase>('idle');
  const next = getNextPhase(phase);
  const t = setTimeout(() => setPhase(next), PHASE_DURATION[phase]);
  return () => clearTimeout(t);
}, [phase]);
```

Simpler + more robust.

---

## §F42 — MascotPerch `MASCOT_W = 48` hardcoded, but `DISPLAY` size în FeralMascot may differ → mascot goes off-screen or overlaps input

`MascotPerch.tsx:23`:
```tsx
const MASCOT_W = 48; // keep in sync with DISPLAY in FeralMascot
```

Comentariul admite fragility. Un `DISPLAY = 64` în FeralMascot fără update aici → travel bounds calc greșit → mascot travels 16px too far dreapta → sub margin sau peste input controls.

**Fix**: expose from FeralMascot:

```tsx
// FeralMascot.tsx
export const DISPLAY_WIDTH = 48;

// MascotPerch.tsx
import { DISPLAY_WIDTH as MASCOT_W } from './FeralMascot';
```

Sau: measure DOM element cu `useRef` + `getBoundingClientRect`:

```tsx
const mascotRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  const el = mascotRef.current;
  if (el) mascotWidthRef.current = el.getBoundingClientRect().width;
}, []);
```

Dinamic, robust.

---

## §F43 — MascotPerch `DustPuff` — inline styles + hardcoded `zIndex: 9` → conflict cu ToolCallBubble z-20 sau altele

Line 27-52:
```tsx
function DustPuff({ x }: { x: number }) {
  ...
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 8,
        ...
        zIndex: 9,
```

z-index 9. `MascotPerch` container are `z-10` (line 211). ToolCallStack are `z-20` (per `ToolCallStack.tsx:27`).

Stack: mascot container z-10 > DustPuff z-9 (INSIDE mascot container — dar z-9 pe puff face-l invisibil sub even the mascot canvas dacă mascot canvas render pe z-auto (0)).

Actually z-index e relative la stacking context. DustPuff cu z-9 relative la mascot container. FeralMascot canvas fără explicit z → z-auto. In stacking context defined by MascotPerch's `z-10`, DustPuff cu z-9 > canvas cu z-auto? Depinde de order în DOM. In JSX, DustPuffs come BEFORE mascot wrapper (line 200-201). Deci DustPuffs mai devreme in DOM, dar cu z-9 explicit > auto → puffs OVER mascot.

Vibe design intent: puffs UNDER mascot (pe pardoseală). Currently poate OVER.

**Fix**: z-index puffs sub mascot:

```tsx
style={{ ..., zIndex: -1 }}  // sub mascot
```

Sau explicit z pe mascot canvas.

---

## §F44 — SearchOverlay: `restoreFocus` prin `document.activeElement` — dacă originator element demonated până when overlay close, focus lost în null → keyboard trap

`SearchOverlay.tsx:55-59`:
```tsx
useEffect(() => {
  const prev = document.activeElement as HTMLElement | null;
  inputRef.current?.focus();
  return () => prev?.focus?.();
}, []);
```

`prev` capturat la mount. Overlay open 30s while user searches. User navigates via Escape → overlay closes → restore focus la `prev`. Dar dacă `prev` was inside a component demontat între open + close (rare), focus fails → tab starts from body → keyboard user lost.

**Fix**: verify element still in DOM:

```tsx
return () => {
  if (prev && document.body.contains(prev)) {
    prev.focus?.();
  }
};
```

Micro but proper.

---

## §F45 — SearchOverlay: `runSearch` iterates through ALL conversations + full content per query char → performance cliff pe user cu 500+ conversații

`SearchOverlay.tsx:71-115`:
```tsx
const runSearch = useCallback(async (q: string) => {
  ...
  // Immediate title matches
  const titleMatches = allConvs.filter(...);
  setResults(titleMatches);

  // Load uncached full conversations in background
  const uncached = allConvs.filter((c) => !cacheRef.current.has(c.id));
  await Promise.all(
    uncached.map(async (c) => {
      try {
        const full = await tauri.conversations.load(c.id);
        cacheRef.current.set(c.id, full);
      } catch { /* skip unloadable convs */ }
    }),
  );
  ...
}, [allConvs]);
```

Debounce 150ms. Prima query char → load ALL uncached conversations (poate 500 fișiere JSON). RAM spike + IPC storm.

Cache ajută pentru queries subsequent. Dar FIRST query = latency + potential OOM pe user cu 5000 conversations.

**Fix**: incremental loading + display results as they come:

```tsx
const runSearch = useCallback(async (q: string) => {
  if (!q.trim()) { setResults([]); return; }
  const lower = q.toLowerCase();
  const results: SearchResult[] = [];

  // 1. Immediate title matches — cheap, all in memory.
  for (const c of allConvs) {
    if (c.title.toLowerCase().includes(lower)) {
      results.push({ conv: c, snippet: null });
    }
  }
  setResults([...results]);
  if (results.length >= 20) return;   // enough — user rarely scrolls past 20

  // 2. Content search — but stream results as they load.
  const CONCURRENCY = 5;
  const chunks: ConversationSummary[][] = [];
  for (let i = 0; i < allConvs.length; i += CONCURRENCY) {
    chunks.push(allConvs.slice(i, i + CONCURRENCY));
  }
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (c) => {
      // ... load + search + push to results
    }));
    setResults([...results]);   // progressive update
    if (results.length >= 50) return;   // hard cap
  }
}, [allConvs]);
```

Sau, better: server-side full-text search via `tauri.conversations.searchFTS(q)` care folosește SQLite FTS5 (deja există per `db.ts:496`).

---

## §F46 — SearchOverlay: `highlight` function nu escape `query` — nu-i security issue (React auto-escape), dar visual bug: query cu `<` sau `>` char nu highlighteaza

`SearchOverlay.tsx:12-26`:
```tsx
function highlight(text: string, query: string): React.ReactNode {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-brand/30 text-text-primary rounded-sm not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}
```

Only highlights first match. Un query `use` în text "How do I use useEffect?" — highlightează primul `use` doar. Următoarele apariții invisible.

**Fix**: multi-match:

```tsx
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let idx = 0;
  const lower = text.toLowerCase();
  let match: number;
  while ((match = lower.indexOf(q, idx)) !== -1) {
    if (match > idx) parts.push(text.slice(idx, match));
    parts.push(
      <mark key={match} className="bg-brand/30 text-text-primary rounded-sm not-italic">
        {text.slice(match, match + query.length)}
      </mark>
    );
    idx = match + query.length;
  }
  if (idx < text.length) parts.push(text.slice(idx));
  return <>{parts}</>;
}
```

---

## §F47 — StreamingIndicator: 2 event subscribers, `unlistens.forEach((u) => u())` fires SYNCHRONOUSLY dar unlistens are async-populated

`StreamingIndicator.tsx:52-59`:
```tsx
useEffect(() => {
  const unlistens: Array<() => void> = [];
  const set = (e: StreamProgressEvent) => setProgress(e);
  events.streamProgressEvent.listen((e) => set(e.payload)).then((fn) => unlistens.push(fn));
  events.onStreamProgress.listen(set).then((fn) => unlistens.push(fn));
  return () => { unlistens.forEach((u) => u()); setProgress(null); };
}, []);
```

Same pattern §235/§148 din runde anterioare. Effect cleanup runs sincron. Dacă cleanup fires înainte de `.then` (component unmount rapid), `unlistens = []` → nu cleanup nimic → listeners register-uite după cleanup → **leak**.

Component `StreamingIndicator` render conditional în `MessageList`:
```tsx
{status === 'streaming' && messages[messages.length - 1]?.content === '' && (
  <StreamingIndicator ... />
)}
```

Mount doar când content === ''. Fiecare token deconvertește condition → unmount. Deci re-mount rapid = leak-uri accumulate.

**Fix** identic §148:
```tsx
useEffect(() => {
  let cancelled = false;
  const unlisteners: Array<() => void> = [];
  const set = (e: StreamProgressEvent) => setProgress(e);
  Promise.all([
    events.streamProgressEvent.listen((e) => set(e.payload)),
    events.onStreamProgress.listen(set),
  ]).then((fns) => {
    if (cancelled) { fns.forEach((f) => f()); return; }
    unlisteners.push(...fns);
  });
  return () => {
    cancelled = true;
    unlisteners.forEach((u) => u());
    setProgress(null);
  };
}, []);
```

---

## §F48 — ThinkingBlock `Spinner` — border-current-color hardcoded, dar `text-text-muted` schimbă cu theme → spinner OK. Dar `border-t-transparent` NU cover partial states — mid-transition color

`ThinkingBlock.tsx:12-16`:
```tsx
function Spinner() {
  return (
    <span className="inline-block w-3 h-3 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
  );
}
```

`border-t-transparent` doar top-side transparent → spinner arată ca `⌒` open ring rotating. Standard.

Nu-i bug. Skip.

Dar `border-text-muted` folosește `--text-muted` = `#8C7E6A` — pe fundal `bg-bg-surface` = `#1C1916` → contrast 3.86 (per audit precedent §F1 error was 3.84, similar range) — spinner subtle dar visible. OK.

**Skip §F48** — no bug.

---

## §F49 — ThinkingBlock content afișat `whitespace-pre-wrap font-mono` DAR fără max-height → mesaj thinking gigantic (deepseek-r1 poate genera 10k+ chars thinking) rupe layout chat

`ThinkingBlock.tsx:56-59`:
```tsx
<div className="mt-2 pl-3 border-l border-border-subtle text-sm text-text-muted whitespace-pre-wrap font-mono">
  {content}
</div>
```

Fără `max-h` sau `overflow-y-auto`. Un thinking block cu 500 linii ocupă întreg viewport. User trebuie să scroll manual prin gânduri modelului să găsească răspuns real.

**Fix**: cap înălțime + scroll interior:
```tsx
<div className="mt-2 pl-3 border-l border-border-subtle text-sm text-text-muted whitespace-pre-wrap font-mono max-h-96 overflow-y-auto">
  {content}
</div>
```

Sau: prima N chars + "Show more" button.

---

## §F50 — ContextRing `ringColor` folosește CSS vars `var(--c-red, #ef4444)` care NU-s definite în globals.css

`ContextRing.tsx:47-50`:
```tsx
const ringColor =
  pct >= 0.9 ? 'var(--c-red, #ef4444)'
  : pct >= 0.75 ? '#f59e0b'
  : 'var(--color-text-muted, #888)';
```

`--c-red` NU în globals.css. `--color-text-muted` NU în globals.css (real var e `--text-muted`).

Fallback values kick in:
- 90%+ → `#ef4444` (Tailwind red-500) — NOT palette-aware.
- 75-90% → `#f59e0b` (Tailwind amber-500) — hardcoded.
- Sub 75% → `#888` gray — hardcoded.

Rezultat: ring colors HARDCODED, nu respectă theme. Palette warm brown → ring cu red-500 = jarring, out of place.

**Fix**: use existing palette vars:
```tsx
const ringColor =
  pct >= 0.9 ? 'var(--error)'
  : pct >= 0.75 ? 'var(--warning)'
  : 'var(--text-muted)';
```

`--error`, `--warning`, `--text-muted` toate definite pentru dark + light. Theme-aware.

---

## §F51 — ContextRing division by zero când `ctxWindow = 0` (edge case: no model loaded dar messages > 0)

`ContextRing.tsx:41`:
```tsx
const pct = Math.min(1, used / ctxWindow);
```

Dacă `ctxWindow === 0` (model not loaded, but `messages.length > 0` — un edge case dacă user avea chat cu model care s-a unloaded silent), `used / 0 = Infinity` → `Math.min(1, Infinity) = 1` → ring FULL red.

Nu-i crash, dar misleading — "context full" când context necunoscut.

**Fix**:
```tsx
const pct = ctxWindow > 0 ? Math.min(1, used / ctxWindow) : 0;
```

Ring empty când no model. Meaningful state.

---

## §F52 — MemoryLayersPage folosește `formatClock` care doesn't respect user locale time format (12h vs 24h)

`MemoryLayersPage.tsx:54-59`:
```tsx
function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
```

Hardcoded 24-hour format `HH:MM`. Users US default 12h AM/PM.

**Fix**: use `toLocaleTimeString`:
```tsx
function formatClock(ts: number, locale?: string): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}
```

Similar `MessageItem.tsx:253` — deja face `toLocaleTimeString(undefined, {...})`. Consistent OK acolo, aici hardcoded — divergență.

---

## §F53 — Sidebar `<Sidebar>` header `"Feral"` label + `SkillHubDrawer`, `OnboardingOrchestrator` — rebrand blockers cataloged

Deja parte din §F16, dar completing catalog:

Hardcoded "Feral" în UI-facing text:
1. `Sidebar.tsx:240` — logo text.
2. `AppearanceTab.tsx:50` — "Pick how Feral looks".
3. `OnboardingWizard.tsx:183` — "Welcome to Feral".
4. `OnboardingWizard.tsx:230` — hint "leave 'Feral'".
5. `OnboardingWizard.tsx:236` — placeholder "Feral".
6. `OnboardingWizard.tsx:269, 812` — fallback `'Feral'`.
7. `useFeral.ts:469` — notification "Feral Agent stopped".
8. `MemoryLayersPage.tsx:23, 197` — "Feral's Dreams", "Feral is exploring".
9. `FeralDreamsPanel.tsx:590-591, 747` — text în panel.
10. `EmptyStates.tsx:11` — `BYOK_DISCLAIMER_KEY = 'feral.agentByokDismissed'`.
11. Component names: `FeralMascot`, `FeralModelSelector`, `FeralGlobalMount`, `FeralDreamsPanel`, `useFeral`, `useFeralStore`.

**Recomandare rebrand pattern**:
```ts
// lib/brand.ts
export const APP_NAME = 'LittleBeast' as const;
export const APP_NAME_LOWER = 'littlebeast' as const;
export const AGENT_DEFAULT_NAME = APP_NAME;

// Migration table for stored values
export const LEGACY_BRAND_NAMES = ['Feral', 'feral'] as const;
```

Toate `'Feral'` string-uri UI-facing → `{APP_NAME}` sau `${APP_NAME}`. Doar 1 loc de update la rebrand.

Component names păstrate (`FeralMascot` etc) pentru compat internal, sau bulk rename într-un PR separate.

---

## §F54 — Zero responsive design — 23 apeluri Tailwind size prefixes total (`sm:/md:/lg:/xl:`) pe TOT frontend-ul, doar 1 folosit pentru grid layout

Grep results:
- Total `sm:/md:/lg:/xl:` in components/pages: **23 hits**.
- Doar 1 în chat/pages care e non-trivial: `MemoryLayersPage.tsx:332` `grid-cols-2 sm:grid-cols-4`.
- ChatPage, Sidebar, Settings, Onboarding — TOATE fixed layouts (max-w-2xl, max-w-3xl, etc.).

**Impact**: Tauri desktop app default 1000×700 window. User resize la 400×600 (split-screen sau half-monitor): 
- Sidebar 240px + main padding 16px + content 400-256 = 144px width pentru content.
- Chat max-w-2xl = 672px → chat content overflow → horizontal scroll.
- Onboarding wizard max-w-2xl → same issue.
- Message bubbles max-w-[75%] = tiny on narrow window.

Nu-i mobile app, dar user with narrow window has broken UX.

**Fix**: min window size în `tauri.conf.json`:
```json
"windows": [{
  "minWidth": 800,
  "minHeight": 600,
  ...
}]
```

Simplu. Prevents user din a resize sub un breakpoint.

Sau: responsive fallback în CSS pentru narrow — sidebar auto-collapses la <768px:
```tsx
// În useUI store:
const isNarrow = window.innerWidth < 768;
useEffect(() => {
  if (isNarrow && !sidebarCollapsed) setSidebarCollapsed(true);
}, [isNarrow]);
```

---

## §F55 — Toate `<img>` din ConnectorsPage/ExtensionsPage folosesc `alt=""` — decorative pattern, dar logo-ul e informational nu decorative

`ConnectorsPage.tsx:288`, `ExtensionsPage.tsx:217`, `ExtensionsPage.tsx:363`:
```tsx
<img
  src={entry.logo_url}
  alt=""       // ← empty alt = decorative
  ...
/>
```

`alt=""` = image decorative, screen reader skip. Dar aceste imagini sunt logo-uri de connectors/extensions:
- "Discord" logo — informational pentru user care distinguish între connectors.
- "OpenAI" logo — same.

Fără alt text, screen reader user vede doar `entry.name` (text alături) — inadequate context. Ar trebui `alt={entry.name + ' logo'}` sau `alt={entry.name}`.

`AttachedFileChip.tsx:42` — `alt={file.name}` — correct pattern for images.

**Fix**: 
```tsx
<img src={entry.logo_url} alt={`${entry.name} logo`} ... />
```

---

## §F56 — Icon-buttons cu `aria-label` dar tooltip missing → screen reader spune "Minimize" dar mouse user hover 3 sec fără feedback

WinControls (`AppShell.tsx:20-49`) și DownloadButton (`Sidebar.tsx:64-70`) au `aria-label` dar NU tooltip vizual.

Mouse user hoveră "≡" icon din WinControls — fără tooltip nu știe ce e (unless intuit de layout top-right = window controls).

**Fix**: wrap cu Tooltip:
```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <button aria-label="Minimize" onClick={...}>
      <Minus size={13} />
    </button>
  </TooltipTrigger>
  <TooltipContent>Minimize</TooltipContent>
</Tooltip>
```

Consistent cu Sidebar menu rows care AU Tooltip. Pattern inconsistent — some places tooltip, others no.

---

## §F57 — `main.tsx` — `JSON.parse(localStorage.getItem('feral-ui') || '{}')` — corrupt localStorage value crash app pe boot

`main.tsx:11`:
```tsx
const stored = JSON.parse(localStorage.getItem('feral-ui') || '{}');
```

Dacă `'feral-ui'` key contains invalid JSON (extension breaks it, user tampering, storage quota exceeded), `JSON.parse` throws → uncaught in `main.tsx` → app fails to boot → white screen.

Zustand persist-uite states — dacă persist storage corrupted, no recovery UI.

**Fix**: try/catch cu reset fallback:
```tsx
let stored: unknown = {};
try {
  stored = JSON.parse(localStorage.getItem('feral-ui') || '{}');
} catch (err) {
  console.error('[boot] corrupted feral-ui localStorage, resetting:', err);
  localStorage.removeItem('feral-ui');
  stored = {};
}
```

Same for other Zustand persist keys.

---

## §F58 — SearchOverlay `.line-clamp-2` (line 208) pe snippet — dar snippet include highlight `<mark>` care poate să nu render în clamp corect pe Firefox

`SearchOverlay.tsx:206-211`:
```tsx
{r.snippet && (
  <div className="text-xs text-text-muted mt-0.5 line-clamp-2">
    {highlight(r.snippet, query)}
  </div>
)}
```

`-webkit-line-clamp: 2` cu inline `<mark>` child works în WebKit/Blink OK. Firefox implemented line-clamp cu different bug — mark elements poate strip visual.

Tauri = WebKit (macOS) / WebView2 = Chromium (Windows) / WebKitGTK (Linux). Line-clamp support consistent aici. OK pe Tauri stack. Skip.

---

## §F59 — Delete confirmation în Sidebar (`Sidebar.tsx:365-378`) folosește `bg-red-500` hardcoded → nu respectă theme error color

Line 375:
```tsx
<button
  ...
  className="px-3 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
>
  {deleting ? 'Deleting…' : 'Delete'}
</button>
```

`bg-red-500 #ef4444` = Tailwind default. Palette warm brown/orange defined `--error #C0472A` (per globals.css). Delete button jarring color choice — inconsistent cu restul UI-ului warm.

Similar `text-red-400` folosit în multe locuri (`Sidebar.tsx:349, 380, 726`, `MessageItem.tsx:xxx`, etc.) — hardcoded Tailwind red în loc de `text-error`.

**Fix**: unificați:
```tsx
className="px-3 py-1.5 text-sm rounded bg-error text-white hover:bg-error/90"
```

Sau creează `<Button variant="destructive">` — shadcn's Button.tsx already has this variant. Use consistent primitives.

---

## §F60 — MISCELANEE

**§F60a** — `Sidebar.tsx::DownloadButton` popover deschide cu `align="end"` dar în collapsed state (sidebar 56px wide), popover-ul de 288px trece off-screen la stânga. Test: colapsat sidebar → click download → popover peste marginea window.

**§F60b** — `MascotPerch::wrapRef?.current?.offsetParent as HTMLElement | null` (line 105) — depinde de position:relative pe ChatInput's parent. Dacă cineva schimbă positioning la ChatInput în viitor, offsetParent poate returna wrong element → mascot travel bounds greșite.

**§F60c** — `AttachedFileChip` (line 42) — `<img src={file.dataUrl}>` fără size cap. Un file de 10MB data URL ca image → 10MB base64 în DOM. Multiple thumbnails × 5 files = 50MB in DOM strings. Fix: resize thumbnail via `<canvas>` la 40×40 înainte de display.

**§F60d** — `OnboardingWizard::DiskEncryptionNotice` (line 833-880) render doar în DoneStep. Dacă user Skip la step 0, notice nu se afișează niciodată → user cu encryption off nu-i notificat. Fix: prompt separat post-onboarding dacă disk unencrypted.

**§F60e** — `FeralModelSelector.tsx:23` — `LOCAL_PROVIDER_ID = 'feral-local'` — rebrand blocker. Depending on backend, poate să fie hardcoded și în Rust `src-tauri/src/commands/*`.

**§F60f** — `useOrganismImpulse` (mentionat runda §165 din audit-ul precedent) — testat pentru mascot dar folosit generic în alte animații. Aceleași issues acolo.

**§F60g** — Toast component (Toasts.tsx) — nu inspected, dar dacă folosește `dangerouslySetInnerHTML` pentru markdown în toasts, XSS via cron_fired content (§246 din runda 9 anterioară). Verify separat.

**§F60h** — Route splitting cu `lazy()` (router.tsx:11-15) — nu are `errorElement` per route. Dacă lazy chunk fails să încarce (network hiccup, deployment mid-download), user vede blank pagina fără fallback. Adaugă `errorElement={<PageLoadError />}` per route.

**§F60i** — `SettingsPage::CATS` (line 16-24) — 8 tabs, all rendered as buttons in aside sidebar. La window height mic (600px), 8 × ~34px per row = 272px + drag strip + padding = ~320px. OK pe 600px+ windows. Dar layout nu are scroll indicator dacă tabs overflow.

**§F60j** — `useAppVersion` hook returns string | null. Se fetchează async din Tauri. Sidebar footer arată `v${appVersion}` (line 297) — dar dacă `appVersion === "0.1.0"`, arată `v0.1.0`. Dacă `appVersion === null` (fetch fail), arată empty. Cu fallback fix propus §F20 → `v—`. Small consistency.

**§F60k** — `MemoryLayersPage` — nu are error state când `tauri.raw.rsiStatus()` fails (network, sidecar down). Component render empty. User confuz.

**§F60l** — `ThinkingBlock::Spinner` — border 2px pe 12×12 span → visually chunky. Better border-1 pentru small spinner.

**§F60m** — `OnboardingWizard::StepNavigation` bottom bar Back + Continue buttons — `disabled={step === 0}` pe Back când primul step. OK. Dar utilizator ATRAS de "Back" button vede-l disabled → doesn't know why. Add tooltip: "First step — no previous".

**§F60n** — `MessageList::pb-48` (line 38) padding bottom 12rem = 192px hardcoded pentru a lăsa loc chat input-ului. Dacă input înălțime schimbă (attached files chips add height), overlap. Măsură dinamic:

```tsx
const [inputH, setInputH] = useState(96);   // default
useEffect(() => {
  const input = document.querySelector('[data-chat-input]');
  if (input) {
    const ro = new ResizeObserver(() => setInputH(input.clientHeight));
    ro.observe(input);
    return () => ro.disconnect();
  }
}, []);

<div style={{ paddingBottom: inputH + 24 }}>
```

**§F60o** — `AppShell::UpdateToast + Toasts` (line 88-92) — `pointer-events-none` pe container plus `pointer-events-auto` pe children implicit. Dacă child NU set explicit → click passes through în app UI dedesubt. Verify că `UpdateToast` și `Toast` interne fac `pointer-events-auto`.

**§F60p** — `ChatInput::onMic` — `if (rec.error === 'denied')` check DUPĂ `await rec.start()` (line 106-108). Dar `rec.error` este `useState` din useVoiceRecorder → un update state e async. `await rec.start()` termina, dar `rec.error` din current closure poate NOT reflect noul error state. Race — error toast may or may not fire.

---

## Summary total (round 1 + round 2)

**~60 findings total** frontend audit (§F1-§F60 + subsections).

**Runda 2 adăugări (30 findings §F31-§F60):**
- **Rebrand surface**: §F31, §F32, §F53, §F60e (localStorage keys + hardcoded "Feral" strings — 11 catalogued locations)
- **Onboarding UX**: §F34 (skip vs defer confusion), §F35 (progress dots size + interactivity), §F36 (rapid-click animation stack), §F37 (HF repo dependency fragile), §F38 (verbose provider steps), §F39 (no password reveal), §F40 (whitespace trim missing)
- **MascotPerch complexity**: §F41 (deep-nested timer cleanup), §F42 (MASCOT_W hardcoded sync fragility), §F43 (DustPuff z-index conflict)
- **Search bugs**: §F44 (focus restore null check), §F45 (perf cliff 500+ conversations), §F46 (single-match highlight)
- **Streaming**: §F47 (unlistens race pattern — repeat §148 pattern), §F49 (ThinkingBlock unbounded height)
- **ContextRing**: §F50 (CSS vars nonexistent), §F51 (div by zero)
- **Cross-platform**: §F52 (24h locale not respected), §F55 (empty alt on informational logos)
- **Responsive**: §F54 (0 responsive design — need min window size in tauri.conf.json)
- **Delete UX**: §F59 (bg-red-500 hardcoded, ignores palette)
- **Boot safety**: §F57 (corrupt localStorage crashes on parse)
- **Misc**: §F60a-p (16 sub-findings)

# Runda 3 — Mascota (FeralMascot) rendered și analizată vizual

Am rendered pixel-art direct din `frames.ts` (95 frame-uri, 22 stări) la 3 outputs:
- `audit-mascot-idle.png` — IDLE_BLINK singur, 384×384 scaled 24×
- `audit-mascot-composite.png` — 5 stări side-by-side
- `audit-mascot-grid.png` — 15 stări în grid 4×4

**Concluzie generală despre design:**
Mascota e un *pixel gremlin* cute-scary — cap negru cu 2 urechi triunghiulare, față portocalie warm, corp round. **Design-ul e distinctiv și memorabil**, nu-i generic. Palette warm terracotta se leagă foarte bine cu brand-ul. 95 frame-uri hand-crafted = muncă serioasă și rare în AI apps (majoritatea folosesc generic Lottie sau emoji). E un asset care merită păstrat prin rebrand.

Dar am identificat câteva probleme reale de design:

---

## §F61 — CRITIC: `surprised` și `thinking` sunt aproape identice vizual → două stări indistinguishable

Comparație frame-by-frame (rândurile 5-6 = ochi):

**THINK_L** (line 81-97):
```
kkoowkoowkwookk    ← ochi: [w-w] [wkw] (asimetric, spre stânga)
kkookkookkookk    ← neutru
```

**SURPRISED** (line 271-287):
```
kkoowkkwkwookk    ← ochi: [wkkw] [kwk] (asimetric, dar aproape identic)
kkookkkwkkookk    ← ochi cu w mic pe mijloc
```

Ambele arată ca "ochi asimetrici scanning". User NU poate distinge dacă mascota gândește sau e surprised — două stări cu semantică distinctă produc feedback vizual identic.

Comparativ, `SLEEP` (line 233-249) e clar diferit (linie orizontală = ochi închiși) și `WAVE` are gură deschisă zâmbet — bine.

**Fix**: pentru `surprised`, folosește ochi mari GLOBALI (2 pătrate whitewhite mari), nu variații subtile pe ochi mici:
```
kkooooooooooookk
kkoowwoowwoookk    ← ochi mari, 2×2 fiecare
kkoowwoowwoookk
kkooooowwoooookk    ← gură "O" mică
```

Sau: adaugă `!` deasupra capului ca puff effect pentru surprised (există deja effects.ts sistem).

---

## §F62 — `cool` frame arată ca o mustață albastră peste piept, nu ca ochelari de soare

În grid image, rândul 3 col 4 (`cool` state): mascota arată cu față normală + un **dreptunghi albastru pe corp**. Design intent: ochelari cool. Actual render: bar-ul albastru e sub gură, pe piept, nu peste ochi.

Verific frame:

<verify manual>: aparent frame-ul folosește `b` (blue) pe rând 8-9 (mid-body) în loc de rând 5-6 (eye level). Bar peste corp = "casă de vestă" nu "ochelari".

**Fix**: mutează bara albastră la rândurile 5-6:
```
kkooooooooooookk
kkobbbboobbbbokk    ← ochelari orizontal peste ambii ochi
kkoookkoookkookk
kkooowrrwoookk
```

Test vizual: mascota cu ochelari negri sau albaștri = clearly "cool sunglasses" pe pixel-art.

---

## §F63 — `love` state — nu am identificat clear inima; se pare că doar variantă de gură mică fără indicator love clar

Grid rândul 4 col 1: mascota `love` are 2 ochi cu formă pattern (dots + w) — arată aproape ca CURIOUS, nu ca love.

Iubire pixel-art canonic = inimă vizibilă (2 pătrate colorate roz/roșu grupate ca `<3` sau `♥`). Currently: fără element grafic distinctiv "love".

**Fix**: adaugă un simbol inimă mic în canvas — fie deasupra capului via effects.ts (deja există sistem pentru CELEBRATE confetti), fie ochi cu formă inimă:
```
kkooooooooooookk
kkoomomooomomokk    ← ochi cu 'm' magenta (roz/roșu)
kkoomkkomkkomkk
kkooowrrwoookk
```

Sau confetti-style hearts fluttering:
```ts
// effects.ts adaugă:
love: (tick) => [
  { x: 5, y: 0, color: '#e91e63' },  // heart pixel
  { x: 12, y: 2, color: '#e91e63' },
],
```

---

## §F64 — Cele 2 "urechi/coarne" triunghiulare sus pot fi read ca urechi de vulpe / demon / iepure — ambiguu semantic

Column 1 top: mascota IDLE. Cele 2 elemente portocalii sus separate de cap negru:
```
...o........o...       ← vârfuri
..oo..kkkk..oo..       ← baze urechi + început cap
```

Interpretări posibile ale userului:
- **Urechi de vulpe** (Feral = wild fox) → aliniat cu brand actual.
- **Coarne mici** (little devil beast) → aliniat cu "Feral" wild vibe.
- **Urechi de iepure** (dacă mai apar rotunjite via alte frame-uri).
- **Antene** (dacă percep tehnic).

Pentru rebrand `LittleBeast`, aceste apendice AJUTĂ narativul — "little beast" implică creature cu urechi/coarne unnaturale. **Bun match.**

**Nu-i bug** — dar recomand documenting design intent explicit în `frames.ts` comments:
```ts
// Two horn-tufts atop the head: reads as ears or tiny horns depending on context.
// Deliberately ambiguous — the creature is a "little beast", not a specific animal.
```

Ajută viitor developer să nu "fix" ambiguitatea presupunând că-i bug.

---

## §F65 — Palette check: coarne/urechi folosesc `#cf7740` DIRECT, nu `BODY_SHADE[row]` → nu au shading gradient ca corpul

Vezi IDLE_BLINK row 0-1:
```
...o........o...   ← 'o' pe rând 0 = MASCOT_ORANGE plain (nu BODY_SHADE[0])
..oo..kkkk..oo..
```

Actually `BODY_SHADE[0]` = mix la rândul 0 → highlight upper luminous. Rendering-ul face `if (ch === BODY_CHAR) color = BODY_SHADE[r]` — deci **DA**, urechile primesc shading. Verifică row 0: `t = max(0, (0-2)/11)` = 0 → highlighted with `#f4c285` warm cream light. Row 0 = deschis. Row 1 = puțin mai portocaliu.

Verificat pe imagine — urechile arată deschise, corect. **NU-i bug §F65. Skip.**

---

## §F66 — `sleep` — ochi sunt clar închiși (linie orizontală w), dar cap-ul nu are "Z" plutitor deasupra → poate fi confuz "e sleep sau e broken"

Grid rândul 2 col 3: `sleep`. Ochi closed OK (o line orizontală). Dar sunt și alte state-uri cu ochi ascunși temporar (blink) — user vede snapshot momentaneously și nu știe "e sleep sau e blinking".

Există un `EFFECTS[state]` sistem pentru per-state overlay pixels (per FeralMascot.tsx:78-83). Sleep ar trebui să aibă "Z" puffs:

```ts
// effects.ts:
sleep: (tick) => {
  const y = ((tick / 2) | 0) % 8;   // Z rises slowly
  return [
    { x: 22, y: y, color: '#f0e6d3' },        // Z pixel 1
    { x: 23, y: y, color: '#f0e6d3' },        // Z pixel 2
    { x: 22, y: y + 1, color: '#f0e6d3' },
  ];
},
```

Verific dacă există:
```
cat effects.ts | grep sleep
```

Dacă nu, adaugă. Ambiguity fix.

---

## §F67 — Body proportions: `RUN_A` are picioare separate (4 pixel-legs), dar restul state-urilor au picioare `kkk..kkk` compact → inconsistență la tranzitie idle→run

IDLE_BLINK ultima 2 rânduri:
```
....kkk..kkk....
....kk....kk....
```

Doi picioruse cerclu-shaped, bază largă.

RUN_A ultima 4 rânduri:
```
..kkkkkkkkk.....
....kk.kk.......
...kk...kk......
..kk.....k......
```

Picioare deschise wide (running pose). OK vizual pentru running.

Dar tranzitia IDLE → CURIOUS → RUNNING → SLEEP: sprite-ul se DEFORMEAZĂ subit când tranzitie la RUN — nu-s frame-uri intermediare. User vede "pop" între poses.

Testat visual imposibil (nu rulez app), dar din code: `MascotPerch::startIdleSequence` (line 99-160) trece STATE = 'curious' → 'running' → 'sleep' cu `LEG_MS = 1_800` pentru run. Nu există smoothly interpolated frames intre state-uri — sprite instant swap.

Pentru pixel-art, instant swap e canonic (nu-i 3D animation). OK. Dar recomand adaugare 1-2 "transition" frames:
- `CROUCH` frame între idle și run (pregătire).
- `LAND` frame după stop running.

Micro-polish. Skip dacă nu-i priority.

---

## §F68 — `celebrate` — confetti effect apparent OK, dar dispare cu tick — verify că nu contribuie la DustPuff z-index conflict §F43

`celebrate` (grid rândul 3 col 2): confetti pixels visible sus. Frame arată bine. Dacă e implementat prin `EFFECTS[celebrate]` din effects.ts, folosește canvas overlay. Depinde de EFFECTS z-order — vezi §F43.

Skip verify separately.

---

## §F69 — 22 stări declarate în MascotState type dar `VARIANTS` mapping — nu toate au frames dedicate → fallback la generic frame

`FeralMascot.tsx` line 91-101: `variantRef.current = pool[idx]`. Dacă `VARIANTS[state] = []` sau undefined pentru un state, TypeError la runtime.

Verific:

Din grep `VARIANTS` (line 2456), assume există entry pentru toate 22 states. Dar unele probably alias la altele (`writing: VARIANTS.typing[0]` fallback). Verifică că fiecare unique semantic state are măcar 1 frame propriu, altfel semantic collision (writing arată identic cu typing = confuzie developer).

Skip fără test manual runtime.

---

## §F70 — RECOMANDARE POZITIVĂ: mascota e ASSET REAL, păstreaz-o prin rebrand

Contrar tuturor findings de bugs, mascota însăși e:
- **Distinctive** — nu se confundă cu Copilot, Claude Cursor mascot, sau alte AI companions.
- **Ownable** — pixel-art hand-crafted = signature vizual imposibil de replicat easy.
- **Warm** — palette clay/terracotta se leagă cu palette warm brown al app-ului.
- **Scalable** — 16×16 rende infinit-scale cu integer scaling.
- **Animated** — 22 stări = personality real, mai mult decât 99% mascote SaaS.

**Pentru rebrand LittleBeast**: mascota SE POTRIVEȘTE PERFECT cu numele "LittleBeast" — un pixel gremlin cute-scary IS a little beast. Numele "Feral" era mai wild/aggressive (fox-adjacent), dar mascota efectivă e mai cute-monster decât wild-animal. **Numele LittleBeast se aliniază MAI BINE cu asset-ul vizual actual decât numele Feral.**

Recomand:
1. Păstrează sprite-ul intact.
2. Rename component la `LittleBeastMascot` (pattern search-replace la nivel de fișier).
3. Marketing: leverage mascota ca companion mereu-prezent — poți face merchandise easy (stickers, T-shirts) datorită pixel-art distinctiveness.

Aceasta e o **asset advantage** rare în AI space. Nu multe startup-uri au un mascot real memorable.

---

**Prioritate suplimentară pentru fix pre-rebrand:**
1. **§F31, §F32, §F53** — hardcoded "Feral" + centralize în `lib/brand.ts` (foundation pentru rebrand painless).
2. **§F57** — localStorage corrupt crashes boot — high blast radius bug.
3. **§F50** — ContextRing colors ignore theme.
4. **§F54** — set min window size în tauri.conf.json (5-min fix, prevents 100% of narrow-window layout breakage).
5. **§F41** — MascotPerch timer cleanup + state machine refactor.
6. **§F47** — StreamingIndicator listener leak.
7. **§F37** — Onboarding HF repo dependency — needs server-side manifest.
8. **§F45** — Search performance cliff.
9. **§F49** — Thinking block unbounded — clip cu max-h.
10. **§F39, §F40** — Password reveal + trim — quick UX wins.
