# Cinderpaw: designul sonor

9 octombrie 2026. **Decizia:** suita din aplicație e sintetizată de `frontend-react/scripts/ui-synth.py`
(familia „lemn moale”, stil Tri-Tone), aleasă de Darius dintre trei familii sintetizate.
Numai Cubby (trezire, adormire) folosește vocea lui reală de la ElevenLabs.
`python frontend-react/scripts/ui-synth.py --install` refabrică tot și îl copiază în `src/assets/sounds`.

**Ce nu a mers:** prima încercare (`sound-suite.py`, descrisă mai jos) cerea note și foley de la ElevenLabs
și le acorda local. A sunat „groaznic”, iar cauza probabilă e materia primă: înregistrări generate, cu zgomot
și cameră, acordate și stratificate. Sunetele Apple, Messenger și WhatsApp sunt tonuri sintetizate, curate și
scurte. `sound-suite.py` rămâne doar pentru `fetch`, care aduce vocea lui Cubby, și pentru funcțiile de
masterizare pe care le refolosește `ui-synth.py`.

## Ce spune research-ul

Etichete: **[S]** spus de sursă, **[I]** deducția noastră.

1. **Un timbru, o tonalitate.** Sunetele care pot cădea aproape unul de altul trebuie să aibă
   aceeași tonalitate sau una compatibilă, și să împartă timbrul sau anvelopa. [S]
   [Material, Sound choreography](https://m2.material.io/design/sound/sound-choreography.html).
   Will Littlejohn (Facebook): aceeași paletă pentru tot setul, „ca o pictură în același stil”. [S]
   [20k, Facebook and Google Pixel](https://20k.org/episodes/facebook-and-google-pixel)
2. **Timbrul te face să recunoști sunetul, mai mult decât melodia.** La Intel, 80% au recunoscut melodia cântată la vioară
   și 100% sunetul original, chiar cu o notă greșită. [S, sursă secundară]
   [Silicon Valley Watcher](https://www.siliconvalleywatcher.com/20-year-anniversary-of-intel-bong----innovative-marketing-drove-billions-in-chip-sales/)
   Apple a înregistrat sunetele Apple Watch din metalele carcasei. [S]
   [WWDC17, Designing Sound](https://developer.apple.com/videos/play/wwdc2017/803/)
3. **Sensul vine din numărul de note și din direcție, nu din volum.** Ritmuri cu număr diferit de
   note sunt „foarte eficiente”. Prima notă accentuată, ultima mai lungă. Frecvențe între 150 Hz și 5 kHz.
   Volumul e „principala cauză de iritare”. [S]
   [Brewster, earcon guidelines](https://www.dcs.gla.ac.uk/~stephen/earcon_guidelines.shtml).
   În sus înseamnă început sau ceva pozitiv, în jos înseamnă sfârșit. [S]
   [Material, Sound attributes](https://m2.material.io/design/sound/sound-attributes.html)
4. **Cu cât armonia e mai simplă, cu atât rezistă mai mult la repetare.** Ornamentele devin „chinuitoare
   a mia oară”. [S] [Littlejohn](https://medium.com/facebook-design/how-to-enhance-mobile-interactions-with-sound-design-3c3b30e98177)
5. **Calmul are o formă:** respirație, înflorire de 300-400 ms, coadă transparentă. Windows 11 a trecut de la ~40
   de sunete la ~8. [S] [Quiet Mark, Matthew Bennett](https://quietmark.com/news/tuning-the-sound-of-technology-responsible-sensory-design)
6. **Logo-ul este sursa motivelor; sunetele scurte sunt tăiate din el.** Mastercard: melodie de 30 s,
   semnătură de 3 s, sunet de plată de 1,3 s, fiecare tăiat din cel dinainte. [S]
   [Marketing Brew](https://www.marketingbrew.com/stories/2022/10/17/inside-mastercard-s-10-layer-sonic-branding-plan)
7. **Memorabilitatea** (Silas et al., 90 de logo-uri, 1.860 de oameni): tonalitatea stabilă ajută și
   recunoașterea, și reproducerea din memorie. Complexitatea ajută recunoașterea, dar îngreunează fredonarea. [S]
   [Cambridge repository](https://www.repository.cam.ac.uk/handle/1810/402035)
8. **Urgența vine din viteză, înălțime, repetiție și parțiale nearmonice.** Viteza contează cel mai mult. [S]
   [Suied et al. 2008](https://www.mcgill.ca/mpcl/files/mpcl/suied_2008_jepappl.pdf). Prin urmare,
   o eroare calmă e o singură dată, lentă, în registru jos, cu același instrument. [I]
9. **Difuzoarele de laptop** redau foarte puțin sub ~400 Hz [S]
   [Framework community](https://community.frame.work/t/speakers-sound-quality/1078/34). De aceea tăiem
   sub 170 Hz și atenuăm zona aspră de 2,5-5 kHz. [I]
10. **Finisaj:** fără liniște la început, fără cozi tăiate, fără zgomot de fond; o săptămână de folosire pe dispozitive reale. [S] (Apple, WWDC17)

**Ce sună ieftin:** înalte aspre, sunete de jucărie urcate în ton, sunete mari pentru momente mărunte,
familii amestecate, volumul folosit ca sens, zgomot de fond, imitații de hârtie mototolită sau mașină de scris,
același sample repetat la nesfârșit.

**ElevenLabs:** modelul `eleven_text_to_sound_v2` cere cel puțin 0,5 s, nu are seed și nu garantează
nota cerută. [S] [API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert).
Prin urmare îl folosim ca pe un studio de înregistrări: cerem materie primă (o notă, o atingere, un jar),
iar acordajul, tăietura și mixajul le facem local, ca într-un DAW. [I]

## Identitatea Cinderpaw

- **Tonalitate:** Fa major pentatonic (F G A C D). Fără semitonuri, deci două sunete suprapuse rămân consonante.
- **Motivul „Cin-der-paw”:** F5, C6, A5. Urcă o cvintă, coboară o terță mică, iar ultima notă se așază
  peste un acord F-C-A. Ritm scurt, scurt, apoi o pauză și aterizarea.
- **Material:** un singur instrument cântă toate notele. Se alege unul din trei, ascultând:
  kalimba cu fetru, marimba din lemn de trandafir, pian cu fetru.
- **Textura de semnătură:** pocnete foarte discrete de jar, numai în logo, „gata” și notificare.
- **Cubby:** vocea lui reală de la onboarding, fără cuvinte (un „Hm?”, un oftat), plus notele familiei.

| Sunet | Ce spune | Cum e făcut | Nivel* |
|---|---|---|---|
| Buton principal | am primit | atingere de lemn cu fetru, uscată | -31 |
| Comutator pornit / oprit | s-a schimbat | clichet de lemn, +2 / -2 semitonuri | -31 / -32 |
| Panou deschis / închis | apare / dispare | foșnet de hârtie, se luminează / se întunecă | -33 / -35 |
| Mesaj trimis | a plecat | foșnet care urcă și o notă A5 foarte mică | -28 |
| Tool aprobat | da, mergi | F5, apoi A5 imediat, o „încuviințare” | -26 |
| Sarcină terminată | gata | C5, F5, A5 urcând, aterizare caldă, două pocnete de jar | -23 |
| Eroare | nu a mers, poți continua | D5, apoi C5, înăbușite, o singură dată | -24 |
| Notificare | ai ceva de văzut | F5, apoi C6: începutul logo-ului | -21 |
| Cubby se trezește / adoarme | e aici / se odihnește | vocea lui + note care urcă / coboară | -25 / -27 |
| Semnătura | Cinderpaw | motivul întreg, acordul și jarul | -19 |

\* Nivel K-ponderat (BS.1770) măsurat doar pe partea audibilă. La click-uri de 60 ms, o fereastră de 400 ms
ar media sunetul cu liniștea. Diferența dintre cel mai discret sunet și logo e de 18 dB, în intervalul de
15-20 dB acceptat de ghidurile pentru earcons.

## Cum se face

1. `fetch`: 41 de preluări brute de la ElevenLabs (3-4 variante pentru fiecare material), o singură dată.
2. `build`: alege variantele curate (o singură notă, ton stabil), acordează fiecare notă exact în tonalitate,
   pune notele la locul lor, adaugă aceeași cameră caldă (0,55 s) și masterizează pe nivelul rolului.
3. `check`: 48 kHz stereo, vârf sub -3 dBFS, nivel la ±1 dB de țintă, compatibil mono, fără click la final.
4. Audiție în pagina `output/sound-suite/build/index.html`: alegi materialul, apoi asculți în context.
