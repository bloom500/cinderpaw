# The affective layer: what CinderBrain proved, kept after the code was deleted

**Written 2026-09-17**, when `brain-substrate/` and the FlyWire work were removed.
This is the only thing kept. The code, the connectome packs, the benchmark
results and the 9.7 GB dataset are gone; the findings below cost three sessions
and are the reason the next attempt does not have to repeat them.

The next attempt is a different thing: simulating serotonin and dopamine as
state over the agent's own runtime events, not a simulated brain.

---

## 1. The verdict, and why it is not arguable

E2 was preregistered: the criteria were written and committed **before** the run.
It returned NO on 16 September 2026.

```
V0 true  V1 false  V2 false  V3 true  V4 true
TRANSFORMS false  shuffleInformative false  CONNECTOME_SPECIFIC false
CONTROLLED_PERSISTENCE true  READABLE false  COST false
```

In order of how hard each is to argue with:

1. **The shuffled control did better than the real thing.** The real connectome
   passed 2 effect hypotheses; the same connectome with its wiring shuffled
   passed 3. Whatever signal existed was not connectome-specific, and
   connectome-specific was the claim the entire layer rested on.
2. **A linear baseline already explained it.** The gate wanted the plain
   regression's test R² on the emotion variable to be **below** 0.80. It was
   **0.895**. A linear model over the event sequence predicted the "emotion"
   nearly perfectly with no fly anywhere in it.
3. The residual the baseline missed did not correlate with the connectome's
   output (0.197). There was nothing left for the fly to explain.

## 2. The four lessons that transfer

**A neuromodulator layer does not need a network.** This is lesson 1 restated as
a design instruction. The emotion signal was ~0.895 linear in the sequence of
events that produced it. Serotonin and dopamine over agentic runtime events are
very likely the same shape: a small amount of state, updated per event, with
decay. Start there. If a linear model over the event stream already reproduces
the behaviour you want, a simulator is decoration, and an expensive one.

**A mood that flickers is not a mood.** READABLE failed on two counts: mood
flicker measured 0.73 against a ≤ 0.33 gate, and the separation between the two
readable states was 1 against a ≥ 2 gate. Two consequences for the next attempt,
both design requirements rather than nice-to-haves: the state must be smoothed
or hysteretic enough that a user watching it sees a mood and not noise, and the
distinct states must be far enough apart to be nameable. A continuous number
nobody can put a word to is not a feature.

**Anything in the turn path is sub-second or it is not in the turn path.** COST
failed at p95 6,355 ms against a 1,000 ms gate. Contention made that pessimistic
by design, but not by six times. Peak RSS 424 MB was fine, so memory was never
the problem, latency was. A neuromodulator update has to be arithmetic on a
handful of numbers, not an inference.

**Preregistration is what made this cheap.** Three sessions of work ended in a
clean, defensible NO instead of an argument, because the criteria and the
control arm were written before the numbers existed. The shuffled control is the
single most valuable part of that design: without it the real connectome's
passing scores would have read as a partial success, and the work would have
continued. Any future claim that a biological mechanism helps gets a shuffled or
scrambled control on the first run, not the third.

Related, from the same period: neuro-sounding labels on a system that has not
beaten a baseline are branding, not architecture. Beat the baseline first, name
it after biology second, if at all.

## 3. One harness lesson, not science

The control arm's two shards each finished all 180 sequences and neither wrote a
result, because the cache index was read once per set at start, so shard 0 never
saw shard 1's file. The run looked like a failed control when it was a complete
one that had not been collected. Sharded benchmark runs must re-read shared
state at the point of use, not at start; this is the third time in this repo a
harness bug has produced a number that read as a model failure.
