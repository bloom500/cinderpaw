# 🐺 Feral

> **The Alpha for Local Autonomous Agents.** A premium, ultra-fast, native desktop application designed to build, manage, and execute autonomous local agent workflows with zero server costs and absolute privacy.

Built entirely on a high-performance native stack: **Rust (Tauri v2)** + **Leptos (WASM)** + **Tailwind CSS**.

---

## ⚡ Why Feral?

Most AI agent interfaces are heavy, sluggish Electron wrappers that leak your data to third-party cloud APIs and drain your machine's resources. Feral flips the script. By combining the safety and raw speed of Rust with local inference engines, Feral runs seamlessly on consumer hardware, transforming your computer into a local operations center for digital workers.

### 🚀 Core Pillars

* **Zero AI Slop UX:** A highly structural, minimalist dashboard designed heavily around elite developer workflows (inspired by Linear and Vercel aesthetics).
* **1-Click Local Onboarding:** No Docker, no complex WSL/Terminal configurations. Connect natively to local inference runtimes (Ollama/Llama.cpp) and download optimized quantized GGUF models directly inside the app.
* **Privacy-First & Offline-Ready:** Your data, agent memory, and task logs never leave your hardware. Zero server latency, zero api subscription fees.
* **Agentic Sovereignty:** Engineered to natively wrap and orchestrate advanced agent structures—such as **Nous Hermes Agent**—giving local models tool-execution capabilities, autonomous skill loops, and persistent cross-session memory.

---

## 🛠️ The Tech Stack

Feral is written from the ground up to guarantee a sub-20MB binary size, near-instant startup times, and minimal RAM usage.

* **Backend:** Rust (Tauri v2) — handles local process management, native OS access, resource monitoring (`sysinfo`), and secure sandbox network requests via `reqwest`.
* **Frontend:** Leptos Framework (WebAssembly) — reactive, highly performant UI compilation with zero JavaScript overhead.
* **Styling:** Tailwind CSS — micro-interaction padding, sharp monolithic dark theme layouts.
* **Model Integration:** High-speed local REST bridge to Ollama/Llama.cpp APIs and seamless Model Downloader powered by the public Hugging Face Hub API.

---

## 🗺️ Roadmap & Current Status

- [x] **Core UI Shell:** High-fidelity dark mode dashboard with live hardware metric telemetry (CPU/GPU/VRAM).
- [ ] **HuggingFace Native Explorer:** Direct model discovery and chunked asynchronous GGUF downloader with live progress events.
- [ ] **Nous Hermes Core Integration:** Programmatic setup and background lifecycle management of the autonomous Hermes runtime as a Tauri Sidecar.
- [ ] **Local Tool Execution Sandbox:** Giving local agents secure file, terminal, and browser scraping capabilities locally.

---

## 🤝 Next Steps & Collaborations

Feral is currently in active development. We aim to become the definitive desktop distribution channel for the open-source agent ecosystem. If you are building foundational agent runtimes like **Nous Hermes**, let's bridge the gap between complex terminal architectures and a smooth, production-grade desktop experience.

*Developed with 💜 by a Builder for Builders.*
