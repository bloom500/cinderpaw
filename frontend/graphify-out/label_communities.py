import sys, json
from graphify.build import build_from_json
from graphify.cluster import score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from pathlib import Path

extraction = json.loads(Path('D:/FeralLocalAI/frontend/graphify-out/.graphify_extract.json').read_text(encoding="utf-8"))
detection  = json.loads(Path('D:/FeralLocalAI/frontend/graphify-out/detect.json').read_text(encoding="utf-8"))
analysis   = json.loads(Path('D:/FeralLocalAI/frontend/graphify-out/.graphify_analysis.json').read_text(encoding="utf-8"))

G = build_from_json(extraction)
communities = {int(k): v for k, v in analysis['communities'].items()}
cohesion = {int(k): v for k, v in analysis['cohesion'].items()}
tokens = {'input': extraction.get('input_tokens', 0), 'output': extraction.get('output_tokens', 0)}

# Community labels based on analysis
labels = {
    0: "Data Types / Shared Types",
    1: "Tauri Bridge / IPC Layer",
    2: "UI Components",
    3: "Agents Page",
    4: "Models Page",
    5: "App Entry Point",
    6: "Tauri Bridge Module",
    7: "Agents Module",
    8: "Chat Module",
    9: "Models Module",
    10: "Settings Module",
    11: "Library Module",
    12: "Pages Module",
    13: "Standalone Functions",
    14: "Standalone Functions",
    15: "Standalone Functions",
    16: "HTML Entry Point",
    17: "Pages Module",
}

questions = suggest_questions(G, communities, labels)

report = generate(G, communities, cohesion, labels, analysis['gods'], analysis['surprises'], detection, tokens, 'D:/FeralLocalAI/frontend', suggested_questions=questions)
Path('D:/FeralLocalAI/frontend/graphify-out/GRAPH_REPORT.md').write_text(report, encoding="utf-8")
Path('D:/FeralLocalAI/frontend/graphify-out/.graphify_labels.json').write_text(json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False), encoding="utf-8")
print('Report updated with community labels')