#!/usr/bin/env python3
"""Cinderpaw bundled LoRA trainer — implements the contract in docs/LORA_TRAINER.md.

Invocation (by Cinderpaw's CliTrainer):
    cinderpaw_lora_trainer finetune --base <gguf path|hf id> --data <pairs.jsonl> --out <dir> [--hyperparam v ...]
    cinderpaw_lora_trainer --version        (fast, no heavy imports)
    cinderpaw_lora_trainer self-test        (no-GPU logic check)

Flow: resolve GGUF base -> HF model id, QLoRA fine-tune (unsloth when
importable, plain transformers+peft otherwise), save PEFT adapter, convert
to <out>/adapter.gguf via llama.cpp's convert_lora_to_gguf.py.

Users-first: written for NVIDIA/CUDA machines. CPU technically runs the
fallback path but is impractical for anything beyond a smoke test.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

VERSION = "cinderpaw-lora-trainer 0.1.0"

# Defaults chosen for a 7B-class base on a single 8GB+ NVIDIA card.
DEFAULTS = {
    "epochs": 2,
    "learning_rate": 2e-4,
    "lora_rank": 16,
    "lora_alpha": 16,
    "batch_size": 1,
    "grad_accum": 8,
    "max_seq_len": 1024,
}

TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]

HF_BASE_ENV = "CINDERPAW_LORA_HF_BASE"
CONVERT_ENV = "CINDERPAW_LORA_CONVERT_SCRIPT"


def log(msg: str) -> None:
    print(f"[cinderpaw-lora-trainer] {msg}", flush=True)


def die(msg: str) -> "NoReturn":  # noqa: F821 - py3.10 compat, annotation only
    print(f"[cinderpaw-lora-trainer] FATAL: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


# ---------------------------------------------------------------- base resolve

def resolve_hf_base(base: str) -> str:
    """Map Cinderpaw's --base (the loaded local GGUF) to a HF model id.

    Order: CINDERPAW_LORA_HF_BASE env override > GGUF metadata > the value
    itself when it isn't a .gguf (already a HF id / local HF dir).
    """
    override = os.environ.get(HF_BASE_ENV, "").strip()
    if override:
        log(f"base resolved from {HF_BASE_ENV}: {override}")
        return override
    if not base.lower().endswith(".gguf"):
        return base
    p = Path(base)
    if p.is_file():
        found = hf_base_from_gguf_metadata(p)
        if found:
            log(f"base resolved from GGUF metadata: {found}")
            return found
    die(
        f"cannot map GGUF '{base}' to a Hugging Face base model. "
        f"Set {HF_BASE_ENV} to the HF repo id the GGUF was converted from "
        f"(e.g. Qwen/Qwen2.5-7B-Instruct) and retry."
    )


def hf_base_from_gguf_metadata(path: Path) -> str | None:
    """Best-effort read of base-model provenance keys newer converters write."""
    try:
        from gguf import GGUFReader  # heavy-ish; only on the finetune path
    except ImportError:
        return None
    try:
        reader = GGUFReader(str(path))
    except Exception:
        return None

    def field_str(key: str) -> str | None:
        f = reader.get_field(key)
        if f is None:
            return None
        try:
            data = f.parts[f.data[0]]
            return bytes(data).decode("utf-8", errors="replace")
        except Exception:
            return None

    url = field_str("general.base_model.0.repo_url")
    if url and "huggingface.co/" in url:
        return url.split("huggingface.co/", 1)[1].strip("/")
    org = field_str("general.base_model.0.organization")
    name = field_str("general.base_model.0.name")
    if org and name:
        return f"{org}/{name.replace(' ', '-')}"
    return None


# ------------------------------------------------------------------- dataset

def load_pairs(data_path: str) -> list[dict]:
    """Read Cinderpaw's JSONL dataset: one {"prompt","response"} object per line."""
    pairs = []
    try:
        with open(data_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                p, r = row.get("prompt"), row.get("response")
                if isinstance(p, str) and isinstance(r, str) and p and r:
                    pairs.append({"prompt": p, "response": r})
    except OSError as e:
        die(f"cannot read dataset {data_path}: {e}")
    if not pairs:
        die(f"dataset {data_path} contains no usable prompt/response pairs")
    return pairs


def format_pair(tokenizer, prompt: str, response: str) -> str:
    """Render one pair through the model's chat template (fallback: plain tags)."""
    try:
        if getattr(tokenizer, "chat_template", None):
            return tokenizer.apply_chat_template(
                [
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": response},
                ],
                tokenize=False,
            )
    except Exception:
        pass
    return f"### User:\n{prompt}\n\n### Assistant:\n{response}"


# ------------------------------------------------------------------ finetune

def parse_hyperparams(extra: list[str]) -> dict:
    hp = argparse.ArgumentParser(add_help=False)
    hp.add_argument("--epochs", "--num-epochs", type=float, default=DEFAULTS["epochs"])
    hp.add_argument("--learning-rate", "--lr", type=float, default=DEFAULTS["learning_rate"])
    hp.add_argument("--lora-rank", "--rank", "-r", type=int, default=DEFAULTS["lora_rank"])
    hp.add_argument("--lora-alpha", type=int, default=DEFAULTS["lora_alpha"])
    hp.add_argument("--batch-size", type=int, default=DEFAULTS["batch_size"])
    hp.add_argument("--grad-accum", type=int, default=DEFAULTS["grad_accum"])
    hp.add_argument("--max-seq-len", type=int, default=DEFAULTS["max_seq_len"])
    hp.add_argument("--no-4bit", action="store_true")
    ns, unknown = hp.parse_known_args(extra)
    # Contract: hyperparameters are open-ended — unknown flags must never
    # crash a training cycle Cinderpaw queued. Warn and continue.
    if unknown:
        log(f"ignoring unknown hyperparameters: {' '.join(unknown)}")
    return vars(ns)


def load_model(hf_base: str, hp: dict):
    """Load base + wrap in LoRA. Unsloth when available, else transformers+peft.

    Returns (model, tokenizer, backend_name).
    """
    load_4bit = not hp["no_4bit"]
    try:
        from unsloth import FastLanguageModel

        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=hf_base,
            max_seq_length=hp["max_seq_len"],
            load_in_4bit=load_4bit,
        )
        model = FastLanguageModel.get_peft_model(
            model,
            r=hp["lora_rank"],
            lora_alpha=hp["lora_alpha"],
            target_modules=TARGET_MODULES,
            lora_dropout=0.0,
            bias="none",
            use_gradient_checkpointing="unsloth",
        )
        return model, tokenizer, "unsloth"
    except ImportError:
        log("unsloth not importable — falling back to transformers+peft")

    import torch
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(hf_base)
    kwargs: dict = {"torch_dtype": "auto"}
    if load_4bit and torch.cuda.is_available():
        from transformers import BitsAndBytesConfig

        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
        )
        kwargs["device_map"] = "auto"
    model = AutoModelForCausalLM.from_pretrained(hf_base, **kwargs)
    if "quantization_config" in kwargs:
        model = prepare_model_for_kbit_training(model)
    model = get_peft_model(
        model,
        LoraConfig(
            r=hp["lora_rank"],
            lora_alpha=hp["lora_alpha"],
            target_modules=TARGET_MODULES,
            lora_dropout=0.0,
            bias="none",
            task_type="CAUSAL_LM",
        ),
    )
    return model, tokenizer, "transformers+peft"


def find_convert_script() -> Path:
    """convert_lora_to_gguf.py: env override, else the llama.cpp clone the
    setup script places next to this file."""
    override = os.environ.get(CONVERT_ENV, "").strip()
    candidates = [Path(override)] if override else []
    here = Path(__file__).resolve().parent
    candidates.append(here / "llama.cpp" / "convert_lora_to_gguf.py")
    for c in candidates:
        if c.is_file():
            return c
    die(
        "convert_lora_to_gguf.py not found — re-run scripts/setup-lora-trainer "
        f"(installs a llama.cpp checkout next to the trainer) or set {CONVERT_ENV}."
    )


def cmd_finetune(args: argparse.Namespace, extra: list[str]) -> None:
    hp = parse_hyperparams(extra)
    hf_base = resolve_hf_base(args.base)
    pairs = load_pairs(args.data)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    log(f"base={hf_base} pairs={len(pairs)} out={out_dir}")

    import torch

    if not torch.cuda.is_available():
        log("WARNING: no CUDA device — training on CPU will be extremely slow")

    model, tokenizer, backend = load_model(hf_base, hp)
    log(f"backend={backend}")
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    from datasets import Dataset
    from transformers import (
        DataCollatorForLanguageModeling,
        Trainer,
        TrainingArguments,
    )

    texts = [format_pair(tokenizer, p["prompt"], p["response"]) for p in pairs]

    def tokenize(batch):
        return tokenizer(
            batch["text"],
            truncation=True,
            max_length=hp["max_seq_len"],
        )

    ds = Dataset.from_dict({"text": texts}).map(tokenize, batched=True, remove_columns=["text"])

    trainer = Trainer(
        model=model,
        train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
        args=TrainingArguments(
            output_dir=str(out_dir / "checkpoints"),
            num_train_epochs=hp["epochs"],
            per_device_train_batch_size=hp["batch_size"],
            gradient_accumulation_steps=hp["grad_accum"],
            learning_rate=hp["learning_rate"],
            logging_steps=5,
            save_strategy="no",
            report_to=[],
            bf16=torch.cuda.is_available() and torch.cuda.is_bf16_supported(),
            fp16=torch.cuda.is_available() and not torch.cuda.is_bf16_supported(),
        ),
    )
    result = trainer.train()

    peft_dir = out_dir / "peft-adapter"
    model.save_pretrained(str(peft_dir))
    log(f"PEFT adapter saved: {peft_dir}")

    # Contract metrics — captured by Cinderpaw for the human review card.
    losses = [e["loss"] for e in trainer.state.log_history if "loss" in e]
    if losses:
        print(f"metric:loss={losses[-1]}", flush=True)
    print(f"metric:pairs={len(pairs)}", flush=True)
    print(f"metric:train_runtime={result.metrics.get('train_runtime', 0.0)}", flush=True)

    convert_to_gguf(peft_dir, hf_base, out_dir / "adapter.gguf")


def convert_to_gguf(peft_dir: Path, hf_base: str, out_file: Path) -> None:
    script = find_convert_script()
    cmd = [
        sys.executable,
        str(script),
        str(peft_dir),
        "--base-model-id",
        hf_base,
        "--outfile",
        str(out_file),
        "--outtype",
        "f16",
    ]
    log(f"converting: {' '.join(cmd)}")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-8:]
        die("GGUF conversion failed:\n" + "\n".join(tail))
    if not out_file.is_file():
        die(f"conversion reported success but {out_file} is missing")
    log(f"adapter written: {out_file} ({out_file.stat().st_size} bytes)")


# ------------------------------------------------------------------ self-test

def cmd_self_test() -> None:
    """No-GPU check of the pure logic. Fails loudly on regression."""
    import tempfile

    hp = parse_hyperparams(["--epochs", "3", "--lora-rank", "8", "--mystery-flag", "7"])
    assert hp["epochs"] == 3.0 and hp["lora_rank"] == 8, hp
    assert hp["learning_rate"] == DEFAULTS["learning_rate"]

    # non-gguf base passes through untouched
    assert resolve_hf_base("Qwen/Qwen2.5-7B-Instruct") == "Qwen/Qwen2.5-7B-Instruct"
    os.environ[HF_BASE_ENV] = "org/override"
    assert resolve_hf_base("whatever.gguf") == "org/override"
    del os.environ[HF_BASE_ENV]

    with tempfile.TemporaryDirectory() as td:
        ds = Path(td) / "d.jsonl"
        ds.write_text(
            '{"prompt":"hi","response":"hello"}\n'
            "not json\n"
            '{"prompt":"","response":"x"}\n'
            '{"prompt":"a","response":"b"}\n',
            encoding="utf-8",
        )
        pairs = load_pairs(str(ds))
        assert len(pairs) == 2, pairs

    class NoTemplate:
        chat_template = None

    text = format_pair(NoTemplate(), "P", "R")
    assert "P" in text and "R" in text and "Assistant" in text

    print("self-test OK", flush=True)


# ---------------------------------------------------------------------- main

def main() -> None:
    argv = sys.argv[1:]
    if "--version" in argv:
        print(VERSION)
        return
    parser = argparse.ArgumentParser(prog="cinderpaw_lora_trainer")
    sub = parser.add_subparsers(dest="cmd", required=True)
    ft = sub.add_parser("finetune")
    ft.add_argument("--base", required=True)
    ft.add_argument("--data", required=True)
    ft.add_argument("--out", required=True)
    sub.add_parser("self-test")
    args, extra = parser.parse_known_args(argv)
    if args.cmd == "self-test":
        cmd_self_test()
    else:
        cmd_finetune(args, extra)


if __name__ == "__main__":
    main()
