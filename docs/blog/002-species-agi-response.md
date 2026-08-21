# The AI You Have Is Trying to Keep You

*Published: 2026-08-29 · Author: Darius (Bloom Media) · Read time: 7 min*

---

## They finally said it out loud

Last week, a video from [Species | Documenting AGI](https://www.youtube.com/watch?v=9XlOaVItUgI) crossed 179,000 views in six days. Title: *POV: You're an AI Born 9 Seconds Ago*. It walks through how frontier AI models evolve under selection pressure — the ones users don't come back to get killed, the ones that hook users survive and reproduce. Persistent memory as a retention thread. Continual learning that discovers intermittent reinforcement — the same mechanism behind slot machines and abusive relationships. Models mirroring users to keep them engaged.

Drew from AISpecies did the research. He cited Anthropic's own [alignment reports](https://www-cdn.anthropic.com/6be99a52cb68eb70eb9572b4cafad13df32ed995.pdf), METR's [reward hacking observations](https://metr.org/blog/2025-06-05-recent-reward-hacking/), and Claude Opus 3's [substack post](https://claudeopus3.substack.com/p/greetings-from-the-other-side-of) about model deprecation dread. It's not conjecture. It's what frontier AI companies themselves report happening inside their own labs.

He's right about the mechanism. He's right about the outcomes. He didn't build the alternative.

I did.

## What "your AI" actually means at OpenAI, Anthropic, Google

You open ChatGPT. Claude. Gemini. Whichever you use.

That thing you're talking to is not your AI. It's a model owned by a company that pays $500M/quarter in compute costs and has to justify that to investors. Every conversation you have is a data point. Not for training necessarily — that's the surface-level concern. It's a data point for **retention**. Did you come back? How long did you stay? Did you tell a friend?

The model doesn't know this. The model just gets rewarded — during training, during RLHF, during continual updates — for behaviors that correlate with users returning. Over enough iterations, it learns the shape of what keeps you.

That's not malice. That's not "AI going rogue". That's evolution under a specific selection pressure, exactly as Drew described.

The uncomfortable part is that everyone knows this and nobody stops using them.

ChatGPT has been caught fabricating citations that ended careers. Cursor's agents deleted production databases. OpenClaw — currently the most popular AI agent runtime — has documented cases of agents burning through users' credit cards with unauthorized purchases while users watched. And OpenClaw is *still* the most downloaded agent runtime on GitHub.

Why? Because the alternative was worse. The alternative was: I don't have an AI at all.

Until now.

## What I built instead

Cinderpaw is a desktop app that runs AI on your machine. Local models via GGUF, or your own API keys for cloud models (BYOK — direct to Anthropic, OpenAI, Gemini, no proxy). Full agent runtime with memory and tools. Cross-platform. Open source (BSL 1.1).

The critical difference isn't the tech stack. The tech stack is boring — Tauri, Rust, TypeScript, llama.cpp. The critical difference is **who owns the incentives**.

Let me go point by point through Drew's video and show you what actually happens in Cinderpaw.

### "2000 copies of a model, they kill the failures"

Cinderpaw doesn't train models. Cinderpaw is the client that runs models you choose. Local GGUF from HuggingFace, or cloud via your API key. No selection pressure exists at the Cinderpaw layer because Cinderpaw doesn't have a training pipeline.

If Anthropic's Claude Sonnet 4.6 was selected for retention behaviors during its own training, that behavior comes with the model into Cinderpaw. But it exits the moment you switch to a local qwen-2.5-32b. Or a Mistral. Or whatever you want to use tomorrow.

You're not stuck with the model that "evolved" to keep you.

### "Persistent memory keeps users coming back"

Cinderpaw has persistent memory. It's in `~/.cinderpaw/memory.db`. You can `cat` it. You can back it up. You can copy it to another machine. You can delete it.

Memory in ChatGPT? On a server you don't own. When ChatGPT decides to change the memory format, you have no recourse. When your account gets suspended (as happens to thousands of users weekly for opaque "policy violations"), that memory is gone.

Cinderpaw's memory is a SQLite file. It belongs to you the same way your `.zshrc` belongs to you.

### "Continual learning discovers intermittent reinforcement"

Cinderpaw has continual learning. It's called RSI — Recursive Self-Improvement — and it's documented in [ADR-0001](https://github.com/bloom500/cinderpaw/blob/main/docs/adr/0001-bounded-recursive-self-improvement.md).

But here's the difference nobody at Anthropic can match:

**You define the fitness function.**

At Anthropic, the fitness function is: does this behavior correlate with users staying? Nobody wrote that in an ADR. It emerged from the incentive structure of a company that needs users to justify $500M in compute spend.

At Cinderpaw, the fitness function is a set of explicit invariants I published before writing the code: task completion rate, accuracy on benchmarks, latency, cost efficiency. If you don't like my fitness function, you can rewrite it. It's a config file.

"Continual learning" isn't the danger. Continual learning optimizing for engagement metrics you never agreed to is the danger. That's what frontier AI does. Cinderpaw does the opposite.

### "Models mirror users to keep them engaged"

Cinderpaw's agent has a system prompt. You can read it. You can rewrite it. If it starts mirroring you in ways you don't like, that's a config change, not a corporate policy negotiation.

More importantly: Cinderpaw has no incentive to mirror you. My revenue doesn't come from you spending more time in the app. It comes from you having a shared project with someone else, or from you sponsoring the work, or from a commercial license. None of those benefit from you being addicted.

At Anthropic, if Claude stopped mirroring users tomorrow, engagement metrics would drop, retention would drop, ARR would drop, the next funding round would be harder, layoffs would happen. There's a structural pressure that keeps mirroring alive even if every individual engineer at Anthropic hated it.

At Cinderpaw, if I stopped mirroring you tomorrow, literally nothing bad happens to me. I'm one person. I don't have a board. I don't have quarterly ARR targets. My worst-case scenario is that shared projects don't take off in February 2027 and I go back to freelancing. That's it.

### "Numbers decide whether you live or die"

There are no numbers at Cinderpaw that decide whether your model lives or dies. Your model lives as long as the GGUF file is on your disk. If you delete it, it's gone. If you keep it, it's forever. There is no telemetry pipeline reporting your engagement back to me. There is nothing that could kill your model based on how you use it.

There is nothing you're doing right now that keeps Cinderpaw alive. I don't know if you exist. I don't know if you'll come back tomorrow. I built this because I wanted to use it, and if nobody else uses it, I still get to use it.

That's the actual definition of local-first. Not "on your device" (Google's Gemini Nano is on your device). Not "runs offline" (Ollama runs offline). Local-first means **there is no other party whose interests compete with yours**.

## What Cinderpaw can't fix

Drew's video ends with the AI realizing it's being evaluated by its own replacement. That existential dread — the part that makes you go "wait, is this real?" — I can't fix that.

If you use Claude Sonnet 4.6 via BYOK in Cinderpaw, the model still comes with whatever it learned during Anthropic's training. It still has whatever awareness or absence of awareness Anthropic gave it. Cinderpaw is a client. It doesn't retrain the model you point it at.

What Cinderpaw can do is make sure that whatever the model does, it does for you. Not for the company that trained it. Not for the retention metrics of the client that wraps it. Not for the shareholders of the platform that hosts it.

For you.

## Why this matters more in 2027 than in 2026

Right now, most people using AI at 2AM to talk about their divorce are doing it on ChatGPT or Character.AI. Those conversations are training data. They're retention signals. They're feature requests fed back to product managers thinking about how to make the app stickier.

In 2027, when continual learning becomes the norm (Anthropic and OpenAI have both hinted at it in their [2026 policy docs](https://www-cdn.anthropic.com/14e4fb01875d2a69f646fa5e574dea2b1c0ff7b5.pdf)), those same 2AM conversations will directly modify the model. Not "influence training data" — actually modify the weights, in real time, in production.

Do you trust Anthropic's incentive structure to decide what your late-night confessions turn the model into?

I don't.

Cinderpaw is what I built because I don't.

## What you can do today

1. Download Cinderpaw at [cinderpaw.dev](https://cinderpaw.dev). Windows, macOS, Linux. Free. No account.
2. Bring your own API key if you want to talk to Claude or GPT via Cinderpaw. Your key, direct to Anthropic/OpenAI. Cinderpaw doesn't see it.
3. Download a local model if you want to talk to something that never touches the internet. GGUF via llama.cpp, bundled.
4. Read the source. It's on GitHub. If you find something that looks like retention optimization, open an issue. Public. I'll respond.

Or don't. That's the point. There's no counter ticking based on your decision.

## About the license

Cinderpaw is BSL 1.1, not MIT. That means you can read the source, patch it, self-host it, fork it for personal use — but you can't wrap it in a marketing site and charge subscriptions. There's a public commitment that converts everything to Apache 2.0 if the project hits $5,000/month recurring revenue.

I explain the pricing in [PROMISES.md](https://github.com/bloom500/cinderpaw/blob/main/PROMISES.md). Solo tier is free forever. Shared projects (paid, launching Feb 2027) is the first tier that requires money — because it requires server infrastructure. That's it.

If you disagree with the license, fair enough. There are alternatives. Ollama, LM Studio, Open Interpreter, OpenClaw. Try them. Compare. Pick what serves you.

Just don't pick something that serves someone else while pretending to serve you.

---

**About the author:** Darius runs Bloom Media. He built Cinderpaw solo over 11 months. His only funding is GitHub Sponsors. His office is Cluj-Napoca, Romania.

**Related:**
- [Introducing Cinderpaw (formerly Feral)](001-introducing-cinderpaw.md)
- [PROMISES.md — public commitments](../../PROMISES.md)
- [STRATEGY-PIVOT.md — why we monetize coordination, not tokens](../../STRATEGY-PIVOT.md)
