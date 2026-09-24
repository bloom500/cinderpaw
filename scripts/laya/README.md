# Laya, measured before integrating (24 Sep 2026)

Laya (convaiinnovations/laya 0.3.20, Apache-2.0) is an open decision model with
the same typed-question format as Jev. These scripts are why it is NOT in the app.

## What works
- ONNX export: `laya_export.py` (needs `torch.onnx.export(dynamo=True)`; the
  legacy tracer bakes the sequence length into the head's attention).
  fp32 ONNX matches torch exactly, 70-170 ms per question on a desktop CPU.
- Weight-only quantization (`laya_wq.py`): 8-bit MatMul + 4-bit embedding
  table, 258 MB, max probability drift 0.045. Activation quantization
  (`quantize_dynamic`, any setting) collapses the encoder to ~0.49 everywhere.

## Why it is not used (zero-shot)
- Memory relevance (`laya_mi.py`, the memory-intrusion set, 30 questions x 50
  facts, chance 10%): precision@3 0.28 EN / 0.12 RO (multilingual), 0.53 EN /
  0.24 RO (English). The shipped recall answers 93%.
- Voice commands (`laya_jev.py`, 46 real call sentences vs Jev's pick):
  4/46 (multilingual) and 12/46 (English) agree; it answers `none` to nearly
  everything, at 1-2 s per sentence.

## What would change the answer
Fine-tuning Laya on our own labelled data (the Jev call log already pairs
sentences with actions), which it supports; or a newer checkpoint. Re-run
these scripts first.
