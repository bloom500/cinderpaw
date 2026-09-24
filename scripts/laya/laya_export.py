"""Export Laya's DecisionModel to ONNX, check parity with torch, quantize to int8, re-check."""
import json, os, sys, time
import numpy as np, torch, laya
from laya.common import collate_items, QTYPES
OUT = sys.argv[1]; SUB = sys.argv[2] if len(sys.argv) > 2 else "multilingual"
agent = laya.load("convaiinnovations/laya", device="cpu", subfolder=SUB)
m = agent.model.eval()
try: m.encoder.config._attn_implementation = "eager"
except Exception as e: print("attn impl", e)

cases = [
  ({"question": "What temperature do I bake bread at?", "memory": "User bakes sourdough at 230C with steam for the first 20 minutes."}, "noul"),
  ({"question": "La ce temperatura coc painea?", "memory": "User's router admin password was changed on Monday."}, "noul"),
  ("Hey, can you move my dentist appointment to Friday?", "choice"),
  ("The build failed again with the same linker error, third time today.", "score"),
]
QS = {
  "noul": {"relevant": {"type": "noul", "instructions": "Is this memory relevant to answering the question?"}},
  "choice": {"intent": {"type": "choice", "instructions": "What does the user want?", "criteria": ["schedule", "search", "code", "chat"]}},
  "score": {"frustration": {"type": "score", "instructions": "How frustrated is the writer?", "criteria": ["calm", "slightly annoyed", "annoyed", "very frustrated"]}},
}
def batch_for(state, kind):
    q = QS[kind]; ids = list(q)
    internal = {k: agent._to_internal(v) for k, v in q.items()}
    items = agent._encode_state(state, ids, internal)
    return collate_items([items], agent.tok.pad_token_id)
names = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
b0 = batch_for(*cases[0])
args = tuple(b0[n] for n in names)
path = os.path.join(OUT, f"laya-{SUB}.onnx")
t = time.time()
REEXPORT = not os.path.exists(path)
from torch.export import Dim
B, L, K = Dim("b", min=1, max=64), Dim("l", min=8, max=512), Dim("k", min=1, max=64)
ds = {"input_ids": {0: B, 1: L}, "attention_mask": {0: B, 1: L}, "marker_pos": {0: B, 1: K},
      "marker_mask": {0: B, 1: K}, "qtype": {0: B}}
prog = None if not REEXPORT else torch.onnx.export(m, args, dynamo=True, dynamic_shapes=ds, input_names=names,
                         output_names=["logits", "act"], opset_version=18, external_data=False)
prog and prog.save(path)
print("export", round(time.time() - t, 1), "s", os.path.getsize(path) // 1_000_000, "MB", flush=True)

import onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic, QuantType
q8 = path.replace(".onnx", ".int8.onnx")
import onnx
mo = onnx.load(path); del mo.graph.value_info[:]
clean = path.replace(".onnx", ".novi.onnx"); onnx.save(mo, clean)
quantize_dynamic(clean, q8, weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"])
os.remove(clean)
print("int8", os.path.getsize(q8) // 1_000_000, "MB", flush=True)
for p in (path, q8):
    sess = ort.InferenceSession(p, providers=["CPUExecutionProvider"])
    worst = 0.0; ms = []
    for st, kind in cases:
        b = batch_for(st, kind)
        with torch.no_grad(): tl, ta = m(*[b[n] for n in names])
        feed = {n: b[n].numpy() for n in names}
        t = time.time(); ol, oa = sess.run(None, feed); ms.append((time.time() - t) * 1000)
        k = int(b["marker_mask"].sum())
        pt = torch.softmax(tl[0, :k], -1).numpy(); po = np.exp(ol[0, :k] - ol[0, :k].max()); po /= po.sum()
        worst = max(worst, float(np.abs(pt - po).max()))
        print(os.path.basename(p), kind, "torch", np.round(pt, 4).tolist(), "onnx", np.round(po, 4).tolist(), flush=True)
    print(os.path.basename(p), "max prob diff", round(worst, 4), "ms", [round(x) for x in ms], flush=True)
json.dump({"pad_id": agent.tok.pad_token_id, "cfg": agent.cfg,
           "temperature": getattr(agent, "temperature", None),
           "temperature_by_options": getattr(agent, "temperature_by_options", None),
           "lang_temperatures": getattr(agent, "lang_temperatures", None)},
          open(os.path.join(OUT, f"laya-{SUB}.meta.json"), "w"), indent=1, default=str)
agent.tok.save_pretrained(os.path.join(OUT, f"tokenizer-{SUB}"))
print("done", flush=True)
