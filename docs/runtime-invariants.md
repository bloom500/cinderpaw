# Runtime Invariants

Regulile de bază ale Cinderpaw Runtime. Orice decizie din Faza 4.5+ (Slice 1-6 și
după) se validează împotriva lor. Dacă un design le încalcă, designul e greșit.

1. **Runtime owns state.** Nu GUI, nu CLI, nu Discord, nu Slack. Runtime-ul.
2. **Runtime owns Dreams.** Dream Cycles pornesc, rulează și se închid în
   runtime, indiferent ce client e conectat (sau niciunul).
3. **Runtime owns LoRA.** Training, eval-gate, hot-swap, recovery — toate în
   runtime. Clienții doar observă și aprobă.
4. **Runtime owns Memory.** FMS, embeddings, sesiuni — o singură memorie, în
   runtime. Clienții nu țin istoric propriu ca sursă de adevăr.
5. **Runtime owns Evolution.** Ratchet, config-RSI, code-RSI, watchdog —
   runtime-ul le execută; clienții doar le declanșează/vizualizează.
6. **Clients are stateless.** Un client care moare sau se reconectează nu
   pierde și nu corupe nimic. Orice client poate fi înlocuit cu `curl`.
7. **Transports are replaceable.** stdin/stdout, HTTP, SSE, Discord — toate
   cară aceleași envelope-uri. Protocolul nu depinde de transport.
8. **Inference implementation is unique.** Un singur stack de inferență
   (cinderpaw-core, 11435). Niciodată un al doilea llama-server paralel.
9. **Journal is append-only.** Provenance/telemetria RSI nu se rescrie și nu
   se pierde la shutdown — flush înainte de exit.
10. **Confidence gate cannot be bypassed.** Niciun client, connector sau
    endpoint API nu poate ocoli eval-gate-ul / fail-loud-ul (LoRA, code-RSI).
11. **Every client MUST produce identical behavior.** „Hello" de pe Desktop,
    CLI, Discord sau REST trece prin aceeași funcție (`AgentLoop.handle`), nu
    prin implementări paralele.
12. **Runtime owns scheduling.** Nici GUI, nici CLI, nici Discord nu decid
    CÂND pornește un Dream, un training, housekeeping, GC sau embedding
    refresh. Clienții doar CER (`RequestDream`); runtime-ul decide: OK / not
    now (CPU busy) / queue. Orice „dream now" din UI e o cerere, nu o comandă.
