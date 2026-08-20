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
