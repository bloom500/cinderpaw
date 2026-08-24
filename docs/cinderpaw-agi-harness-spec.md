# Cinderpaw Neuro-Symbolic Agent Harness Specification

**Document Version:** 1.0.0  
**Date:** 2026-08-24  
**Target Execution Environment:** Cinderpaw Core (`FeralAgent`), RLM REPL, BRSI (`rsi/`), RAPTOR (`memory/fractal/`), Kaggle ARC Prize 2026 / Local Execution  
**Primary Implementer:** Opus / Feral Engine Engineers  

---

## 1. Executive Summary & Dual-Utility Thesis

This specification defines the architectural expansion for **Cinderpaw** to transition from a single-turn tool-calling agent to a **Neuro-Symbolic System 2 Reasoning Engine**.

While designed to achieve a **65%–80%+ benchmark score on ARC-AGI-3** ($12 cloud execution) and **35%–45%+ on Kaggle's offline private test set** (0 RON on `Qwen 3.8 27B`), **every single component is engineered for dual utility in daily user workflows**.

### Dual-Utility Matrix (ARC-AGI vs. Daily Work)

| Component | ARC-AGI Function | Daily User Workflow Utility |
| :--- | :--- | :--- |
| **1. Scene Graph Perception** | Converts 2D pixel grids into spatial object graphs (bounding boxes, colors, symmetries, alignments). | Converts unstructured UI screenshots, complex PDF layouts, and messy DOM trees into clean semantic object graphs for desktop control and document analysis. |
| **2. DSL Primitives (Domain-Specific Language)** | Provides atomic matrix transformations (`mirror`, `gravity`, `flood_fill`, `crop`). | Provides atomic workflow operations for Git refactoring, CSV/data manipulation, and API orchestration, preventing LLM argument hallucinations and reducing token spend by 80%. |
| **3. MCTS & Active Verifier (System 2 Search)** | Explores multi-hypothesis solution trees and tests hypotheses against counter-examples. | Performs deep code refactoring and bug fixing across multiple files—testing 3–5 parallel approaches in sandbox environments and verifying against test suites before showing diffs to the user. |
| **4. Skill Induction (RAPTOR + BRSI)** | Extracts abstract transformation rules from solved games and saves them to memory. | Learns repetitive user workflows (e.g., "format sprint notes", "parse monthly invoice PDFs") and saves them as reusable DSL tools, making Cinderpaw 10x faster over time. |

---

## 2. System Architecture Map

```text
                               +---------------------------------------+
                               |     USER REQUEST / ARC-AGI TASK       |
                               +---------------------------------------+
                                                   |
                                                   v
                               +---------------------------------------+
                               |  MODULE 1: SCENE GRAPH PERCEPTION     |
                               |  (Grid/UI/Document -> Object Graph)   |
                               +---------------------------------------+
                                                   |
                                                   v
 +---------------------------------------------------------------------------------------------------+
 | MODULE 2 & 3: MCTS SEARCH ENGINE & RLM REPL INTERPRETER                                          |
 |                                                                                                   |
 |   +------------------------+      +------------------------+      +---------------------------+   |
 |   | System 1: LLM Engine   | <--> | Monte Carlo Tree Search| <--> | DSL Primitive Registry    |   |
 |   | (Qwen 27B / DeepSeek)  |      | (MCTS Node Evaluation) |      | (Typed Pure Functions)    |   |
 |   +------------------------+      +------------------------+      +---------------------------+   |
 +---------------------------------------------------------------------------------------------------+
                                                   |
                                                   v
                               +---------------------------------------+
                               | MODULE 4: ACTIVE VERIFIER (ADVERSARY)  |
                               | (Hypothesis Testing & Counter-Examples)|
                               +---------------------------------------+
                                                   |
                                                   v
 +---------------------------------------------------------------------------------------------------+
 | MODULE 5: BRSI RATCHET & RAPTOR MEMORY (SKILL INDUCTION)                                          |
 |                                                                                                   |
 |   +------------------------+      +------------------------+      +---------------------------+   |
 |   | Safety Ratchet         | ---> | FMS / RAPTOR Tree      | ---> | Persisted Reusable Skill  |   |
 |   | (Invariants I1, I2)    |      | (Centroid Clustering)  |      | (Added to User's Toolbox) |   |
 +---------------------------------------------------------------------------------------------------+
```

---

## 3. Detailed Component Specifications

---

### Module 1: Scene Graph Perception (`perception/scene-graph.ts`)

**Purpose:** Convert raw 2D numerical grids or unstructured UI inputs into typed object representations.

#### Data Schema (`types/perception.ts`)

```typescript
export interface SpatialObject {
  id: string;
  color: number | string;
  boundingBox: { x: number; y: number; width: number; height: number };
  pixels: Array<[number, number]>; // [row, col]
  shapeCategory: 'rectangle' | 'line' | 'single_pixel' | 'irregular' | 'frame';
  symmetry: { horizontal: boolean; vertical: boolean; diagonal: boolean };
}

export interface SpatialRelation {
  sourceId: string;
  targetId: string;
  relation: 'inside' | 'adjacent' | 'aligned_horizontally' | 'aligned_vertically' | 'same_color' | 'larger_than';
}

export interface SceneGraph {
  gridDimensions: { rows: number; cols: number };
  objects: SpatialObject[];
  relations: SpatialRelation[];
  dominantColors: Array<{ color: number | string; count: number }>;
}
```

#### Implementation Logic
1. **Connected Component Analysis (CCA):** Group contiguous non-background pixels (8-connectivity) into discrete `SpatialObject` instances.
2. **Feature Extraction:** Compute bounding boxes, pixel counts, aspect ratios, and color distributions per object.
3. **Relation Graph Construction:** Compare object pairs for containment (`inside`), adjacency (`adjacent`), and alignment.
4. **Textual Graph Formatting:** Format the Scene Graph into a compact YAML string (~150 tokens) to replace raw 2D grid arrays in LLM prompts.

---

### Module 2: DSL Primitive Registry (`rlm/dsl/primitives.ts`)

**Purpose:** Expose a deterministic, typed, side-effect-free standard library of primitives to the RLM REPL (`repl.ts`).

#### Core Primitive Categories
1. **Object Manipulation:** `select_by_color(color)`, `select_largest()`, `select_smallest()`, `filter_by_shape(category)`.
2. **Geometric Transformations:** `rotate(grid, angle)`, `mirror(grid, axis)`, `shift(grid, dx, dy)`, `crop(grid, bbox)`.
3. **Color & Pattern Operations:** `recolor(object, new_color)`, `flood_fill(grid, start_pos, color)`, `replace_color(grid, old_color, new_color)`.
4. **Physics & Alignment:** `apply_gravity(grid, direction)`, `align_objects(objects, axis)`.

#### RLM REPL Integration
Inject primitives into the `node:vm` context created in `FeralAgent/src/rlm/repl.ts`:
```typescript
// Bound inside the RLM JS REPL namespace
const DSL = {
  getSceneGraph: (grid) => parseSceneGraph(grid),
  rotate: (grid, deg) => rotateGrid(grid, deg),
  mirror: (grid, axis) => mirrorGrid(grid, axis),
  applyGravity: (grid, dir) => applyGravityGrid(grid, dir),
  recolor: (grid, fromColor, toColor) => recolorGrid(grid, fromColor, toColor),
};
```

---

### Module 3: MCTS Search Engine & Active Verifier (`core/mcts-verifier.ts`)

**Purpose:** Perform tree-search over candidate transformation programs, using an adversarial verifier to filter false positives before returning solutions.

#### MCTS Node Structure
```typescript
export interface MCTSNode {
  id: string;
  parentId: string | null;
  childrenIds: string[];
  visits: number;
  value: number; // Reward score between 0.0 and 1.0
  programCode: string; // JavaScript/DSL code string
  stateResult: any;
}
```

#### Search Algorithm Steps
1. **Selection:** Traverse the tree from root using Upper Confidence Bound applied to Trees (UCT):
   $$\text{UCT} = \frac{Q(s, a)}{N(s, a)} + C \cdot \sqrt{\frac{\ln N(s)}{N(s, a)}}$$
2. **Expansion:** Ask the LLM (via RLM subagent) to propose 3 candidate program mutations for the selected node.
3. **Simulation / Execution:** Execute candidate code inside `FeralAgent/src/rlm/repl.ts`.
4. **Verification (Adversarial Gate):**
   - Run candidate code against all available training examples.
   - If a candidate passes $N-1$ examples but fails on example $N$, generate a **Counter-Example Digest** and feed it back to the expansion prompt.
5. **Backpropagation:** Update visit counts and rewards up the parent chain.

---

### Module 4: Kaggle Offline Adapter (`scripts/arc_kaggle_adapter.py`)

**Purpose:** Provide the standalone I/O harness for offline Kaggle competition execution (`/kaggle/input` $\to$ `/kaggle/working`).

#### Key Adapter Requirements
1. **Offline Zero-Network Enforcement:** Operate without external API calls, interfacing with local `llama.cpp` / `vLLM` server bound to `http://127.0.0.1:8080` (or in-process Bun sidecar).
2. **Read-Only Root Isolation:** Redirect all SQLite / FMS / BRSI journal writes to `/tmp/cinderpaw/`.
3. **Time-Budget Guard:** Enforce a hard 4.5-minute timeout per game environment. If time expires, output the best candidate program found so far.

```python
#!/usr/bin/env python3
"""
ARC Prize 2026 Kaggle Offline Adapter for Cinderpaw
"""
import json
import os
import sys
import time

INPUT_DIR = "/kaggle/input/arc-prize-2026"
OUTPUT_DIR = "/kaggle/working"
MEMORY_DIR = "/tmp/cinderpaw_memory"

def main():
    os.makedirs(MEMORY_DIR, exist_ok=True)
    test_path = os.path.join(INPUT_DIR, "arc-agi_test_challenges.json")
    
    if not os.path.exists(test_path):
        # Fallback to local public set for development
        test_path = "data/arc-agi_test_challenges.json"

    with open(test_path, "r") as f:
        challenges = json.load(f)

    predictions = {}
    print(f"[Cinderpaw Kaggle Adapter] Loaded {len(challenges)} challenges.")

    for game_id, challenge in challenges.items():
        start_time = time.time()
        print(f"--> Solving game {game_id}...")
        
        # Invoke Cinderpaw RLM + MCTS Solver Engine
        # (Pass challenge grid, enforce 270s limit per game)
        pred = solve_game_with_cinderpaw(challenge, timeout=270)
        predictions[game_id] = pred
        
        elapsed = time.time() - start_time
        print(f"--> Game {game_id} finished in {elapsed:.2f}s")

    submission_path = os.path.join(OUTPUT_DIR, "submission.json")
    with open(submission_path, "w") as f:
        json.dump(predictions, f)
    
    print(f"[Cinderpaw Kaggle Adapter] Submission saved to {submission_path}")

def solve_game_with_cinderpaw(challenge, timeout):
    # Simulated prediction format
    return [{"attempt_1": [[0]], "attempt_2": [[0]]}]

if __name__ == "__main__":
    main()
```

---

### Module 5: Skill Induction & RAPTOR Integration

**Purpose:** Persist verified transformation rules into RAPTOR memory for cross-task transfer and lifelong user adaptation.

#### Workflow
1. **Extraction:** When MCTS finds a verified program that passes all test pairs, `FeralAgent/src/memory/fractal/summarize.ts` generates a natural language description + DSL code snippet.
2. **Clustering:** Insert the solution vector into RAPTOR (`tree-builder.ts`). RAPTOR groups similar strategies into macro-centroids (e.g., "Symmetry + Recoloring").
3. **Retrieval in Daily Work:** During normal user desktop tasks or code refactoring, `fractal-recall.ts` queries RAPTOR centroids. If a similar pattern is detected, Cinderpaw executes the saved DSL primitive directly, achieving **10x faster execution and zero token waste**.

---

## 4. Implementation Roadmap for Opus / Feral Engine

- [ ] **Step 1:** Implement `FeralAgent/src/types/perception.ts` and `FeralAgent/src/research/perception/scene-graph.ts` (CCA + bounding box + YAML serialization).
- [ ] **Step 2:** Create `FeralAgent/src/rlm/dsl/primitives.ts` and bind `DSL` into `FeralAgent/src/rlm/repl.ts`.
- [ ] **Step 3:** Implement `FeralAgent/src/core/mcts-verifier.ts` (UCT search loop + adversarial verifier).
- [ ] **Step 4:** Add `grid_match_score` evaluator to Rust sidecar / BRSI ratchet gate (`rsi/l3-code/code-sandbox.ts`).
- [ ] **Step 5:** Create `scripts/arc_kaggle_adapter.py` and test end-to-end dry run on local GPU (`Qwen 3.8 27B`).

---
*This specification is saved in the Cinderpaw repository root as `docs/cinderpaw-agi-harness-spec.md` for release tracking and implementation.*
