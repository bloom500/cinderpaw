# Faza 3 — Stabilizare fundație BRSI (design)

Data: 2026-07-02. Aprobat de Darius în sesiune.

Context: Faza 1 (L1 config-RSI) și Faza 2 (L3 code-RSI) sunt live pe main
(83ace3f), dar lanțul L3 nu a rulat niciodată live cu un model local, iar
patch-ul aplicat devine agentul viu doar prin rebuild manual. Faza 3 face
fundația „doar să meargă" înainte de a urca layere noi (harta completă a
fazelor 3–9 e în conversație; Faza 4 = scara de autonomie).

Model de referință pentru smoke: **Qwen 3.5 4B** (deliberat mic — forțează
robustețe pe diff-uri malformate; poveste de demo „merge și cu un 4B").

## Slice 1 — Smoke live L1+L3 cu Qwen 3.5 4B

App pornit cu `FERAL_CODE_RSI_REPO=D:\FeralLocalAI` + Qwen 3.5 4B primar,
„Dream now". Reparăm tot ce pică pe lanțul real: diff-uri malformate →
retry cu nudge de eroare (bounded, 2–3 încercări), parsing robust.
DoD: un patch real propus + aprobat + aplicat pe sursă.

## Slice 2 — Închiderea buclei: rebuild automat

După `applyPatchLive` reușit, Rust rulează rebuild-ul sidecarului
(`bun run build` + copy la `src-tauri/binaries/`) și `restart_sidecar`.
Gated pe prezența toolchain-ului (dev machine). Mașini fără Bun: explicit
DEFERAT — problemă de distribuție, se rezolvă la shipping-ul public al L3.

## Slice 3 — Watchdog crash→auto-revert (varianta A, aleasă din A/B/C)

La apply scriem marker (patch id + timestamp). Supervizorul `#11` (Rust,
vede fiecare exit al sidecarului) ține contor: **≥2 morți în 10 min cu
marker proaspăt → Rust face singur `git apply -R`** (nu depinde de
sidecarul posibil mort), rebuild, restart, marchează patch-ul `reverted`
în store, emite event → toast: „Am anulat o modificare care crea
probleme". Marker-ul expiră după fereastra stabilă. Health probe activă
(varianta B) doar dacă smoke-ul arată nevoia — slice separat, deferat.

## Slice 4 — Cleanup

Poluarea recurentă `.tmp-tree-champ-*.json` din teardown champion-tree.

## Testare

Unit: contorul de crash-loop, parserul de retry. Live: un patch care
omoară sidecarul la boot, injectat intenționat → demonstrează revert-ul
automat (moment-cheie de demo).

## Out of scope (Faza 3)

Video-ul de pitch (separat, materiale finanțare), zero-config/auto-detect
repo (Faza 4), promotion gates (Faza 4), health probe activă.
