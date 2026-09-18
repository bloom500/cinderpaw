/**
 * How much of what memory injects has nothing to do with the question.
 *
 * Every turn, before the model sees anything, `RecallEngine.recall()` builds a
 * `[Memory context]` block and puts it in the prompt. This script measures what
 * is in that block: seed a corpus of synthetic memories across unrelated
 * subjects, ask a question that belongs to exactly one of them, and count the
 * injected lines that come from the other nine.
 *
 * Why synthetic and not his real database: the score needs ground truth. A real
 * corpus can be read and argued about; a generated one KNOWS which fact answers
 * which question, so "irrelevant" is a count and not an opinion.
 *
 * This measures the fallback engine, which is not a corner case: a fresh
 * install has no RAPTOR tree and no embedding model on disk, so this is the
 * path every new user is on, and the path every machine falls back to whenever
 * the tree is stale or embedding fails.
 *
 *   bun scripts/memory-intrusion.ts            # 300 memories, 30 queries
 *   bun scripts/memory-intrusion.ts --n 500
 *   bun scripts/memory-intrusion.ts --json     # machine-readable
 */

import { Database } from "bun:sqlite";
import { migrateForTests } from "../src/db.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { MemoryGraph } from "../src/memory/graph.ts";
import { RecallEngine } from "../src/memory/recall.ts";

/**
 * Ten subjects with no shared vocabulary. That is deliberate: if a word
 * appeared in two subjects, an intrusion could be defended as a near-miss, and
 * the number would stop meaning anything. Here every hit is either the right
 * subject or plainly the wrong one.
 */
interface Subject {
  id: string;
  /** `key: value` pairs, the shape the extractor writes. */
  facts: Array<[string, string]>;
  /** Sentences, the shape episodic stores. */
  events: string[];
  /** Questions a person would actually type. */
  queries: string[];
}

const SUBJECTS: Subject[] = [
  {
    id: "studio",
    facts: [
      ["preferred_daw", "Ableton Live 12, never Pro Tools"],
      ["studio_monitors", "Yamaha HS8 in the small room"],
      ["mixing_reference", "masters at -14 LUFS for streaming"],
      ["vocal_chain", "SM7B into a Cloudlifter"],
      ["session_rate", "180 lei an hour for recording"],
    ],
    events: [
      "We tracked vocals for four hours and the SM7B needed the Cloudlifter to stay clean.",
      "The client asked for the master at -14 LUFS because it was going to Spotify.",
      "Ableton crashed mid-session so the take was recovered from the crash folder.",
    ],
    queries: [
      "which DAW do I use for recording",
      "what loudness do I master at",
      "how much do I charge for a studio session",
    ],
  },
  {
    id: "car",
    facts: [
      ["car_model", "Skoda Octavia 1.6 TDI from 2014"],
      ["oil_type", "5W-30 long life, changed every 15000 km"],
      ["tyre_size", "205/55 R16 winter tyres"],
      ["mechanic", "the garage on Strada Fabricii"],
      ["last_service_km", "192000 km at the last service"],
    ],
    events: [
      "The garage on Strada Fabricii replaced the glow plugs and charged 400 lei.",
      "Winter tyres went on in November, 205/55 R16, stored in the cellar after.",
      "The oil change is due again because the car passed 192000 km.",
    ],
    queries: [
      "what oil does my car take",
      "when is the next service due on the car",
      "what size are my winter tyres",
    ],
  },
  {
    id: "cooking",
    facts: [
      ["bread_hydration", "75 percent hydration sourdough"],
      ["starter_name", "the starter is fed twice a day in summer"],
      ["oven_temp", "bakes at 250C with steam for the first 20 minutes"],
      ["dislikes_food", "cannot stand coriander"],
      ["knife", "a carbon steel gyuto, hand washed only"],
    ],
    events: [
      "The sourdough came out flat because the starter was fed too late the night before.",
      "Steam for the first twenty minutes made the crust much better at 250C.",
      "Coriander ruined the soup for him, again.",
    ],
    queries: [
      "what hydration do I use for bread",
      "what temperature do I bake at",
      "which herb do I hate",
    ],
  },
  {
    id: "tax",
    facts: [
      ["company_form", "an SRL with one employee"],
      ["vat_status", "not VAT registered, under the threshold"],
      ["accountant", "sends the papers on the 20th of each month"],
      ["dividend_plan", "takes dividends once a year in December"],
      ["invoice_term", "invoices are 30 days payment terms"],
    ],
    events: [
      "The accountant needs every invoice by the 20th or the filing slips a month.",
      "Staying under the VAT threshold was the reason for splitting the contract.",
      "Dividends are taken in December so the tax is settled in one go.",
    ],
    queries: [
      "am I VAT registered",
      "when does my accountant need the papers",
      "what payment terms do I put on invoices",
    ],
  },
  {
    id: "gym",
    facts: [
      ["training_split", "push pull legs, four days a week"],
      ["squat_pr", "a 140 kg squat for one rep"],
      ["injury", "left shoulder hurts on overhead press"],
      ["gym_time", "trains at 7 in the morning"],
      ["protein_target", "160 grams of protein a day"],
    ],
    events: [
      "Overhead press was dropped from the session because the left shoulder flared up.",
      "He hit 140 kg on squat for a single and stopped there.",
      "Training at 7 in the morning works better than evenings.",
    ],
    queries: [
      "what is my squat record",
      "which exercise hurts my shoulder",
      "how much protein should I eat",
    ],
  },
  {
    id: "garden",
    facts: [
      ["tomato_variety", "cherry tomatoes in the raised bed"],
      ["watering", "waters at dusk, never at noon"],
      ["soil_ph", "the soil tested slightly acidic"],
      ["pest", "aphids on the roses every June"],
      ["compost", "compost bin turned every two weeks"],
    ],
    events: [
      "Aphids came back on the roses in June and the spray only half worked.",
      "Watering at noon burned the leaves, so it moved to dusk.",
      "The compost bin needs turning every two weeks or it goes anaerobic.",
    ],
    queries: [
      "when should I water the garden",
      "what pest attacks my roses",
      "what did the soil test say",
    ],
  },
  {
    id: "photo",
    facts: [
      ["camera_body", "a Fuji X-T4"],
      ["favourite_lens", "the 35mm f2, on the camera most days"],
      ["raw_workflow", "edits RAW in Capture One, not Lightroom"],
      ["backup_photos", "photos backed up to two drives"],
      ["shoot_style", "shoots available light, hates flash"],
    ],
    events: [
      "The 35mm f2 stayed on the body for the whole trip and nothing else was needed.",
      "Capture One handles the Fuji files better than Lightroom does.",
      "Flash was refused for the portrait session; available light only.",
    ],
    queries: [
      "which lens do I use most",
      "what do I edit my RAW files in",
      "what camera do I own",
    ],
  },
  {
    id: "travel",
    facts: [
      ["passport_expiry", "the passport expires in 2028"],
      ["seat_preference", "always an aisle seat"],
      ["luggage", "travels with cabin baggage only"],
      ["airline_status", "no airline status, books the cheapest"],
      ["travel_insurance", "annual travel insurance, renewed in March"],
    ],
    events: [
      "The aisle seat was worth paying for on the long flight.",
      "Cabin baggage only meant no waiting at the belt after landing.",
      "Travel insurance renews in March and covers the whole year.",
    ],
    queries: [
      "which seat do I book on flights",
      "when does my travel insurance renew",
      "how much luggage do I take",
    ],
  },
  {
    id: "pets",
    facts: [
      ["cat_name", "a grey cat that is eleven years old"],
      ["cat_food", "wet food twice a day, no dry food"],
      ["vet", "the vet visit is every six months"],
      ["cat_meds", "kidney supplement in the evening meal"],
      ["litter", "clumping litter, changed weekly"],
    ],
    events: [
      "The vet said every six months from now on because of the kidney values.",
      "Dry food was stopped completely; wet food twice a day instead.",
      "The supplement goes in the evening meal or it gets refused.",
    ],
    queries: [
      "how often does the cat see the vet",
      "what does the cat eat",
      "when do I give the supplement",
    ],
  },
  {
    id: "network",
    facts: [
      ["router_model", "a Mikrotik router in the hallway"],
      ["isp", "fibre from the local ISP, 1 gigabit"],
      ["nas_backup", "the NAS runs a backup at 3 in the morning"],
      ["vlan_setup", "guest devices on a separate VLAN"],
      ["dns", "runs its own DNS resolver"],
    ],
    events: [
      "Guest devices went on their own VLAN so they cannot see the NAS.",
      "The backup runs at 3 in the morning when nothing else is on the line.",
      "The local resolver made everything faster than the ISP DNS.",
    ],
    queries: [
      "what router do I have",
      "when does the NAS back up",
      "how are guest devices separated",
    ],
  },
];

interface Seeded {
  /** Fact key (as stored) to the subject it belongs to. */
  factSubject: Map<string, string>;
  /** Episodic marker to the subject it belongs to. */
  eventSubject: Map<string, string>;
}

/**
 * Fill the stores until there are `n` facts and `n` events, cycling the
 * subjects and numbering the repeats. The repeats matter: a corpus with five
 * facts per subject never reaches the size where a top-30 cap starts throwing
 * the answer away, which is the failure this is looking for.
 */
function seed(
  semantic: SemanticMemory,
  episodic: EpisodicMemory,
  graph: MemoryGraph,
  db: Database,
  n: number,
): Seeded {
  const factSubject = new Map<string, string>();
  const eventSubject = new Map<string, string>();
  const day = 24 * 60 * 60 * 1000;
  let written = 0;
  let round = 0;

  while (written < n) {
    for (const s of SUBJECTS) {
      for (const [k, v] of s.facts) {
        if (written >= n) break;
        const key = round === 0 ? k : `${k}_${round}`;
        // Oldest first, so the newest rows are an arbitrary subject rather
        // than always the last one in the list.
        const ts = Date.now() - (n - written) * day;
        semantic.upsert(key, v, "", "fact", ts);
        graph.addFact(key, "has", v);
        factSubject.set(key, s.id);
        written++;
      }
    }
    round++;
  }

  let events = 0;
  round = 0;
  while (events < n) {
    for (const s of SUBJECTS) {
      for (const text of s.events) {
        if (events >= n) break;
        const marker = `e${String(events).padStart(4, "0")}`;
        const id = episodic.record(`seed-${s.id}-${round}`, "user", `${marker} ${text}`);
        if (id !== null) {
          db.query("UPDATE episodic SET timestamp = ? WHERE id = ?").run(
            Date.now() - (n - events) * day,
            id,
          );
        }
        eventSubject.set(marker, s.id);
        events++;
      }
    }
    round++;
  }

  return { factSubject, eventSubject };
}

/** One injected line, and where it came from. */
interface Line {
  layer: "semantic" | "graph" | "episodic";
  subject: string | null;
  text: string;
}

/**
 * Take the block apart the way the model reads it: line by line, each one
 * attributed to the subject that produced it. A line we cannot attribute is
 * counted as an intrusion, never quietly dropped.
 */
function parse(context: string, seeded: Seeded): Line[] {
  const out: Line[] = [];
  let layer: Line["layer"] | null = null;
  for (const raw of context.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("Known facts about the user")) { layer = "semantic"; continue; }
    if (line.startsWith("Knowledge graph")) { layer = "graph"; continue; }
    if (line.startsWith("Relevant past exchanges")) { layer = "episodic"; continue; }
    if (line.startsWith("[Memory context]") || line.startsWith("[End memory context]")) continue;
    if (!line.trim() || layer === null) continue;

    if (layer === "semantic") {
      const key = line.replace(/^-\s*/, "").split(":")[0]?.trim() ?? "";
      out.push({ layer, subject: seeded.factSubject.get(key) ?? null, text: line.trim() });
    } else if (layer === "graph") {
      const key = line.trim().split(" —")[0]?.trim() ?? "";
      out.push({ layer, subject: seeded.factSubject.get(key) ?? null, text: line.trim() });
    } else {
      const marker = /\be\d{4}\b/.exec(line)?.[0] ?? "";
      out.push({ layer, subject: seeded.eventSubject.get(marker) ?? null, text: line.trim() });
    }
  }
  return out;
}

export interface IntrusionReport {
  memories: number;
  queries: number;
  injectedLines: number;
  injectedPerQuery: number;
  relevantLines: number;
  precisionPct: number;
  intrusionPct: number;
  /** The honest headline: wrong lines put in front of the model, per turn.
   *  A percentage moves when the block shrinks; this does not. */
  wrongLinesPerQuery: number;
  queriesWithAtLeastOneRelevantLine: number;
  answerRatePct: number;
  byLayer: Record<string, { injected: number; relevant: number; precisionPct: number }>;
  blind: Array<{ query: string; injected: number }>;
}

/** Exported so `tests/memory-intrusion.test.ts` defends the number in CI. */
export function measure(n = 300): IntrusionReport {
  const db = new Database(":memory:");
  migrateForTests(db);
  const audit = () => {};
  const semantic = new SemanticMemory(db, audit);
  const episodic = new EpisodicMemory(db, audit);
  const graph = new MemoryGraph(db);
  const seeded = seed(semantic, episodic, graph, db, n);

  const recall = new RecallEngine(episodic, semantic);
  recall.setGraph(graph);

  const perLayer = {
    semantic: { hit: 0, miss: 0 },
    graph: { hit: 0, miss: 0 },
    episodic: { hit: 0, miss: 0 },
  };
  let injected = 0;
  let relevant = 0;
  let answered = 0;
  let queries = 0;
  const worst: Array<{ query: string; relevant: number; injected: number }> = [];

  for (const s of SUBJECTS) {
    for (const q of s.queries) {
      queries++;
      const { context } = recall.recall(q, "live-session");
      const lines = parse(context, seeded);
      const mine = lines.filter((l) => l.subject === s.id);
      injected += lines.length;
      relevant += mine.length;
      if (mine.length > 0) answered++;
      for (const l of lines) {
        const bucket = perLayer[l.layer];
        if (l.subject === s.id) bucket.hit++;
        else bucket.miss++;
      }
      worst.push({ query: q, relevant: mine.length, injected: lines.length });
    }
  }

  const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);
  const report = {
    memories: n,
    queries,
    injectedLines: injected,
    injectedPerQuery: Math.round((injected / queries) * 10) / 10,
    relevantLines: relevant,
    precisionPct: pct(relevant, injected),
    intrusionPct: pct(injected - relevant, injected),
    wrongLinesPerQuery: Math.round(((injected - relevant) / queries) * 100) / 100,
    queriesWithAtLeastOneRelevantLine: answered,
    answerRatePct: pct(answered, queries),
    byLayer: Object.fromEntries(
      Object.entries(perLayer).map(([k, v]) => [
        k,
        { injected: v.hit + v.miss, relevant: v.hit, precisionPct: pct(v.hit, v.hit + v.miss) },
      ]),
    ),
  };

  return { ...report, blind: worst.filter((w) => w.relevant === 0).map((w) => ({ query: w.query, injected: w.injected })) };
}

function main(): void {
  const argv = Bun.argv.slice(2);
  const n = Number(argv[argv.indexOf("--n") + 1]) || 300;
  const report = measure(n);

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\nMemory intrusion, ${n} memories / ${report.queries} queries (fallback RecallEngine)\n`);
  console.log(`  injected lines per query : ${report.injectedPerQuery}`);
  console.log(`  of those, on subject     : ${report.precisionPct}%`);
  console.log(`  INTRUSION RATE           : ${report.intrusionPct}%`);
  console.log(`  wrong lines per turn     : ${report.wrongLinesPerQuery}`);
  console.log(
    `  queries that got the fact: ${report.answerRatePct}% (${report.queriesWithAtLeastOneRelevantLine}/${report.queries})\n`,
  );
  for (const [layer, v] of Object.entries(report.byLayer)) {
    const r = v as { injected: number; relevant: number; precisionPct: number };
    console.log(
      `  ${layer.padEnd(9)} ${String(r.injected).padStart(4)} lines, ${String(r.relevant).padStart(3)} on subject (${r.precisionPct}%)`,
    );
  }
  if (report.blind.length > 0) {
    console.log(`\n  ${report.blind.length} queries got NOTHING relevant, e.g.:`);
    for (const w of report.blind.slice(0, 5)) {
      console.log(`    "${w.query}" — ${w.injected} lines, 0 useful`);
    }
  }
  console.log("");
}

// Only when run directly; `tests/memory-intrusion.test.ts` imports `measure`.
if (import.meta.main) main();
