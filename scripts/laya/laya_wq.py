import os, sys, time, numpy as np, onnx, onnxruntime as ort
sys.path.insert(0, os.path.dirname(__file__))
D = sys.argv[1]; src = os.path.join(D, "laya-multilingual.onnx")
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer, DefaultWeightOnlyQuantConfig
import laya
from laya.common import collate_items
agent = laya.load("convaiinnovations/laya", device="cpu", subfolder="multilingual")
names = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
states = [
 {"question": "What temperature do I bake bread at?", "memory": "User bakes sourdough at 230C with steam for the first 20 minutes."},
 {"question": "La ce temperatura coc painea?", "memory": "User bakes sourdough at 230C with steam for the first 20 minutes."},
 {"question": "La ce temperatura coc painea?", "memory": "User's router admin password was changed on Monday."},
 {"question": "When is my car service?", "memory": "User's car is a 2014 Skoda Octavia, next service in March."},
 {"question": "When is my car service?", "memory": "User prefers tabs over spaces in Go code."},
 {"question": "Ce limbaj folosesc la backend?", "memory": "The backend is written in Rust with Axum."},
]
Q = {"r": {"type": "noul", "instructions": "Is this memory relevant to answering the question?"}}
def feed(st):
    internal = {k: agent._to_internal(v) for k, v in Q.items()}
    b = collate_items([agent._encode_state(st, ["r"], internal)], agent.tok.pad_token_id)
    return {n: b[n].numpy() for n in names}
def run(path):
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    out = []
    t = time.time()
    for st in states:
        l = s.run(None, feed(st))[0][0, :2]; e = np.exp(l - l.max()); out.append(float((e / e.sum())[1]))
    return out, (time.time() - t) * 1000 / len(states)
base, ms = run(src); print("fp32", [round(x, 4) for x in base], round(ms), flush=True)
mo = onnx.load(src); del mo.graph.value_info[:]
try:
    cfg8 = DefaultWeightOnlyQuantConfig(block_size=128, is_symmetric=True, bits=8, op_types_to_quantize=("MatMul",))
    q = MatMulNBitsQuantizer(onnx.ModelProto.FromString(mo.SerializeToString()), algo_config=cfg8); q.process()
    m8 = q.model.model
    cfg4 = DefaultWeightOnlyQuantConfig(block_size=32, is_symmetric=True, bits=4, op_types_to_quantize=("Gather",))
    q2 = MatMulNBitsQuantizer(m8, algo_config=cfg4); q2.process()
    out = os.path.join(D, "laya-multilingual.w8g4.onnx")
    q2.model.save_model_to_file(out, use_external_data_format=False)
    got, ms = run(out)
    print("w8g4", os.path.getsize(out) // 1_000_000, "MB", [round(x, 4) for x in got],
          "maxdiff", round(max(abs(a - b) for a, b in zip(got, base)), 4), "ms", round(ms), flush=True)
except Exception as e:
    import traceback; traceback.print_exc(); print("w8g4 FAILED", str(e)[:300], flush=True)
