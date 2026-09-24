"""Laya as a relevance judge on the memory-intrusion set: 30 questions (EN and RO)
x 50 facts, ground truth = same subject. Reports AUC and precision@3."""
import json, sys, time, numpy as np, laya
S = sys.argv[1]; SUB = sys.argv[2] if len(sys.argv) > 2 else None
subs = json.load(open(S + "/mi.json", encoding="utf-8"))
RO = {
 "which DAW do I use for recording": "ce DAW folosesc pentru inregistrari",
 "what loudness do I master at": "la ce loudness fac masterul",
 "how much do I charge for a studio session": "cat cer pentru o sesiune de studio",
 "what oil does my car take": "ce ulei ia masina mea",
 "when is the next service due on the car": "cand e urmatoarea revizie la masina",
 "what size are my winter tyres": "ce marime au cauciucurile de iarna",
 "what hydration do I use for bread": "ce hidratare folosesc la paine",
 "what temperature do I bake at": "la ce temperatura coc",
 "which herb do I hate": "ce planta aromatica nu suport",
 "am I VAT registered": "sunt platitor de TVA",
 "when does my accountant need the papers": "cand are nevoie contabilul de acte",
 "what payment terms do I put on invoices": "ce termen de plata pun pe facturi",
 "what is my squat record": "care e recordul meu la genuflexiuni",
 "which exercise hurts my shoulder": "ce exercitiu ma doare la umar",
 "how much protein should I eat": "cata proteina ar trebui sa mananc",
 "when should I water the garden": "cand ar trebui sa ud gradina",
 "what pest attacks my roses": "ce daunator imi ataca trandafirii",
 "what did the soil test say": "ce a iesit la analiza solului",
 "which lens do I use most": "ce obiectiv folosesc cel mai des",
 "what do I edit my RAW files in": "in ce editez fisierele RAW",
 "what camera do I own": "ce aparat foto am",
 "which seat do I book on flights": "ce loc rezerv in avion",
 "when does my travel insurance renew": "cand se reinnoieste asigurarea de calatorie",
 "how much luggage do I take": "cat bagaj iau",
 "how often does the cat see the vet": "cat de des merge pisica la veterinar",
 "what does the cat eat": "ce mananca pisica",
 "when do I give the supplement": "cand ii dau suplimentul",
 "what router do I have": "ce router am",
 "when does the NAS back up": "cand face NAS-ul backup",
 "how are guest devices separated": "cum sunt separate dispozitivele oaspetilor",
}
facts = [(s["id"], f"{k}: {v}") for s in subs for k, v in s["facts"]]
agent = laya.load("convaiinnovations/laya", device="cpu", subfolder=SUB)
Q = {"r": {"type": "noul", "instructions": "Does this saved fact help answer the user's question?"}}
def auc(pos, neg):
    pos, neg = np.array(pos), np.array(neg)
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())
for lang in ("en", "ro"):
    pos, neg, p3 = [], [], []
    t = time.time()
    for s in subs:
        for q in s["queries"]:
            qq = q if lang == "en" else RO[q]
            states = [{"question": qq, "saved_fact": f} for _, f in facts]
            res = agent.predict_batch(states, Q, batch_size=25)
            sc = [r["answers"]["r"]["noul"] if "answers" in r else r["r"]["noul"] for r in res]
            lab = [sid == s["id"] for sid, _ in facts]
            pos += [x for x, l in zip(sc, lab) if l]; neg += [x for x, l in zip(sc, lab) if not l]
            top = np.argsort(sc)[::-1][:3]; p3.append(np.mean([lab[i] for i in top]))
    print(json.dumps({"ckpt": SUB or "english", "lang": lang, "auc": round(auc(pos, neg), 3),
                      "precision_at_3": round(float(np.mean(p3)), 3),
                      "mean_pos": round(float(np.mean(pos)), 3), "mean_neg": round(float(np.mean(neg)), 3),
                      "sec": round(time.time() - t)}), flush=True)
