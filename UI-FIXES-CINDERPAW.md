# UI-FIXES-CINDERPAW.md

**Scope:** lista completă și acționabilă de fixes UI/UX pentru releaseul „huge" Cinderpaw, bazată pe două screenshots reale trimise de utilizator (2026-08-20 și 2026-08-21):

1. **Chat empty state** — post-onboarding, sidebar deschis, mascot pe composer, banner top „Feral is starting"
2. **Loading screen** — wordmark „FERAL" mare pe fundal aproape negru, dim gri

Documentul este un handoff pentru Opus (implementer). Nu include cod. Fiecare item are: **ce e greșit**, **de ce**, **fix propus**, **fișier țintă**, **prioritate**, **effort**, **risc de regresie**.

Legendă:
- **P0** — blocher pentru launch, arată neterminat sau breaks trust
- **P1** — vizibil, îmbunătățește semnificativ prima impresie
- **P2** — polish, poate merge într-un patch minor post-launch
- **Effort** — S (< 1h), M (1-4h), L (> 4h)
- **Risc** — Low / Med / High regresie pentru comportament existent

---

## SECȚIUNEA A — LOADING / SPLASH SCREEN

Context: la boot, utilizatorul vede pe ~2-20s (variază după workspace size — memoria se încarcă înainte de agent-ready) un fundal negru cu textul „**FERAL**" dim, spațiat larg, centrat. Zero motion, zero indicator că app-ul face ceva. Când în sfârșit apare UI, banner top-full-width zice „Feral is starting — it loads its memory first, which takes a moment on a large workspace. Messages sent now will fail until it is up."

### A1 — Rebrand wordmark: FERAL → CINDERPAW  [P0 · S · Low]

**Ce e greșit:** literalul „FERAL" e încă acolo. Post-rebrand toată aplicația trebuie să afișeze „CINDERPAW".

**De ce contează:** primul frame vizual la boot. Dacă zice „FERAL" atunci când site-ul, GitHub-ul, download page, HN post, toate zic „Cinderpaw", pierdem coerența în prima secundă.

**Fix propus:**
- Găsește sursa wordmark-ului. Nu se găsește prin grep simplu în `frontend-react/` sau `src-tauri/` — sugestii unde să cauți:
  - Native Tauri splashscreen definit în `src-tauri/tauri.conf.json` cu `windows[].label = "splashscreen"` (nu văd unul acum, dar poate a fost adăugat separat)
  - Un `index.html` alternativ (splash-only) referit din Rust când `MainWindow` nu e vizibil
  - CSS `::before` cu `content: "FERAL"` (n-am găsit, dar posibil în tema `styles/globals.css` sau într-un layer nou)
  - Randare canvas dintr-un binar/rezidual (font ligature, SVG in-line)
  - Un component React care rulează înainte de router — mount early în `App.tsx` / `main.tsx`, gated pe `useFeralStore.isReady === false`
- Rulează un `git log --all -p -S "FERAL" -- '*.tsx' '*.ts' '*.css' '*.html' '*.rs'` (fără filtre) și verifică orice hit care nu e env var (`FERAL_*` uppercase constants sunt zgomot legitim). Dacă nu iese nimic, e cvasi-sigur un splashscreen native Tauri într-un config care nu e commit-uit încă, sau un asset PNG/SVG.
- Verifică `frontend-react/public/` pentru `.svg` cu text „FERAL" (nu am găsit dar publicul poate conține chestii negrepate)
- Odată localizat: schimbă textul, ajustează spacing pentru 9 caractere (era 5), reduce `letter-spacing` proporțional ca lățimea totală să rămână constantă.

**Fișier țintă:** de determinat prin căutare. Locul cel mai probabil:  fișier `.tsx` mic într-un director de tip `shell/` sau `boot/`, sau `index.html` gate-uit de `#root:empty`.

---

### A2 — Spotlight sweep peste litere  [P1 · M · Low]

**Ce vrea userul:** „literele se lumineaza de un reflector" — un fascicul de lumină care traversează wordmark-ul, ca și cum un spot mișcător ar dezvălui fiecare literă pe rând.

**De ce contează:** primul semn că app-ul e „viu" în cele câteva secunde cât Tauri încarcă sidecar-ul. Elimină senzația de „e blocat, dau kill?".

**Fix propus (tehnica corectă, fără cod):**

1. Wordmark-ul e un single `<span>` cu textul CINDERPAW.
2. Aplică pe el un `background-image: linear-gradient(90deg, dim, highlight, dim)` cu 3 stops:
   - `0%` → `#2a2724` (dim resting, aproape invizibil pe #0e0d0c)
   - `50%` → `#ffe7c5` (warm white, peak-ul spotlight-ului)
   - `100%` → `#2a2724` (dim resting)
3. `background-size: 250% 100%` — gradientul e mai lat decât textul, deci peak-ul poate „ieși" pe ambele margini
4. `-webkit-background-clip: text; background-clip: text; color: transparent;` — gradientul e vizibil DOAR în interiorul glyph-urilor
5. `@keyframes` care animează `background-position` de la `130% 0` la `-30% 0` pe ~3400ms, cu `cubic-bezier(0.4, 0, 0.2, 1)` pentru easing natural (accelerează, decelerează la ieșire)
6. Bonus polish: duplică `<span>`-ul într-un layer identic cu `filter: blur(22px)` poziționat absolut sub cel crisp — simulează bloom-ul de lumină care „scapă" din litere fără canvas/WebGL. Adaugă `opacity: 0.85` pe el.
7. `prefers-reduced-motion: reduce` → oprește `@keyframes`, îngheață `background-position: 50% 0` (wordmark rămâne luminat mid-frame, lizibil, fără strobe).

**De ce așa și nu altfel:**
- Zero JavaScript pentru animația vizuală → nu se blochează dacă thread-ul principal e ocupat cu inițializarea agent-ului
- GPU compositor-only (background-position + opacity), 60fps garantat chiar și pe I/O grea la boot
- `background-clip: text` are 96%+ browser support din 2020, safe în Tauri (WebView2 pe Windows, WKWebView pe macOS, WebKitGTK pe Linux — toate ok)

**Alternativă mai simplă dacă apare bug:** aceeași tehnică dar cu un `<span>` alb care are `mask-image: linear-gradient(...)` cu poziție animată. Rezultatul vizual e identic, dar debugging-ul e mai clar dacă `background-clip: text` face ceva ciudat pe un anumit WebView.

**Ce să NU faceți:**
- **Nu** face fiecare literă un `<span>` separat cu `animation-delay` scalonat. Arată ca titlul de la _Stranger Things_, e cliché, și e mai fragil (spacing / letter-kerning se strică).
- **Nu** folosi `text-shadow` animat — laggy pe hardware slab, se vede stepping-ul.
- **Nu** pune un `<canvas>` pentru asta. Overkill, cost boot suplimentar, și nu răspunde la `prefers-reduced-motion` fără cod extra.

**Fișier țintă:** același component/HTML de la A1. Adăugă un `<style>` inline sau extinde `globals.css`. Dacă splash-ul e Tauri-native cu propriul `index.html`, adaugă CSS-ul acolo direct (are voie să fie zero-deps, splash-ul nu are nevoie de React).

---

### A3 — Status line sub wordmark  [P1 · S · Low]

**Ce e greșit:** utilizatorul nu are idee ce se întâmplă între „am dat click pe icon" și „apare UI-ul cu banner-ul de starting". Splash-ul actual e complet mut.

**Fix propus:**
- O linie mică sub wordmark, all-caps, `letter-spacing: 0.14em`, `#7a716a`, dimensiune 0.78rem
- Text care se schimbă în funcție de fază:
  - `LOADING MEMORY` (durează cel mai mult pe workspace mare — pattern-ul principal)
  - `WARMING UP EMBEDDINGS` (când embedding model se pre-loadează)
  - `CONNECTING TO AGENT` (ultimul pas înainte de `feral://agent-ready` — după rebrand `cinderpaw://agent-ready`)
- Pulsează opacity `0.55 → 1 → 0.55` pe 2200ms — semnal subtil că suntem vii
- Dacă boot depășește 15s, adaugă un rând 2 mic, tot text-muted: `TAKING LONGER THAN USUAL — LARGE WORKSPACE`. Fără linkuri, fără cancel; doar recunoștere.

**Sursa fazelor:** hookurile Tauri existente. Ai deja `feral://agent-ready` (`useFeral.ts:454`), `feral://embedding-download-*` (App.tsx `useEmbeddingDownloadStatus`), și pornirea sidecar-ului. Splash-ul poate să se aboneze la aceleași evenimente și să mapeze la string. Dacă splash-ul e Tauri-native (nu React), Rust-ul poate emit-ui un event `cinderpaw://boot-phase` cu payload string simplu.

**Fișier țintă:** același ca A1/A2. Store nou nu trebuie, folosește `useFeralStore` / hookuri existente.

---

### A4 — Fade-out clean pe agent-ready  [P1 · S · Low]

**Ce e greșit:** presupunând că splash-ul dispare când sidecar-ul e gata, e neclar dacă tranziția e cross-fade sau hard-cut. Un hard-cut de la splash negru direct la UI plin (cu sidebar, sugestii, mascot) e brutal vizual.

**Fix propus:**
- Când `useFeralStore.isReady` devine `true`:
  - Setează un flag intern `leaving = true`
  - Aplică `transition: opacity 400ms ease-out; opacity: 0` pe root-ul splash-ului
  - După 400ms, unmount total
- În paralel, UI-ul principal poate să fadă în invers (opacity 0 → 1 pe 400ms), rezultând într-un cross-fade natural
- **Nu** anima translate/scale — splash-ul zoom-out e cliché și distrage de la conținut

**Fișier țintă:** același ca A1. Dacă splash-ul e Tauri-native separate window, folosește `window.close()` cu animație CSS întâi, apoi Rust-ul închide handle-ul după timeout.

---

### A5 — Boot banner „is starting" — mutat sau eliminat  [P0 · M · Med]

**Ce e greșit:** după splash apare UI-ul dar cu un banner top-full-width foarte prominent: „Feral is starting — it loads its memory first, which takes a moment on a large workspace. Messages sent now will fail until it is up." (screenshot chat empty state)

**De ce contează:** dacă splash-ul face treaba corect (A1-A4), banner-ul ăsta e redundant — UI-ul nu ar trebui să apară dacă agentul nu e gata. Alternativ, dacă intenția e ca UI-ul să apară „optimist" imediat, atunci banner-ul e prea vizual — mănâncă 40+ px, texting-ul e speriat („Messages sent now will fail"), și rămâne acolo până e ready → utilizatorul vede prima interacțiune printr-un ecran cu un warning uriaș.

**Fix propus (una din două opțiuni):**

**Opțiunea 1 — Preferata mea:** ține splash-ul până la agent-ready, elimină complet acest banner. UI-ul principal nu se vede până când chat-ul chiar funcționează. Splash-ul are toate indicatoarele necesare (A3).

**Opțiunea 2 — Dacă vreți fast paint pe UI:**
- Reduce banner-ul la un pill top-center (folosește exact pattern-ul `EmbeddingDownloadBanner` din `App.tsx`)
- Text scurt: `Cinderpaw is starting…` cu spinner mic
- Poziționat `top-3 left-1/2 -translate-x-1/2` cu `rounded-full`, `bg-bg-surface/85`, `backdrop-blur`
- Composer să fie visibly disabled (opacity 0.5, cursor not-allowed pe input), tooltip pe hover: „Starting — try again in a moment"
- Zero text alarmant. „Try again in a moment" > „Messages sent now will fail"

**Fișier țintă:** cel care randează banner-ul. Cel mai probabil `frontend-react/src/App.tsx` (unde e `EmbeddingDownloadBanner`) sau `frontend-react/src/pages/ChatPage.tsx`. Grep după literal-ul „is starting" nu găsește nimic în TS/TSX curent — verifică `AgentOfflineBanner.tsx` variants sau găsește sursa printr-un React DevTools inspect live.

---

## SECȚIUNEA B — CHAT EMPTY STATE (screenshot 2026-08-20)

Reference: post-onboarding, prima intrare în app, empty state. Structură observată: sidebar 220px stânga cu logo FERAL sus + menu, top banner de starting, center „Good evening" + „What can I help you with?", composer cu mascot mic perched, 4 preset pills sub composer.

### B1 — Wordmark sidebar: FERAL → CINDERPAW  [P0 · S · Low]

**Ce e greșit:** `frontend-react/src/components/layout/Sidebar.tsx:237` → `<span>Feral</span>`. Post-rebrand.

**Fix propus:** înlocuiește cu `Cinderpaw`. Verifică că nu depășește layout-ul (9 caractere vs 5, fontul e `text-sm font-semibold`). Dacă wrappuiește, redu `text-sm` la `text-[13px]` sau scurtează afișat la un logo-only + tooltip.

**Fișier țintă:** `frontend-react/src/components/layout/Sidebar.tsx:237`

**Note:** vezi `RENAME-PLAN.md` pentru celelalte 20+ ocurențe „Feral" în UI (nu doar sidebar — Settings tabs, tooltips, OnboardingWizard `agentName default = 'Feral'` în `stores/onboarding.ts:90`, AboutTab, PrivacyTab etc).

---

### B2 — Section „Routier" — clarify sau elimină  [P1 · S · Low]

**Ce e greșit:** în sidebar, sub „Models", există o secțiune numită „Routier" cu un singur folder în ea. Numele e ambiguu (proiect? categorie? feature intern?). Utilizator nou nu are context.

**Fix propus:**
- Dacă „Routier" e nume de proiect al userului curent (Projects feature) → e normal, dar sectionheader-ul „Projects" ar trebui să fie deasupra ca discriminator. Verifică `Sidebar.tsx` cum randează sub-header-ul de section — pare că lipsește label-ul „PROJECTS" deasupra grupului.
- Dacă e o feature globală numită „Routier" (routing? router UI?) → redenumește la ceva self-explanatory („Presets", „Rules", etc.) sau ascunde până e populat.

**Fișier țintă:** `frontend-react/src/components/layout/Sidebar.tsx`. Verifică cum sunt grupate items-urile de `useProjects` vs `useConversations`.

---

### B3 — Recent list flat 15+ items → grupare temporală  [P1 · M · Low]

**Ce e greșit:** sub „Routier" sunt 15+ conversații listate flat, ordonate probabil desc după `updatedAt`, fără separator. Ochi-ul obosește, greu de scanat.

**Fix propus:**
- Grupare temporală standard, pattern-ul Claude/ChatGPT/Cursor:
  - `Today`
  - `Yesterday`
  - `Previous 7 days`
  - `Previous 30 days`
  - Bucketuri lunare pentru mai vechi (`August 2026`, `July 2026`)
- Section header: `text-[10px] uppercase tracking-wider text-text-muted`, padding vertical mic
- Comparaba deja folosită în code base pentru alte scopuri (grep `uppercase tracking-wider text-text-muted` din `Sidebar.tsx:88`)
- Threshold: dacă < 8 conversații total, skip grouping (nu are sens pentru puține items)

**Fișier țintă:** `frontend-react/src/components/layout/Sidebar.tsx` + `frontend-react/src/stores/conversations.ts` (adaugă un selector `groupByDate` sau computează în component cu `useMemo`).

**Effort:** M pentru că trebuie funcție de bucketare + testare cu date la marginea zilei/săptămânii (timezone-uri).

---

### B4 — Composer icons — consolidare în „Modes" popover  [P1 · L · Med]

**Ce e greșit:** în stânga-jos composer sunt 5+ iconuri fără label-uri clare pentru un utilizator nou:
- „Add a model ▼" — clar
- Paperclip — clar (attach)
- Mic — clar (voice input)
- Brain cu badge „5" — neclar. Skill count? Memory count? Brain stack version?
- Globe cu badge „A" — neclar. Auto web search? Anonymous mode?

**Fix propus:**

**Opțiunea A (mai puțin de făcut, dar același UI):** adaugă tooltip explicit pe hover cu label + shortcut pentru fiecare icon. Ex: „Brain — 5 skills active · Manage (⌘⇧B)".

**Opțiunea B (recomandată):** consolidează iconurile de „mode" (brain, globe) într-un singur buton „⚙ Modes" care deschide un popover cu:
- Toggle Brain skills (cu numărul 5 vizibil în popover, nu ca badge misterios)
- Toggle Web search (cu explicație scurtă „A" = Auto vs manual)
- Toggle Voice
- Etc.
- Pattern-ul e deja folosit intern în `ChatInput.tsx` (există `ControlsPopover.tsx`). Extinde-l în loc să adaugi mai multe iconuri floating.

**Fișier țintă:** `frontend-react/src/components/chat/ChatInput.tsx` (447l) + `frontend-react/src/components/chat/ControlsPopover.tsx` (deja există).

**Risc:** Med — dacă utilizatorii au format muscle memory pe iconurile individuale, mutarea într-un popover îi va incomoda. Mitigate: în release notes menționează schimbarea și lasă un shortcut de tastatură.

---

### B5 — Model activ — indicator persistent vizibil  [P1 · S · Low]

**Ce e greșit:** în screenshot NU se vede nicăieri numele modelului activ. „Add a model ▼" în composer e call-to-action, nu display. Utilizatorul nu știe cu ce vorbește. Când răspunsurile diferă între modele, cauza principală e non-observabilă.

**Fix propus:**
- Pill mic sub composer sau top-right în conversation header, format: `Claude Sonnet 4.6 · Local` sau `qwen2.5-32b · GGUF`
- Click → deschide `ModelPickerPopover`
- Dacă modelul curent e local + funcțional, marker verde mic; dacă e cloud + BYOK, marker warm-orange; dacă e cloud + fallback, marker gri
- Alternativă mai discretă: caret-badge lipit de „New Chat" în sidebar, arată prescurtat modelul default

**Fișier țintă:** `frontend-react/src/components/chat/ChatInput.tsx` sau `frontend-react/src/pages/ChatPage.tsx`. `useModel` store deja există (`stores/model.ts`).

---

### B6 — Preset pills — adaugă iconuri  [P2 · S · Low]

**Ce e greșit:** sub composer sunt 4 pills text-only: Research | Create | Analyze | Automate. Curat, dar text-only pe empty state se pierde vizual, și e greu de descoperit că sunt clickable.

**Fix propus:**
- Fiecare pill primește un icon 14px la stânga textului (lucide-react):
  - Research → `Search` sau `BookOpen`
  - Create → `Sparkles`
  - Analyze → `BarChart2` sau `LineChart`
  - Automate → `Zap` sau `Workflow`
- Padding puțin mai relaxat, `gap-1.5`
- Hover: `bg-bg-hover` cu tranziție 150ms

**Fișier țintă:** componentul care randează empty state al chat-ului — probabil `frontend-react/src/pages/ChatPage.tsx` sau un sub-component gen `ChatEmptyState.tsx`.

**Effort:** S. Zero regresie funcțională.

---

### B7 — Mascot wave animation la boot  [P2 · S · Low]

**Ce e greșit:** mascota apare static idle pe composer. Prima impresie e ratată — utilizatorul nu observă că e animat.

**Fix propus:**
- La primul mount în empty state, trigger `state='wave'` pentru 2s, apoi `state='idle'`
- Dacă `prefers-reduced-motion` → skip, direct idle
- Folosește `useMascotState.ts` — probabil un flag `initialGreeting: true` sau un setTimeout în montaj

**Fișier țintă:** `frontend-react/src/components/chat/mascot/MascotPerch.tsx` + `useMascotState.ts`

**Note:** `frames.ts` are deja o stare `wave` verificată (fals findings anterior au fost retrase — `effects.ts` conține hearts, Z's, wave etc.).

---

### B8 — Time-of-day greeting: verifică local time  [P2 · S · Low]

**Ce e greșit:** „Good evening" apare în screenshot. Ok dacă e seara. Dar dacă utilizatorul e la 3AM (când mulți dev-i sunt activi), „Good morning" sau chiar „Still up?" ar fi mai potrivit.

**Fix propus:**
- Buckets:
  - 05:00–11:59 → `Good morning`
  - 12:00–17:59 → `Good afternoon`
  - 18:00–22:59 → `Good evening`
  - 23:00–04:59 → `Still up?` sau `Good night` (opțional easter egg cu emoji subtil)
- Random cu 5% chance pentru variante: „Welcome back", „Ready?", „Hey" — dacă vreți personalitate mai pronunțată
- Localizează dacă adăugați i18n în roadmap

**Fișier țintă:** același component ca B6.

---

## SECȚIUNEA C — CROSS-CUTTING (nu vin din screenshot direct, dar sunt asociate)

### C1 — Nume aplicație în `<title>` HTML  [P0 · S · None]

**Ce e greșit:** `frontend-react/index.html:6` → `<title>Feral</title>`

**Fix propus:** `<title>Cinderpaw</title>`

---

### C2 — Tauri productName / identifier  [P0 · S · Med]

**Ce e greșit:** `src-tauri/tauri.conf.json` — `productName: "Feral"`, `identifier: "ai.feral.app"`, `title: "Feral"`.

**Fix propus:** urmează `RENAME-PLAN.md` fazele 1-4. Bundle identifier schimbat = users existenți instalați cu vechiul id vor vedea Cinderpaw ca app „nou" (au 2 iconuri pe Applications). Documentează migration path. Pentru releaseul „huge" e ok — e explicit un rebrand major, nu ninja update.

---

### C3 — Sidebar logo mark  [P1 · S · Low]

**Ce e greșit:** dacă logo-ul (pixel-art fluture/creatură lângă text „Feral" în sidebar) e specific brandului Feral, verifică dacă are sens vizual cu numele „Cinderpaw". Semantic „cinder" = jar/ember, „paw" = labă. Mascota actuală (creatura neagră cu burtă orange) încă se aliniază — poate fi păstrată ca „Cubby / Cinderpaw's shape".

**Fix propus:** păstrează mascota, redenumește intern dacă vrei (`FeralMascot.tsx` → `CinderMascot.tsx`), dar `RENAME-PLAN.md` cere o fază separată pentru asta. Prioritar: nu schimbi visual-ul, doar identificatori.

---

## SECȚIUNEA D — CE SĂ FACĂ OPUS ÎNAINTE SĂ ÎNCEAPĂ IMPLEMENTAREA

1. **Găsește sursa splash-ului.** Rulează:
   ```
   git log --all -p -S "FERAL" -- '*.tsx' '*.ts' '*.css' '*.html' '*.rs' '*.json' > /tmp/feral-splash-search.txt
   ```
   Filtrează prin rezultat și localizează unde e rendered wordmark-ul. Trebuie să existe undeva — dacă e într-un `.svg` sau într-un asset PNG, e un caz aparte (schimbat prin asset replacement, nu prin editare de cod).

2. **Confirmă cu utilizatorul flow-ul splash.** Sunt două scenarii posibile:
   - **A** — Splash e o fereastră Tauri separată (label = "splash"), care se închide când `MainWindow` primește `agent-ready`
   - **B** — Splash e overlay în interiorul MainWindow, un React component early-mount gated pe `isReady === false`
   
   Comportamentul diferit dictează unde adăugăm spotlight-ul + status text. Confirmă înainte de implementare.

3. **Nu implementa spotlight-ul CSS-doar cu `background-clip: text` fără să testezi în build-ul Tauri final.** WebView2 pe Windows are surprize ocazional cu `background-clip: text` combinat cu `filter: blur(...)` pe elemente adiacente — rulează un smoke test cu build production înainte să declari done.

4. **Testează `prefers-reduced-motion` explicit.** E cerință de acesibilitate pe care audit-ul anterior a marcat-o ca „inconsistent respectată" în app. Nu adaugă o nouă animație fără să ai media query-ul de escape.

5. **Verifică că splash-ul are `-webkit-app-region: drag`** (Tauri decorations: false — fereastra fără chrome nativ). Altfel utilizatorul nu poate muta app-ul cât timp e pe splash.

---

## SECȚIUNEA E — DE CONFIRMAT CU BLOOM (open questions)

1. **Splash-ul rămâne același între rebrand și release, sau facem un design nou complet?** (recomandare: rămâne cu spotlight sweep, e cel mai iconic move pentru un „huge release" fără să investim într-un video de intro)
2. **Vrem un sunet subtil pe boot?** (un chime scurt de 300ms când splash-ul dispare, ca macOS clasic). Ar diferenția experience-ul. Opțional, disable-able.
3. **Onboarding vs returning user split pe splash?** (returning user vede splash 1s scurt, prima instalare vede splash 3s + „First time? Welcome." mini-tagline). Marginal.
4. **Mascota mică peste sau lângă wordmark-ul de pe splash?** (opinia mea: nu — wordmark-ul e primul moment de brand, adaugă zgomot. Mascota apare imediat după, în UI.)

---

## SECȚIUNEA F — ORDINE DE ATAC RECOMANDATĂ PENTRU OPUS

**Sprint 1 (rebrand core, ½ zi):**
- A1, B1, C1, C2 (find + replace + build test)

**Sprint 2 (splash polish, 1 zi):**
- A2 spotlight sweep, A3 status line, A4 fade-out

**Sprint 3 (chat empty state polish, 1 zi):**
- A5 banner strategy decision + implement, B4 modes consolidation, B5 model indicator, B6 preset icons, B7 mascot wave

**Sprint 4 (nice-to-have, ½ zi):**
- B2 Routier clarify, B3 recent grouping, B8 greeting refinement

**Total:** ~3 zile de lucru concentrat pentru un utilizator familiar cu codebase-ul.

---

## SECȚIUNEA G — GLASSMORPHISM (cerere Darius 2026-08-21)

**Cerere verbatim:**
> „Cum facem TOT UI aplicației glassmorphic? Vreau să se vadă prin aplicație, să fie transparentă, ca și cum te-ai uita printr-o sticlă mată."

**Reformulare:** „TOT UI" e ambiguu și periculos dacă îl luăm literal (frosted glass sub text lung = ochi obosiți, sub cod = imposibil de citit). Regula industry (Apple, Arc, Windows 11 Settings, ChatGPT desktop): **chrome = glass, content = solid**.

Glass: sidebar, top bar, popovers, modals, tooltips, notifications, empty states.
Solid: message body, code blocks, inputs în composer, forms de settings.

Cu asta stabilit, planul concret:

---

### G1 — OS-level window transparency (Tauri config)  [P0 · S · Low]

**Actualmente:** `src-tauri/tauri.conf.json:29` are `decorations: false`, dar fereastra e complet opacă. Trebuie transparent + effect nativ pe Windows/macOS.

**Fix propus:**

1. Instalează plugin: `cd src-tauri && cargo add tauri-plugin-window-effects`
2. Register în `src-tauri/src/lib.rs` sau `main.rs`:
   ```
   .plugin(tauri_plugin_window_effects::init())
   ```
3. Update `tauri.conf.json` window config:
   ```
   "windows": [{
     "title": "Cinderpaw",
     "width": 1280,
     "height": 800,
     "minWidth": 900,
     "minHeight": 600,
     "resizable": true,
     "fullscreen": false,
     "decorations": false,
     "transparent": true,              // NEW
     "windowEffects": {                // NEW (via plugin)
       "effects": ["mica", "acrylic", "vibrancy"],
       "state": "active",
       "radius": 12
     }
   }]
   ```
   - Windows 11 preia `mica` automat, fallback la `acrylic` pe Windows 10
   - macOS preia `vibrancy` (NSVisualEffectView), fallback la nothing
   - Linux ignoră toate 3 → fallback CSS-only (vezi G4)
4. În CSS root (`globals.css`), setează body background la transparent DAR cu tint warm:
   ```
   body { background: rgba(14, 13, 12, 0.65); }
   ```
   0.65 alpha = suficient să vezi desktop-ul din spate, dar UI-ul rămâne lizibil.

**Test critic:** după implementare, deschide app-ul cu wallpaper viu în spate (nu solid color) — dacă e neplăcut vizual, ajustează alpha 0.65 → 0.75-0.80.

**Fișier țintă:** `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `frontend-react/src/styles/globals.css`

**Risc:** Med pe Linux — Mutter (GNOME) nu suportă blur, transparent window arată sec (vezi desktop direct fără blur). Fallback: pe Linux detectezi environment și setezi `transparent: false` cu solid dark background.

---

### G2 — Design tokens „glass" în paletă  [P1 · S · Low]

**Actualmente:** paleta e solid — `--bg-surface`, `--bg-elevated`, etc. Componente adăugă manual `bg-bg-surface/85 backdrop-blur` — inconsistent (unele au /85, altele /80, altele /90).

**Fix propus:** adaugă 3 tokens noi în `globals.css`:

```
:root[data-theme="dark"] {
  /* Existing solid tokens stay */

  /* NEW glass tokens */
  --glass-surface: rgba(28, 25, 23, 0.55);
  --glass-elevated: rgba(38, 33, 30, 0.65);
  --glass-overlay: rgba(20, 18, 16, 0.75);
  --glass-blur: 24px;
  --glass-saturate: 180%;
}
:root[data-theme="light"] {
  --glass-surface: rgba(250, 248, 245, 0.60);
  --glass-elevated: rgba(255, 253, 250, 0.70);
  --glass-overlay: rgba(240, 235, 230, 0.75);
  --glass-blur: 20px;
  --glass-saturate: 160%;
}
```

Tailwind config `tailwind.config.js` — expose ca utility:
```
theme: {
  extend: {
    backgroundColor: {
      'glass-surface': 'var(--glass-surface)',
      'glass-elevated': 'var(--glass-elevated)',
      'glass-overlay': 'var(--glass-overlay)',
    },
    backdropBlur: {
      'glass': 'var(--glass-blur)',
    },
    backdropSaturate: {
      'glass': 'var(--glass-saturate)',
    },
  }
}
```

**Rezultat:** oriunde vrei glass, scrii `bg-glass-surface backdrop-blur-glass backdrop-saturate-glass` — consistent, tokenized, dark/light aware.

**Fișier țintă:** `frontend-react/src/styles/globals.css`, `frontend-react/tailwind.config.js`

---

### G3 — Componente care devin glass (checklist explicit)  [P1 · M · Low]

**Devin glass (înlocuiesc `bg-bg-surface` cu `bg-glass-*`):**

| Component | Fișier | Token target |
|---|---|---|
| Sidebar | `components/layout/Sidebar.tsx:232` (deja are `/90 backdrop-blur` — normalize) | `glass-surface` + `backdrop-blur-glass` |
| Top bar / TitleBar | `components/layout/TitleBar.tsx` (dacă există) sau `AppShell.tsx` | `glass-surface` |
| Composer | `components/chat/ChatInput.tsx` | `glass-elevated` (mai opac, e primary interaction) |
| ModelPickerPopover | `components/chat/ModelPickerPopover.tsx` | `glass-elevated` |
| ControlsPopover | `components/chat/ControlsPopover.tsx` | `glass-elevated` |
| SearchOverlay | `components/chat/SearchOverlay.tsx:134` (deja glass) | normalize la `glass-overlay` |
| Toasts | `components/Toasts.tsx:43` (deja glass) | normalize la `glass-elevated` |
| UpdateToast | `components/UpdateToast.tsx:36` (deja glass) | normalize la `glass-elevated` |
| SkillHubDrawer | `components/SkillHubDrawer.tsx` | `glass-surface` |
| Dialog / Modal | `components/ui/dialog.tsx` | `glass-overlay` pentru backdrop, `glass-elevated` pentru content |
| Popover primitive | `components/ui/popover.tsx` | `glass-elevated` |
| Dropdown menu | `components/ui/dropdown-menu.tsx` | `glass-elevated` |
| Tooltip | `components/ui/tooltip.tsx` | `glass-elevated` |
| Onboarding wizard backdrop | `components/onboarding/OnboardingWizard.tsx:57` | `glass-overlay` |
| Empty state „Good evening" | `pages/ChatPage.tsx` | fundal transparent, doar text |

**Rămân solid (NU aplic glass):**

| Component | De ce |
|---|---|
| Message bubbles content | Lectură lungă → glass = eye strain în 15 min |
| Code blocks `<pre>` | Cod pe glass = imposibil de citit, contrast rupt |
| Composer TEXTAREA input (nu wrapper) | User trebuie să vadă clar unde tastează |
| Settings form inputs | Precision entry, glass distracts |
| Table rows (Models page) | Long-form data, glass complicates scanning |
| Documentation / Markdown render | Long-form text |
| Terminal outputs / logs | Monospace + high contrast requirement |
| Splash screen (deja negru solid) | Boot moment, glass n-ar avea sub ce să blur-eze |

**Regulă generală care rămâne cu tine forever:** dacă content-ul cere lectură > 30s continuous, e SOLID. Dacă e chrome-ul care doar afișează controluri sau surface temporar, e GLASS.

**Fișier țintă:** ~15 componente listate mai sus. Effort M pentru că e find-and-replace mecanic + verificare vizuală per componentă.

---

### G4 — Fallback pentru Linux (Mutter fără blur)  [P1 · M · Med]

**Problema:** GNOME (Mutter compositor, cel mai comun pe Ubuntu default) NU suportă blur behind transparent windows. Dacă lași `transparent: true` pe GNOME, user-ul vede desktop direct, brut, fără blur — arată brutal urât.

**Fix propus (2 straturi):**

1. **Runtime detection în Rust:**
   ```rust
   // src-tauri/src/lib.rs - la window creation
   #[cfg(target_os = "linux")]
   {
     let is_mutter = std::env::var("XDG_CURRENT_DESKTOP")
       .map(|d| d.to_lowercase().contains("gnome") || d.to_lowercase().contains("unity"))
       .unwrap_or(false);
     if is_mutter {
       // Disable transparency, use solid bg
       window.set_effects(WindowEffectsConfig::default())?;
       // Emit event to frontend
       window.emit("cinderpaw://compositor-nblur", ())?;
     }
   }
   ```

2. **Frontend listens și dezactivează glass tokens:**
   ```typescript
   // App.tsx sau un hook nou
   useEffect(() => {
     const unlisten = listen('cinderpaw://compositor-nblur', () => {
       document.documentElement.dataset.glass = 'off';
     });
     return () => { unlisten.then(fn => fn()); };
   }, []);
   ```

3. **CSS override:**
   ```
   :root[data-glass="off"] {
     --glass-surface: var(--bg-surface);
     --glass-elevated: var(--bg-elevated);
     --glass-overlay: var(--bg-overlay);
     --glass-blur: 0px;
     --glass-saturate: 100%;
   }
   ```

Rezultat: pe GNOME/Mutter, app-ul cade elegant la solid mode, arată identic cu ce e azi. Pe KDE/KWin (suportă blur nativ) și Sway/wlroots (suportă blur via extensii), rămâne glass.

**Fișier țintă:** `src-tauri/src/lib.rs`, `frontend-react/src/App.tsx`, `frontend-react/src/styles/globals.css`

**Risc:** Med — detection GNOME e euristică (var env poate lipsi în some setups). Test pe cel puțin Ubuntu 24.04 GNOME + Fedora KDE + Arch Sway înainte de release.

---

### G5 — Performance guard  [P1 · S · Low]

**Problema:** `backdrop-filter: blur(24px)` e GPU-heavy. Pe hardware low-end (Intel HD Graphics din laptopurile 2019-, ARM SBC-uri), frame rate cade la 20-30fps când multe panele glass sunt active.

**Fix propus:**

1. Detectează prin `navigator.hardwareConcurrency` + heuristic pe GPU tier
2. Sau: adaugă în Settings toggle „Enable glass effects (may reduce performance)"
3. Sau: `@media (prefers-reduced-transparency: reduce)` → colapse la solid
4. Sau — cel mai simplu — folosește tokens: dacă `--glass-blur: 0px`, glass devine solid, zero GPU cost

Recomandare: pattern G4 (data attribute pe html root) + un setting simplu „Reduce transparency" în Settings → Appearance care setează `data-glass="off"`. User poate opta out. Default = on.

**Fișier țintă:** `frontend-react/src/components/settings/AppearanceTab.tsx`, `stores/ui.ts` (adaugă `reducedTransparency: boolean`)

---

### G6 — Splash screen — glass sau nu?  [P2 · S · Low]

Splash screen (Secțiunea A) e primul frame vizual. Întrebare de design: glass sau solid?

**Decizia mea:** SOLID.

**De ce:** splash arată înainte ca window-ul principal să fie ready. Dacă transparent + blur, user vede desktop-ul cu wordmark „CINDERPAW" plutind — arată ca un notification, nu ca un boot moment.

Splash rămâne `#0e0d0c` solid + spotlight sweep. Restul app-ului devine glass după ce splash-ul dispare.

---

### G7 — Referință vizuală pentru „cum arată bine"

Studii Opus înainte de implementare:

- **Arc Browser (macOS/Windows)** — sidebar glass, content area solid. Model perfect pentru Cinderpaw.
- **Windows 11 Settings** — Mica effect pe fundal, panouri de setări cu vibrancy discret. Foarte subtle glass.
- **ChatGPT Desktop (macOS)** — sidebar cu vibrancy, chat area solid dark. Fix pattern-ul recomandat.
- **Raycast (macOS)** — command palette full glass, extensions cu content solid. Similar cu SearchOverlay-ul nostru.
- **Warp Terminal** — panel management glass, terminal output solid. Aceeași filosofie.

**Anti-exemple (ce NU face):**
- **Vista era 2007** — glass peste TOT, inclusiv document content. Ochi obosiți, retras.
- **Instagram stories** — glass peste text lung. Illegible.

---

### G8 — Order de implementare (pentru Opus)

**Sprint 1 (2-3h):**
- G1: window transparency + Tauri plugin
- G2: design tokens glass

**Sprint 2 (3-4h):**
- G3: aplicare pe cele ~15 componente listate
- Verificare vizuală per componentă cu wallpaper viu în spate

**Sprint 3 (2h):**
- G4: Linux GNOME fallback
- G5: setting „Reduce transparency"
- Testing pe Windows 11, macOS Sonoma+, Ubuntu GNOME, Fedora KDE

**Total: ~7-9h de lucru concentrat. Realistic 1 zi.**

---

## SECȚIUNEA G — GLASSMORPHISM (cerere Darius 2026-08-21)

**Cerere verbatim:**
> „Cum facem TOT UI aplicației glassmorphic? Vreau să se vadă prin aplicație, să fie transparentă, ca și cum te-ai uita printr-o sticlă mată."

**Reformulare:** „TOT UI" e ambiguu și periculos dacă îl luăm literal (frosted glass sub text lung = ochi obosiți, sub cod = imposibil de citit). Regula industry (Apple, Arc, Windows 11 Settings, ChatGPT desktop): **chrome = glass, content = solid**.

Glass: sidebar, top bar, popovers, modals, tooltips, notifications, empty states.
Solid: message body, code blocks, inputs în composer, forms de settings.

Cu asta stabilit, planul concret:

---

### G1 — OS-level window transparency (Tauri config)  [P0 · S · Low]

**Actualmente:** `src-tauri/tauri.conf.json:29` are `decorations: false`, dar fereastra e complet opacă. Trebuie transparent + effect nativ pe Windows/macOS.

**Fix propus:**

1. Instalează plugin: `cd src-tauri && cargo add tauri-plugin-window-effects`
2. Register în `src-tauri/src/lib.rs` sau `main.rs`:
   ```
   .plugin(tauri_plugin_window_effects::init())
   ```
3. Update `tauri.conf.json` window config:
   ```
   "windows": [{
     "title": "Cinderpaw",
     "width": 1280,
     "height": 800,
     "minWidth": 900,
     "minHeight": 600,
     "resizable": true,
     "fullscreen": false,
     "decorations": false,
     "transparent": true,
     "windowEffects": {
       "effects": ["mica", "acrylic", "vibrancy"],
       "state": "active",
       "radius": 12
     }
   }]
   ```
   - Windows 11 preia `mica` automat, fallback la `acrylic` pe Windows 10
   - macOS preia `vibrancy` (NSVisualEffectView), fallback la nothing
   - Linux ignoră toate 3 → fallback CSS-only (vezi G4)
4. În CSS root (`globals.css`), setează body background la transparent DAR cu tint warm:
   ```
   body { background: rgba(14, 13, 12, 0.65); }
   ```
   0.65 alpha = suficient să vezi desktop-ul din spate, dar UI-ul rămâne lizibil.

**Test critic:** după implementare, deschide app-ul cu wallpaper viu în spate (nu solid color) — dacă e neplăcut vizual, ajustează alpha 0.65 → 0.75-0.80.

**Fișier țintă:** `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `frontend-react/src/styles/globals.css`

**Risc:** Med pe Linux — Mutter (GNOME) nu suportă blur, transparent window arată sec (vezi desktop direct fără blur). Fallback: pe Linux detectezi environment și setezi `transparent: false` cu solid dark background.

---

### G2 — Design tokens „glass" în paletă  [P1 · S · Low]

**Actualmente:** paleta e solid — `--bg-surface`, `--bg-elevated`, etc. Componente adăugă manual `bg-bg-surface/85 backdrop-blur` — inconsistent (unele au /85, altele /80, altele /90).

**Fix propus:** adaugă 3 tokens noi în `globals.css`:

```
:root[data-theme="dark"] {
  /* Existing solid tokens stay */

  /* NEW glass tokens */
  --glass-surface: rgba(28, 25, 23, 0.55);
  --glass-elevated: rgba(38, 33, 30, 0.65);
  --glass-overlay: rgba(20, 18, 16, 0.75);
  --glass-blur: 24px;
  --glass-saturate: 180%;
}
:root[data-theme="light"] {
  --glass-surface: rgba(250, 248, 245, 0.60);
  --glass-elevated: rgba(255, 253, 250, 0.70);
  --glass-overlay: rgba(240, 235, 230, 0.75);
  --glass-blur: 20px;
  --glass-saturate: 160%;
}
```

Tailwind config `tailwind.config.js` — expose ca utility:
```
theme: {
  extend: {
    backgroundColor: {
      'glass-surface': 'var(--glass-surface)',
      'glass-elevated': 'var(--glass-elevated)',
      'glass-overlay': 'var(--glass-overlay)',
    },
    backdropBlur: {
      'glass': 'var(--glass-blur)',
    },
    backdropSaturate: {
      'glass': 'var(--glass-saturate)',
    },
  }
}
```

**Rezultat:** oriunde vrei glass, scrii `bg-glass-surface backdrop-blur-glass backdrop-saturate-glass` — consistent, tokenized, dark/light aware.

**Fișier țintă:** `frontend-react/src/styles/globals.css`, `frontend-react/tailwind.config.js`

---

### G3 — Componente care devin glass (checklist explicit)  [P1 · M · Low]

**Devin glass (înlocuiesc `bg-bg-surface` cu `bg-glass-*`):**

| Component | Fișier | Token target |
|---|---|---|
| Sidebar | `components/layout/Sidebar.tsx:232` (deja `/90 backdrop-blur` — normalize) | `glass-surface` + `backdrop-blur-glass` |
| Top bar / TitleBar | `components/layout/TitleBar.tsx` (dacă există) sau `AppShell.tsx` | `glass-surface` |
| Composer WRAPPER (nu textarea) | `components/chat/ChatInput.tsx` | `glass-elevated` |
| ModelPickerPopover | `components/chat/ModelPickerPopover.tsx` | `glass-elevated` |
| ControlsPopover | `components/chat/ControlsPopover.tsx` | `glass-elevated` |
| SearchOverlay | `components/chat/SearchOverlay.tsx:134` (deja glass) | normalize la `glass-overlay` |
| Toasts | `components/Toasts.tsx:43` (deja glass) | normalize la `glass-elevated` |
| UpdateToast | `components/UpdateToast.tsx:36` (deja glass) | normalize la `glass-elevated` |
| SkillHubDrawer | `components/SkillHubDrawer.tsx` | `glass-surface` |
| Dialog / Modal | `components/ui/dialog.tsx` | `glass-overlay` backdrop, `glass-elevated` content |
| Popover primitive | `components/ui/popover.tsx` | `glass-elevated` |
| Dropdown menu | `components/ui/dropdown-menu.tsx` | `glass-elevated` |
| Tooltip | `components/ui/tooltip.tsx` | `glass-elevated` |
| Onboarding backdrop | `components/onboarding/OnboardingWizard.tsx:57` | `glass-overlay` |

**Rămân solid (NU aplic glass):**

| Component | De ce |
|---|---|
| Message bubbles content | Lectură lungă → eye strain în 15 min |
| Code blocks `<pre>` | Cod pe glass = imposibil de citit |
| Composer TEXTAREA (input-ul actual, nu wrapper) | User trebuie să vadă clar unde tastează |
| Settings form inputs | Precision entry |
| Table rows (Models page) | Long-form data scanning |
| Markdown render / docs | Long-form text |
| Terminal / logs | Monospace + high contrast |
| Splash screen (deja solid) | Nu are sub ce blur-a la boot |

**Regulă permanentă:** dacă content-ul cere lectură > 30s continuous, e SOLID. Dacă e chrome sau surface temporar, e GLASS.

**Fișier țintă:** ~14 componente. Effort M — find-and-replace mecanic + verificare vizuală.

---

### G4 — Fallback pentru Linux (Mutter fără blur)  [P1 · M · Med]

**Problema:** GNOME (Mutter compositor, cel mai comun pe Ubuntu default) NU suportă blur behind transparent windows. `transparent: true` pe GNOME → user vede desktop brut fără blur → arată urât.

**Fix propus:**

1. Runtime detection în Rust la window creation:
   ```rust
   #[cfg(target_os = "linux")]
   {
     let is_mutter = std::env::var("XDG_CURRENT_DESKTOP")
       .map(|d| { let l = d.to_lowercase(); l.contains("gnome") || l.contains("unity") })
       .unwrap_or(false);
     if is_mutter {
       window.emit("cinderpaw://compositor-noblur", ())?;
     }
   }
   ```

2. Frontend listener dezactivează glass tokens:
   ```typescript
   useEffect(() => {
     const unlisten = listen('cinderpaw://compositor-noblur', () => {
       document.documentElement.dataset.glass = 'off';
     });
     return () => { unlisten.then(fn => fn()); };
   }, []);
   ```

3. CSS override:
   ```
   :root[data-glass="off"] {
     --glass-surface: var(--bg-surface);
     --glass-elevated: var(--bg-elevated);
     --glass-overlay: var(--bg-overlay);
     --glass-blur: 0px;
     --glass-saturate: 100%;
   }
   ```

Rezultat: GNOME/Mutter cade elegant la solid. KDE/KWin + Sway (support blur) rămân glass.

**Test:** Ubuntu 24.04 GNOME + Fedora KDE + Arch Sway minimum înainte de release.

**Fișier țintă:** `src-tauri/src/lib.rs`, `frontend-react/src/App.tsx`, `frontend-react/src/styles/globals.css`

---

### G5 — Performance guard + user opt-out  [P1 · S · Low]

**Problema:** `backdrop-filter: blur(24px)` e GPU-heavy. Pe Intel HD Graphics 2019- sau ARM SBC, frame rate cade la 20-30fps cu multe panouri glass.

**Fix propus:** Setting toggle „Reduce transparency" în `AppearanceTab.tsx`:
- Default: on (glass activ)
- Off → setează `data-glass="off"` pe root → colapse la solid (fallback G4 reused)
- Detectează automat `prefers-reduced-transparency: reduce` media query → forțează off

Zero cost pentru user care nu bifează.

**Fișier țintă:** `frontend-react/src/components/settings/AppearanceTab.tsx`, `stores/ui.ts` (`reducedTransparency: boolean`)

---

### G6 — Splash screen — glass sau nu?  [P2 · S · Low]

Splash (Secțiunea A) e primul frame înainte ca window-ul să fie ready. Dacă transparent + blur, user vede desktop cu wordmark plutind → arată ca notification, nu ca boot.

**Decizie:** SOLID `#0e0d0c` cu spotlight sweep. Glass începe DUPĂ splash dispare.

---

### G7 — Referință vizuală (Opus, study înainte de implementare)

Ce să urmărești:

- **Arc Browser (macOS/Windows)** — sidebar glass, content solid. Model perfect pentru Cinderpaw.
- **Windows 11 Settings** — Mica pe fundal, panouri cu vibrancy discret. Subtle glass.
- **ChatGPT Desktop (macOS)** — sidebar cu vibrancy, chat area solid dark. Fix pattern-ul recomandat.
- **Raycast (macOS)** — command palette full glass, extensions cu content solid.
- **Warp Terminal** — panel management glass, terminal output solid.

**Anti-exemple:**
- **Vista era 2007** — glass peste TOT, inclusiv document content. Retras după 6 luni.
- **Instagram stories** — glass peste text lung. Illegible.

---

### G8 — Order de implementare (pentru Opus)

**Sprint 1 (2-3h):** G1 window transparency + G2 tokens
**Sprint 2 (3-4h):** G3 aplicare 14 componente + verificare vizuală
**Sprint 3 (2h):** G4 Linux fallback + G5 setting user + testing cross-platform

**Total: ~7-9h de lucru concentrat. Realistic 1 zi.**

---

## Referințe

- Screenshots reale: chat empty state (2026-08-20) + loading screen (2026-08-21) trimise de utilizator în conversație. Nu sunt persisted în repo.
- `UI-RESEARCH-2026.md` — analiza mai largă, patterns 2026, comparație cu Claude/Cursor/Warp.
- `RENAME-PLAN.md` — flowul complet Feral → Cinderpaw pe 4 faze.
- `docs/adr/0014-brain-stack-arena-parity.md`, `0015-multi-agents-personal-team.md`, `0016-agent-community-cross-user-mesh.md` — ADR-urile de care depind features menționate (Brain badge „5", multi-agent selector în viitoarea versiune).
