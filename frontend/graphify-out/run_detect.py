import json, sys
from pathlib import Path
from graphify.detect import detect

result = detect(Path('D:/FeralLocalAI/frontend'))
Path('D:/FeralLocalAI/frontend/graphify-out/detect.json').write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False))