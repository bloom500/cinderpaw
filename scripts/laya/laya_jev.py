import json, re, sys, time
import numpy as np, laya
S = sys.argv[1]
L = open(r"C:/Users/Darius/.cinderpaw/logs/cinderpaw.log", encoding="utf-8", errors="replace").read().splitlines()
last = None; ref = {}; addr = {}
for l in L:
    if "scope=jev" not in l: continue
    m = re.search(r'final transcribed in \d+ms: "(.*)" scope', l)
    if m: last = m.group(1); continue
    m = re.search(r'INFO ui: ([a-z_]+) conf=([0-9.]+)', l)
    if m and last: ref[last] = (m.group(1), float(m.group(2))); continue
    if "not addressed, ignored" in l and last: addr[last] = False
Q = json.load(open(S + "/jevq.json", encoding="utf-8"))
qs = {k: Q[k] for k in ("action", "addressed")}
items = [(u, a, c) for u, (a, c) in ref.items() if u.strip()]
print("utterances", len(items), "with jev conf>=0.7:", sum(c >= 0.7 for _, _, c in items), flush=True)
for sub in ("multilingual", None):
    agent = laya.load("convaiinnovations/laya", device="cpu", subfolder=sub)
    agree = agree_conf = n_conf = 0; ms = []; rows = []
    for u, a, c in items:
        st = {"utterance": u, "page": "unknown", "front": "unknown", "recent": "none", "candidates": {}}
        t = time.time(); r = agent.system_one(st, qs); ms.append((time.time() - t) * 1000)
        ans = r.get("answers", r)
        got = ans["action"]["choice"]; p = ans["action"]["probabilities"][got]
        agree += got == a
        if c >= 0.7: n_conf += 1; agree_conf += got == a
        rows.append((a, c, got, round(p, 2), u[:70]))
    print(json.dumps({"ckpt": sub or "english", "agree_all": f"{agree}/{len(items)}", "agree_jev_sure": f"{agree_conf}/{n_conf}",
                      "ms_median": round(float(np.median(ms)))}), flush=True)
    for row in rows[:82]:
        print("  jev=%-12s %.2f  laya=%-12s %.2f | %s" % row, flush=True)
