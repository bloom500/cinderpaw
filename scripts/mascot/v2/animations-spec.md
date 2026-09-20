# Mascota Cinderpaw: 73 de animatii (spec pentru Astra)

Fiecare rand devine o ramura `if state == '<id>':` in `scripts/mascot/v2/astra/build.blender.py`
(functia `poses`), in stilul celor 7 existente. Eu randez, verific, fac GIF, Darius aproba.
Nimeni nu atinge `frontend-react/`; portarea in `frames.ts` e un pas separat, la final.

## Reguli fixe (nu se negociaza, verificatorul le prinde)

- **Schimbare 20 Sep, dupa grupul D**: canvas-ul de iesire e **64x64** cu personajul la (8,8)
  (coordonatele din `poses()` raman cele vechi, 48x48, `save()` face decalajul). Afisarea in
  aplicatie va fi la 2x (personaj 96 px). **Props: pana la 24x24 px**, trasaturi de 2 px
  grosime; la 10x10 nu se citeau (lupa, plic, carte, ceas). Un prop poate iesi pana la
  8 px in afara vechiului patrat de 48, pe orice latura.
- RGBA, fundal transparent; **exact 4 culori**: `#000000` contur, `#2c2c2c` blana,
  `#f1841b` portocaliu, `#ffffff` alb. Un prop galben, rosu sau albastru nu exista:
  props-urile sunt contur negru + umplutura portocalie sau alba, atat.
- Personajul e `base-48.png`, neschimbat: coarne, ochi 5x5 cu doua luciri, doi dinti,
  proportii. Fata poate fi `normal/half/closed/sad/down/up/smile` (exista) plus cele noi
  cerute mai jos (`open` gura deschisa, `wide` ochi mari, `squint` ochi mijiti,
  `dizzy` ochi X, `wink`).
- Props: maxim 24x24 px (vezi mai sus), in mana (capatul bratului) sau deasupra capului, **niciodata
  peste ochi**. Un prop are contur negru de 1 px ca sa se citeasca pe orice fundal.
- Brate: 3 puncte (umar, cot, mana), ca la `typing`. Un brat drept e o greseala.
- Squash and stretch minim 1 px pe tot corpul in fiecare stare; capul intarzie un cadru.
- 2..12 cadre; `holds` (durate inegale) obligatoriu; pozitiile de capat stau mai mult.
- Ce e `bucla` se intoarce curat in cadrul 1; ce e `o data` se termina intr-o poza stabila.
- Verificare: `python scripts/mascot/v2/check_frames.py scripts/mascot/v2/astra` -> PASS.
- Iesire: `scripts/mascot/v2/astra/<id>/001.png...` + intrarea in `manifest.json`.

Legenda: **F** = cadre, **fps**, **B** = bucla / **O** = o data. `[stare app]` = numele
din `MascotState` daca exista deja; restul sunt nume noi.

## A. Viata (idle si variantele lui) — 9

| # | id | declansator | poza + prop | F | fps | B/O |
|---|---|---|---|---|---|---|
| 1 | idle | nimic de facut | respira, clipit in doi pasi | 8 | 6 | B | GATA |
| 2 | idle-look-around [curious] | idle > 6 s | ochii stanga, pauza, dreapta, pauza; capul urmeaza 1 px | 6 | 4 | B |
| 3 | idle-scratch | idle, rar | un brat se ridica la ceafa, 3 miscari mici, coboara | 6 | 6 | O |
| 4 | idle-yawn | idle > 60 s, inainte de sleep | gura `open` mare, ochi `closed`, o mana la gura, corpul se intinde 1 px in sus | 5 | 4 | O |
| 5 | idle-sit | idle lung, varianta | se lasa 2 px in jos (asezat), bratele pe genunchi, clipit | 6 | 4 | B |
| 6 | stretching [stretching] | dupa task lung terminat | ambele brate sus, corpul +2 px inaltime, apoi relaxare | 5 | 5 | O |
| 7 | sleep | fara activitate mult timp | ochi inchisi, zZz | 6 | 3 | B | GATA |
| 8 | wake-up | primul input dupa sleep | ochi `half` -> `wide`, un salt de 1 px, bratele se scutura | 4 | 8 | O |
| 9 | excited [excited] | prima pornire, cheie noua, model nou | sare 2 px de doua ori, gura `smile`, bratele sus-jos | 4 | 8 | B |

## B. Intrare (omul face ceva) — 6

| # | id | declansator | poza + prop | F | fps | B/O |
|---|---|---|---|---|---|---|
| 10 | typing | omul scrie in composer | se uita in jos, mainile la burta tasteaza | 4 | 8 | B | GATA |
| 11 | listening | apel vocal, omul vorbeste | o mana facuta palnie la ureche, ochi `wide`, capul inclinat 1 px | 4 | 4 | B |
| 12 | listening-headset | apel vocal activ (stare de fond) | prop: casti (arc negru peste cap, doua cupe orange pe laturi), ochi normali, respira | 6 | 5 | B |
| 13 | reading-attachment | omul a atasat imagine/fisier | prop: rama alba 8x7 cu colturi negre tinuta cu ambele maini, ochii `down` | 4 | 4 | B |
| 14 | paste | omul a lipit text lung | prop: foaie alba 6x8 cu 3 linii negre, o mana o tine, cealalta arata spre ea | 3 | 5 | O |
| 15 | drag-drop | fisier tras peste fereastra | ambele brate deschise larg spre sus, gura `open`, ochi `wide` | 3 | 6 | O |

## C. Gandire — 7

| # | id | declansator | poza + prop | F | fps | B/O |
|---|---|---|---|---|---|---|
| 16 | thinking | modelul genereaza, fara text | mana la barbie, ochi sus | 4 | 4 | B | GATA |
| 17 | thinking-deep | thinking > 10 s | mana la barbie + prop: 3 puncte albe care urca in diagonala spre dreapta sus (bula de gand), apar unul pe cadru | 6 | 3 | B |
| 18 | thinking-scratch-head | thinking > 30 s | mana la ceafa in loc de barbie, ochi `squint`, capul inclinat 2 px | 4 | 4 | B |
| 19 | planning | plan mode / lista de pasi | prop: foaie alba 7x9 cu 3 linii negre si o bifa orange care apare pe cadre succesive | 4 | 3 | O |
| 20 | remembering | recall din memorie (FMS) | ochi `up`, prop: norisor alb 7x4 deasupra capului cu un punct orange in el, pulseaza 1 px | 4 | 4 | B |
| 21 | deciding | alege intre unelte / modele (Brain Stack) | ochii stanga-dreapta rapid, ambele maini sus la nivelul umerilor, palme in sus (cantar), alterneaza 1 px sus-jos | 4 | 6 | B |
| 22 | streaming [talking] | textul curge | gura `open`/`smile` alternat, o mana gesticuleaza sus-jos, cealalta la burta | 4 | 8 | B |

## D. Unelte (functiile agentice) — 26

| # | id | declansator | poza + prop | F | fps | B/O |
|---|---|---|---|---|---|---|
| 23 | searching [searching] | web_search | prop: lupa (cerc alb 5x5 contur negru + maner negru) tinuta la ochi, cealalta mana pe burta; lupa se misca 1 px st-dr | 4 | 5 | B |
| 24 | searching-deep | deep_research | prop: binoclu (doua cercuri lipite) la ochi, capul se roteste 1 px stanga-dreapta | 4 | 4 | B |
| 25 | fetching-url | fetch_url | prop: undita (linie neagra diagonala din mana, fir alb 1 px in jos) care se leagana 1 px | 4 | 4 | B |
| 26 | reading [reading] | citeste fisier | prop: carte deschisa (doua foi albe 5x6 cu linii negre) in ambele maini, ochii `down`, o pagina se intoarce (frame alternat) | 4 | 3 | B |
| 27 | reading-pdf | citeste PDF / pagina lunga | prop: foaie alba lunga 6x11 tinuta cu ambele maini, ochii `down` coboara 1 px pe cadru | 4 | 3 | B |
| 28 | browsing [browser] | browser incorporat | prop: fereastra (dreptunghi alb 9x7 cu bara neagra sus) in fata la nivelul burtii, un cursor negru 2x2 se muta in ea | 4 | 5 | B |
| 29 | writing [writing] | scrie fisier / document | prop: creion (linie neagra 5 px, varf orange) in mana dreapta peste foaie alba 6x6 tinuta in stanga; creionul se misca 1 px | 4 | 6 | B |
| 30 | writing-code | scrie cod (fisier .ts/.rs/.go) | prop: laptop (dreptunghi negru 10x6 cu ecran alb, pe genunchi), mainile pe el alterneaza | 4 | 8 | B |
| 31 | building [building] | build / compile | prop: ciocan (maner negru, cap orange 3x2) ridicat si coborat; corpul squash la impact, o scanteie alba 1 px la impact | 4 | 6 | B |
| 32 | running-shell | comanda shell | prop: terminal (dreptunghi negru 9x6 cu `>` alb si un cursor alb care clipeste) tinut in fata | 4 | 4 | B |
| 33 | testing | ruleaza teste | prop: eprubeta (contur negru, lichid orange care bolboroseste, 1 px alb urca) in mana, ochii `down` | 4 | 5 | B |
| 34 | tests-green | teste trecute | prop: bifa orange mare 7x7 ridicata deasupra capului, salt 1 px | 3 | 6 | O |
| 35 | committing | git commit / push | prop: trei noduri albe legate cu linii negre (graf git) in fata, un nod nou apare orange | 4 | 4 | O |
| 36 | calling [calling] | trimite pe conector (Discord, Slack, mail...) | prop: plic alb 7x5 cu clapa neagra tinut sus, mana il "arunca": plicul urca 2 px si dispare | 4 | 6 | O |
| 37 | calling-phone | conector de voce / telefon | prop: receptor negru cu doua capete orange la ureche, gura `open` alternat | 4 | 6 | B |
| 38 | receiving-message | mesaj intrat de pe conector | prop: plic cade de sus (3 pozitii) in mainile ridicate, ochi `wide` | 4 | 6 | O |
| 39 | remembering-store | scrie in memorie | prop: cufar (dreptunghi orange 8x5 cu capac negru) jos-dreapta, mana pune un punct alb in el, capacul se inchide | 4 | 4 | O |
| 40 | delegating [spawning] | cowork / subagent pornit | arata cu degetul spre dreapta, prop: mini-silueta 6x8 (blob negru cu doua puncte orange) care apare la dreapta pe cadre succesive | 4 | 5 | O |
| 41 | handoff | preda un task altui agent | prop: foaie alba in mana intinsa spre dreapta, mini-silueta o ia (foaia se muta 2 px) | 4 | 4 | O |
| 42 | image-generating | genereaza imagine | prop: pensula (maner negru, varf orange) + rama alba 7x7 in stanga in care apar 3 puncte orange pe cadre | 5 | 4 | O |
| 43 | speaking [voice] | TTS / agentul vorbeste in apel | gura `open`/`normal` alternat, prop: 3 arce albe la dreapta gurii, apar unul pe cadru | 4 | 8 | B |
| 44 | exporting | export artefact / PDF / docx | prop: cutie orange 8x5 deschisa in fata, o foaie alba intra in ea de sus, capacul se inchide | 4 | 5 | O |
| 45 | sending-file | trimite fisier pe conector | prop: avion de hartie alb 6x3 pleaca din mana spre dreapta-sus, 3 pozitii, dispare | 4 | 8 | O |
| 46 | installing-skill | instaleaza skill / MCP | prop: piesa de puzzle (patrat alb 5x5 cu bumb) adusa din dreapta si "apasata" in burta (squash la contact) | 4 | 5 | O |
| 47 | downloading | descarca model / update | prop: sageata neagra in jos deasupra capului + bara alba 8x2 care se umple cu orange pe cadre | 5 | 4 | B |
| 48 | scheduling | cron / rutina / reminder | prop: ceas (cerc alb 7x7 contur negru, doua ace negre) tinut sus; acul mare avanseaza pe cadre | 4 | 3 | B |

## E. Blocat (asteapta omul sau lumea) — 8

| # | id | declansator | poza + prop | F | fps | B/O |
|---|---|---|---|---|---|---|
| 49 | asking | ask_user | o mana ridicata sus, ochi `wide`, capul inclinat 1 px, prop: `?` alb 3x5 deasupra capului care pulseaza 1 px | 4 | 4 | B |
| 50 | waiting-approval | cere permisiune (shell riscant) | ambele palme in fata la nivelul burtii (semn "stop?"), ochi normali, clipit rar | 4 | 3 | B |
| 51 | waiting-long | tool lung (>1 min) | asezat 2 px mai jos, prop: clepsidra alba 5x7 contur negru in mana, nisipul orange trece de sus in jos pe cadre | 6 | 2 | B |
| 52 | waiting-network | asteapta raspuns retea | prop: 3 puncte albe deasupra capului care se aprind pe rand, ochii urmaresc punctele | 3 | 4 | B |
| 53 | rate-limited | 429 / cota epuizata | ochi `half`, bratele lasate, prop: ceas mic deasupra capului, corpul se lasa 1 px | 3 | 2 | B |
| 54 | no-key | provider fara cheie | prop: cheie (cap rotund alb, tija neagra) tinuta in fata cu ambele maini, `?` alb deasupra, ochi `wide` | 3 | 3 | B |
| 55 | offline | fara retea | prop: nor alb cu o linie neagra taiata peste el deasupra capului, ochi `sad`, umerii 1 px jos | 3 | 2 | B |
| 56 | locked | actiune interzisa de politica / deny wall | prop: lacat (corp orange 5x5, arc negru) in fata, bratele in X peste burta | 3 | 3 | O |

## F. Rezultat — 10

| # | id | declansator | poza + prop | F | fps | B/O |
|---|---|---|---|---|---|---|
| 57 | done | a terminat | zambet, degetul mare | 4 | 6 | O | GATA |
| 58 | celebrate | task mare / workflow complet | brate sus, salt, steluta | 4 | 8 | B | GATA |
| 59 | done-nod | raspuns scurt terminat | un singur nod din cap (2 px jos, sus), gura `smile` | 3 | 6 | O |
| 60 | error | a esuat si stie | trist, umerii cazuti | 3 | 4 | B | GATA |
| 61 | error-crash | sidecar / tool a crapat | ochi `dizzy` (X), capul se clatina 1 px st-dr, prop: 2 stelute albe orbiteaza deasupra capului | 4 | 6 | B |
| 62 | interrupted | omul l-a oprit (Stop) | oprit la mijlocul pasului: un brat ramas sus, ochi `wide`, apoi coboara incet, umerii jos | 4 | 4 | O |
| 63 | confused | raspuns gol / nu a inteles | ridica din umeri (ambele brate cot indoit, palme sus, umerii +1 px), prop: `?` alb deasupra | 4 | 4 | B |
| 64 | retrying | reincearca dupa eroare | prop: sageata circulara (arc alb cu varf negru) deasupra capului care se roteste in 4 pozitii, ochi `squint` | 4 | 6 | B |
| 65 | timeout | tool depasit ca timp | prop: ceas cu acele in jos, ochi `half`, o mana la frunte | 3 | 3 | O |
| 66 | partial | terminat cu lipsuri | prop: bifa orange 7x7 din care lipseste un colt (jumatate), gura dreapta (nici `smile` nici `sad`), un umar ridicat | 3 | 4 | O |

## G. Social si personalitate — 7

| # | id | declansator | poza + prop | F | fps | B/O |
|---|---|---|---|---|---|---|
| 67 | wave [wave] | salut la deschidere / "buna" | un brat sus flutura (cot fix, mana 2 px st-dr), gura `smile` | 4 | 6 | B |
| 68 | goodbye | omul inchide / "pa" | flutura mai lent, ochi `half`, apoi capul 1 px jos | 4 | 4 | O |
| 69 | love [love] | omul multumeste / lauda | ochi `closed` fericit (arc), prop: inima (5x5, orange cu contur negru, alb 1 px lucire) urca 3 px deasupra capului | 4 | 5 | B |
| 70 | cool [cool] | task greu reusit usor | prop: ochelari de soare (bara neagra 12x3 peste ochi, doua lentile), bratele incrucisate, un nod din cap | 3 | 3 | O |
| 71 | gaming [gaming] | ruleaza benchmark / ARC / joc | prop: controller (dreptunghi negru 9x4 cu 2 puncte orange) in ambele maini, degetele alterneaza, ochi `squint` concentrat | 4 | 8 | B |
| 72 | surprised [surprised] | eveniment neasteptat (mesaj de la alt agent, fisier nou) | ochi `wide`, gura `open`, salt 1 px inapoi, bratele deschise; `!` alb deasupra | 3 | 8 | O |
| 73 | dreaming | dream cycle / consolidare memorie noaptea | ochi `closed`, corpul respira lent, prop: semiluna alba 5x5 + 2 puncte albe deasupra capului care clipesc alternativ | 6 | 2 | B |

## Ordinea de lucru (Astra)

Cate un grup pe sesiune, in ordinea A, C, D, E, F, B, G. In fiecare grup, starile
`[cu nume in app]` primele. Dupa fiecare stare: verificator, apoi urmatoarea. Cand un
prop nu incape in 4 culori sau in 10x10 px, simplifica prop-ul, nu incalca regula.
Raport: tabel id | cadre | PASS/FAIL | ce ai simplificat si de ce.
