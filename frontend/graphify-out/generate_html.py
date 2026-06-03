import sys, json
from graphify.build import build_from_json
from graphify.export import to_html
from pathlib import Path

extraction = json.loads(Path('D:/FeralLocalAI/frontend/graphify-out/.graphify_extract.json').read_text(encoding="utf-8"))
analysis   = json.loads(Path('D:/FeralLocalAI/frontend/graphify-out/.graphify_analysis.json').read_text(encoding="utf-8"))
labels_raw = json.loads(Path('D:/FeralLocalAI/frontend/graphify-out/.graphify_labels.json').read_text(encoding="utf-8")) if Path('D:/FeralLocalAI/frontend/graphify-out/.graphify_labels.json').exists() else {}

G = build_from_json(extraction)
communities = {int(k): v for k, v in analysis['communities'].items()}
labels = {int(k): v for k, v in labels_raw.items()}

if G.number_of_nodes() > 5000:
    print(f'Graph has {G.number_of_nodes()} nodes - too large for HTML viz.')
else:
    to_html(G, communities, 'D:/FeralLocalAI/frontend/graphify-out/graph.html', community_labels=labels or None)
    print('graph.html written - open in any browser, no server needed')