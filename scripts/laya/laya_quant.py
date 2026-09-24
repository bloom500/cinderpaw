import os, sys, time, json, numpy as np, onnx, onnxruntime as ort, torch, laya
from laya.common import collate_items
D = sys.argv[1]; src = os.path.join(D, "laya-multilingual.onnx")
agent = laya.load("convaiinnovations/laya", device="cpu", subfolder="multilingual")
names = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
QS = {"noul": {"r": {"type": "noul", "instructions": "Is this memory relevant to answering the question?"}}}
states = [
 {"question": "What temperature do I bake bread at?", "memory": "User bakes sourdough at 230C with steam for the first 20 minutes."},
 {"question": "La ce temperatura coc painea?", "memory": "User bakes sourdough at 230C with steam for the first 20 minutes."},
 {"question": "La ce temperatura coc painea?", "memory": "User's router admin password was changed on Monday."},
 {"question": "When is my car service?", "memory": "User's car is a 2014 Skoda Octavia, next service in March."},
 {"question": "When is my car service?", "memory": "User prefers tabs over spaces in Go code."},
 {"question": "Ce limbaj folosesc la backend?", "memory": "The backend is written in Rust with Axum."},
]
def feed(st):
    internal = {k: agent._to_internal(v) for k, v in QS["noul"].items()}
    b = collate_items([agent._encode_state(st, ["r"], internal)], agent.tok.pad_token_id)
    return {n: b[n].numpy() for n in names}
ref = ort.InferenceSession(src, providers=["CPUExecutionProvider"])
def p1(sess, f):
    l = sess.run(None, f)[0][0, :2]; e = np.exp(l - l.max()); return float((e / e.sum())[1])
base = [p1(ref, feed(s)) for s in states]
print("fp32", [round(x, 4) for x in base], flush=True)
from onnxruntime.quantization import quantize_dynamic, QuantType
mo = onnx.load(src); del mo.graph.value_info[:]; clean = os.path.join(D, "tmp.onnx"); onnx.save(mo, clean)
variants = {}
# per-channel int8 on MatMul, embedding table (Gather) quantized too
head = [n.name for n in mo.graph.node if any(k in n.name for k in ("head", "scorer", "act_head", "type_emb"))]
print("excluding", len(head), "head nodes", flush=True)
variants["enc_mm8"] = dict(per_channel=True, weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"], nodes_to_exclude=head)
for name, kw in variants.items():
    out = os.path.join(D, f"laya-multilingual.{name}.onnx")
    try:
        quantize_dynamic(clean, out, **kw)
        s = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
        t = time.time(); got = [p1(s, feed(x)) for x in states]; ms = (time.time() - t) * 1000 / len(states)
        print(name, os.path.getsize(out) // 1_000_000, "MB", [round(x, 4) for x in got], "maxdiff", round(max(abs(a - b) for a, b in zip(got, base)), 4), "ms", round(ms), flush=True)
    except Exception as e:
        print(name, "FAILED", str(e)[:200], flush=True)
# fp16
try:
    from onnxconverter_common import float16
    m16 = float16.convert_float_to_float16(onnx.load(clean), keep_io_types=True, disable_shape_infer=True, op_block_list=["Cast", "Softmax", "LayerNormalization", "ReduceMean", "Pow", "Sqrt", "Div", "Exp", "Log", "Range", "Shape", "ConstantOfShape", "Where", "Expand", "Equal", "Gather", "GatherElements", "TopK", "ReduceSum", "Neg", "Sub", "Mul", "Add", "Max", "Min", "Clip"])
    out = os.path.join(D, "laya-multilingual.fp16.onnx"); onnx.save(m16, out)
    s = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
    t = time.time(); got = [p1(s, feed(x)) for x in states]; ms = (time.time() - t) * 1000 / len(states)
    print("fp16", os.path.getsize(out) // 1_000_000, "MB", [round(x, 4) for x in got], "maxdiff", round(max(abs(a - b) for a, b in zip(got, base)), 4), "ms", round(ms), flush=True)
except Exception as e:
    print("fp16 FAILED", str(e)[:300], flush=True)
os.remove(clean)
