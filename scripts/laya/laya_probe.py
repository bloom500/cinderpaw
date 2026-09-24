import time, os, json, sys
t0=time.time()
import torch, laya
print("torch", torch.__version__, "import", round(time.time()-t0,1), "s", flush=True)
t=time.time()
agent = laya.load("convaiinnovations/laya", device="cpu")  # auto-routes language
print("load", round(time.time()-t,1), "s", flush=True)
qs = {"relevant": {"type": "noul", "instructions": "Is this memory relevant to answering the question?"}}
cases = [
  ({"question": "What temperature do I bake bread at?", "memory": "User bakes sourdough at 230C with steam for the first 20 minutes."}, True),
  ({"question": "What temperature do I bake bread at?", "memory": "User's car is a 2014 Skoda Octavia, next service in March."}, False),
  ({"question": "La ce temperatura coc painea?", "memory": "User bakes sourdough at 230C with steam for the first 20 minutes."}, True),
  ({"question": "La ce temperatura coc painea?", "memory": "User's router admin password was changed on Monday."}, False),
]
for st, want in cases:
    t=time.time(); r=agent.system_one(st, qs); dt=time.time()-t
    print(json.dumps({"want": want, "p": (r.get("answers",r))["relevant"]["noul"], "ms": round(dt*1000)}), flush=True)
import psutil
print("rss_mb", round(psutil.Process().memory_info().rss/1e6), flush=True)
