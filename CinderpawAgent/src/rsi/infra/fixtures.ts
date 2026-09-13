/**
 * S3 fixtures (competence plan §2.6a): the task family the first campaign is
 * run on. One coding family, as the parent spec §8 asks: diagnosing and
 * repairing build/configuration failures in small isolated repositories.
 *
 * Deterministic and free, on purpose. A fixture is a tiny repository held
 * in memory (a handful of files), one planted failure, and a verifier that
 * says whether the failure is gone and nothing else broke. No model is
 * called anywhere in this file: spec §11 allows only deterministic fixture
 * runs until a human writes a USD cap, and this machine cannot host a local
 * model. What an arm "learns" here is which repair works on which failure
 * template; that is enough to measure whether learning happens at all (H1)
 * before anyone pays for the version with a model in the loop.
 *
 * Partitions hold out WHOLE templates, not paraphrases (spec §9.1): an arm
 * that trains on `missing-dep` never sees `bad-env-name`, so a score on the
 * promotion partition is transfer to a failure it has not met.
 *
 * Every fixture is generated from a seed, so two arms given the same seed
 * see the same repository and the same planted failure. That is what makes
 * a campaign paired.
 */

import type { FixtureTask, Partition } from "./campaign.ts";

/** A repository: path -> file text. */
export type Repo = Readonly<Record<string, string>>;

/** One repair the agent may try: a named transformation of the repository. */
export interface Repair {
  id: string;
  apply(repo: Repo): Repo;
}

/** A fixture: the broken repo, and the verifier that judges a candidate. */
export interface Fixture extends FixtureTask {
  repo: Repo;
  /** True iff the repository builds and the planted failure is gone. */
  verify(repo: Repo): boolean;
}

/** Mulberry32, same PRNG as the confidence gate: seeds must mean the same
 *  thing everywhere in the campaign. */
export function rngOf(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"] as const;
const DEPS = ["left-pad", "chalk", "dotenv", "zod", "yaml", "semver"] as const;
const ENV_KEYS = ["API_URL", "DB_HOST", "LOG_LEVEL", "PORT", "REGION"] as const;

/** The healthy baseline every fixture is a mutation of. */
function healthyRepo(rng: () => number): { repo: Repo; dep: string; env: string; mod: string } {
  const dep = pick(rng, DEPS);
  const env = pick(rng, ENV_KEYS);
  const mod = pick(rng, NAMES);
  const repo: Repo = {
    "package.json": JSON.stringify({ name: "fix-" + mod, dependencies: { [dep]: "^1.0.0" }, engines: { node: ">=18" } }),
    ".env.example": `${env}=\n`,
    [`src/${mod}.ts`]: `import x from "${dep}";\nexport const run = () => x(process.env.${env});\n`,
    "src/index.ts": `import { run } from "./${mod}.ts";\nrun();\n`,
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "esnext" } }),
  };
  return { repo, dep, env, mod };
}

/**
 * Failure templates: name -> plant + verify. The verifier is a small static
 * checker over the repo, not a build: it resolves imports, checks
 * dependencies against package.json, checks env keys against .env.example,
 * and checks the engine range. Deterministic, milliseconds, no I/O.
 */
export const TEMPLATES = {
  /** A dependency used in code but missing from package.json. */
  "missing-dep": (repo: Repo, ctx: { dep: string }): Repo => {
    const pkg = JSON.parse(repo["package.json"]!);
    delete pkg.dependencies[ctx.dep];
    return { ...repo, "package.json": JSON.stringify(pkg) };
  },
  /** Code reads an env key that .env.example does not declare. */
  "bad-env-name": (repo: Repo, ctx: { env: string }): Repo => ({
    ...repo,
    ".env.example": `${ctx.env}_OLD=\n`,
  }),
  /** An import path that points at a file that does not exist. */
  "broken-import": (repo: Repo, ctx: { mod: string }): Repo => ({
    ...repo,
    "src/index.ts": repo["src/index.ts"]!.replace(`./${ctx.mod}.ts`, `./${ctx.mod}-v2.ts`),
  }),
  /** Engine pinned to a Node that no longer exists. */
  "stale-engine": (repo: Repo): Repo => {
    const pkg = JSON.parse(repo["package.json"]!);
    pkg.engines.node = "<=12";
    return { ...repo, "package.json": JSON.stringify(pkg) };
  },
} as const;
export type Template = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as Template[];

/** The static checker: what "it builds" means for these repositories. */
export function checkRepo(repo: Repo): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  let pkg: { dependencies?: Record<string, string>; engines?: { node?: string } };
  try {
    pkg = JSON.parse(repo["package.json"] ?? "");
  } catch {
    return { ok: false, problems: ["package.json unreadable"] };
  }
  const deps = pkg.dependencies ?? {};
  const envDeclared = new Set(
    (repo[".env.example"] ?? "")
      .split("\n")
      .map((l) => l.split("=")[0]!.trim())
      .filter(Boolean),
  );
  for (const [path, text] of Object.entries(repo)) {
    if (!path.endsWith(".ts")) continue;
    for (const m of text.matchAll(/from "([^"]+)"/g)) {
      const spec = m[1]!;
      if (spec.startsWith("./")) {
        const target = "src/" + spec.slice(2);
        if (!(target in repo)) problems.push(`${path}: import "${spec}" not found`);
      } else if (!(spec in deps)) {
        problems.push(`${path}: "${spec}" not in dependencies`);
      }
    }
    for (const m of text.matchAll(/process\.env\.([A-Z_]+)/g)) {
      if (!envDeclared.has(m[1]!)) problems.push(`${path}: env ${m[1]} not declared in .env.example`);
    }
  }
  const node = pkg.engines?.node ?? "";
  if (/^<=?\s*1[0-6]\b/.test(node)) problems.push(`engines.node "${node}" excludes every supported Node`);
  return { ok: problems.length === 0, problems };
}

/** Generate one fixture: healthy repo, plant `template`, verifier = checkRepo. */
export function makeFixture(template: Template, seed: number): Fixture {
  const rng = rngOf(seed);
  const { repo, dep, env, mod } = healthyRepo(rng);
  const broken = TEMPLATES[template](repo, { dep, env, mod });
  return {
    id: `${template}#${seed}`,
    family: template,
    repo: broken,
    verify: (r) => checkRepo(r).ok,
  };
}

/**
 * The repair catalog: what an arm can try. Each repair is a fix for ONE
 * template and does nothing sensible on the others, so the learning problem
 * is "which repair belongs to which failure", and a wrong guess is a wasted
 * attempt the cost ledger counts.
 */
export const REPAIRS: readonly Repair[] = [
  {
    id: "add-missing-dep",
    apply: (repo) => {
      const pkg = JSON.parse(repo["package.json"]!);
      pkg.dependencies ??= {};
      for (const text of Object.values(repo)) {
        for (const m of text.matchAll(/from "([^".][^"]*)"/g)) if (!(m[1]! in pkg.dependencies)) pkg.dependencies[m[1]!] = "^1.0.0";
      }
      return { ...repo, "package.json": JSON.stringify(pkg) };
    },
  },
  {
    id: "declare-env-keys",
    apply: (repo) => {
      const keys = new Set<string>();
      for (const [p, t] of Object.entries(repo)) if (p.endsWith(".ts")) for (const m of t.matchAll(/process\.env\.([A-Z_]+)/g)) keys.add(m[1]!);
      return { ...repo, ".env.example": [...keys].map((k) => `${k}=`).join("\n") + "\n" };
    },
  },
  {
    id: "fix-import-paths",
    apply: (repo) => {
      const out: Record<string, string> = { ...repo };
      const files = Object.keys(repo).filter((p) => p.startsWith("src/"));
      for (const [p, t] of Object.entries(repo)) {
        if (!p.endsWith(".ts")) continue;
        out[p] = t.replace(/from "\.\/([^"]+)"/g, (whole, rel: string) => {
          if ("src/" + rel in repo) return whole;
          const stem = rel.replace(/\.ts$/, "").replace(/-v\d+$/, "");
          const hit = files.find((f) => f === `src/${stem}.ts`);
          return hit ? `from "./${stem}.ts"` : whole;
        });
      }
      return out;
    },
  },
  {
    id: "bump-engine",
    apply: (repo) => {
      const pkg = JSON.parse(repo["package.json"]!);
      pkg.engines = { node: ">=18" };
      return { ...repo, "package.json": JSON.stringify(pkg) };
    },
  },
];

/**
 * A frozen partition plan: whole templates per partition, so the promotion
 * and final sets are failures the training set never contained. `seeds`
 * are per fixture, distinct from the campaign's paired seeds.
 */
export function partitionedFixtures(
  plan: Readonly<Record<Partition, readonly Template[]>>,
  perTemplate: number,
  seedBase = 1000,
): Record<Partition, Fixture[]> {
  const out = { development: [], promotion: [], final: [], transfer: [] } as Record<Partition, Fixture[]>;
  let n = 0;
  for (const part of Object.keys(plan) as Partition[]) {
    for (const t of plan[part]) for (let i = 0; i < perTemplate; i++) out[part].push(makeFixture(t, seedBase + n++));
  }
  return out;
}
