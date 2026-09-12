/** Historical n=12 diagnostic, NOT a benchmark/SHIP run.
 * Run from the worktree root: bun scripts/fms-attribution.ts
 * Inputs and full private evidence stay in gitignored data/fms-attribution/.
 * Requires a CPU bge-small-en-v1.5-q8_0 llama-server, mean pooling, port 18087.
 * The first run snapshots only the archived tree's 2700 IDs from read-only SQLite.
 * Later runs reuse snapshots and query vectors; never regenerate queries or trees.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { sample } from "../CinderpawAgent/src/memory/fractal/prng.ts";
import { deserializeTree } from "../CinderpawAgent/src/memory/fractal/tree-store.ts";
import { queryTree } from "../CinderpawAgent/src/memory/fractal/tree-query.ts";
import { cosine } from "../CinderpawAgent/src/memory/fractal/cosine.ts";
import { FractalRecallEngine } from "../CinderpawAgent/src/memory/fractal/fractal-recall.ts";
import { recallAtK } from "../CinderpawAgent/src/memory/fractal/bench/metrics.ts";
import type { TreeNode } from "../CinderpawAgent/src/memory/fractal/types.ts";

const dir = "data/fms-attribution";
mkdirSync(dir, { recursive: true });
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
for (const [source, dest] of [
  ["fractal-tree.branch8.bak.json", "tree.json"],
  ["fractal-bench-report.branch8.bak.json", "historical-report.json"],
]) {
  if (!existsSync(`${dir}/${dest}`)) copyFileSync(join(homedir(), ".cinderpaw", "agent", source!), `${dir}/${dest}`);
}
assert.equal(hash(`${dir}/tree.json`),"6e74542f911a18d66af46cf35a519ac23aff4bb497736c176c2e1683b69de662");
assert.equal(hash(`${dir}/historical-report.json`),"11e4f9d86460c946e3b203837d50da57ee46961a618e352b079a5a79c742e3a1");
const envelope = json(`${dir}/tree.json`);
const tree = deserializeTree(envelope.tree);
assert.equal(envelope.leafCount, 2700);
assert.equal(new Set(tree.leafIds).size, 2700);
const historical = json(`${dir}/historical-report.json`);
assert.equal(historical.n, 12);
assert.equal(historical.k, 10);
if (!existsSync(`${dir}/corpus.json`)) {
  const source = new Database(join(homedir(), ".cinderpaw", "agent", "cinderpaw.db"), { readonly: true });
  const rows = source.query(`SELECT id,session_id,timestamp,role,content FROM episodic
    WHERE id IN (${tree.leafIds.map(() => "?").join(",")}) ORDER BY timestamp ASC`).all(...tree.leafIds);
  source.close();
  assert.equal(rows.length, 2700);
  save(`${dir}/corpus.json`, rows);
}
type Row = { id: number; session_id: string; timestamp: number; role: string; content: string };
const rows: Row[] = json(`${dir}/corpus.json`);
assert.equal(hash(`${dir}/corpus.json`),"6290535a3e4d26175b80ec2b1f7ea440795ca351496583a87afe02ff76801147","corpus changed since attribution snapshot");
const byId = new Map(rows.map(r => [r.id, r]));
assert.ok(rows.every(r=>r.session_id.length>0),"empty-session rows would change the exclusion control");
const picked = sample(rows.filter(r => r.content.trim().length >= 20), 12, 1);
assert.deepEqual(picked.map(r => r.id), [1729,21,1470,2647,2613,806,1695,1976,1206,2685,1284,1373]);
const queries = historical.fractal.perQuery.map((q: any, i: number) => ({
  number: i + 1, query: q.query, sourceId: picked[i]!.id, historicalZero: q.recall === 0,
}));
save(`${dir}/reconstructed-queries.json`, queries);
const leafNodes: TreeNode[] = [];
function collect(n: TreeNode) { if (!n.children.length) leafNodes.push(n); else n.children.forEach(collect); }
collect(tree);
assert.equal(leafNodes.length, 2700);
const nodeById = new Map(leafNodes.map(n => [n.leafIds[0]!, n]));
const leavesById = new Map(rows.map(r => [r.id, {
  id:r.id, text:r.content, sessionId:r.session_id, ts:r.timestamp, embedding:nodeById.get(r.id)!.centroid,
}]));
async function embed(texts: string[]) {
  const response = await fetch("http://127.0.0.1:18087/v1/embeddings", {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ input:texts, model:"bge-small" }),
    signal:AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as {data:{index:number;embedding:number[]}[]};
  return body.data.sort((a,b)=>a.index-b.index).map(x => x.embedding);
}
if (!existsSync(`${dir}/vectors.json`)) {
  const calibrationIds = [1,21,806,1206,1470,1976];
  const vectors = await embed(queries.map((q:any)=>q.query));
  const calibration = await embed(calibrationIds.map(id=>byId.get(id)!.content));
  save(`${dir}/vectors.json`, {vectors, calibration:calibrationIds.map((id,i)=>({id,vector:calibration[i]}))});
}
const cached = json(`${dir}/vectors.json`);
assert.equal(cached.vectors.length,12);
assert.ok(cached.calibration.every((c:any)=>cosine(new Float32Array(c.vector),nodeById.get(c.id)!.centroid)>0.9999),"embedder calibration differs from archive");
// Reconstruct historical FTS over exactly these rows, not today's larger DB.
const db = new Database(":memory:");
db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
const insert = db.query("INSERT INTO docs(rowid,content) VALUES (?,?)");
db.transaction(() => { for (const r of rows) insert.run(r.id,r.content); })();
function ftsTerms(query: string) {
  // a0fb2ba:FeralAgent/src/memory/episodic.ts, historical AND-only tokenizer.
  return query.normalize("NFKC").toLowerCase().split(/[\s\p{P}\p{S}]+/u)
    .flatMap(t=>t.split(/[^\p{L}\p{N}_]+/u)).filter(t=>t.length>1).map(t=>`"${t.replace(/"/g, "")}"*`);
}
function fts(query: string, limit: number) {
  const tokens=ftsTerms(query);
  if (!tokens.length) return [];
  return (db.query("SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?").all(tokens.join(" "),limit) as {rowid:number}[])
    .map(x=> { const r=byId.get(x.rowid)!;return {id:r.id,sessionId:r.session_id,timestamp:r.timestamp,role:r.role as "user",content:r.content}; });
}
let embedCalls=0, ftsCalls=0;
const engine = new FractalRecallEngine({tree,leavesById,embed:async()=>{embedCalls++;throw Error("unexpected embed fallback");},
  ftsSearch:(q,k)=>{ftsCalls++;return fts(q,k);}});
const result=[];
for (const q of queries) {
  const vec = new Float32Array(cached.vectors[q.number-1]);
  assert.equal(vec.length,384);
  const base = await engine.rankedLeafIdsWithVec(q.query,vec,"",10);
  const repeat = await engine.rankedLeafIdsWithVec(q.query,vec,"",10);
  assert.deepEqual(base,repeat);
  const exhaustive = leafNodes.map(n=>({id:n.leafIds[0]!,score:cosine(vec,n.centroid)})).sort((a,b)=>b.score-a.score);
  // Change ONLY semantic traversal to exhaustive leaf scoring. Same vectors,
  // semantic top20, FTS, merge boost, session filter, final top10 and gold.
  const merged = new Map(exhaustive.slice(0,20).map(h=>[h.id,{...h,fts:false}]));
  for (const r of fts(q.query,20)) { const h=merged.get(r.id);if(h)h.fts=true;else merged.set(r.id,{id:r.id,score:0,fts:true}); }
  const flat = [...merged.values()].filter(h=>h.fts||h.score>0).sort((a,b)=>(b.score+(b.fts?0.5:0))-(a.score+(a.fts?0.5:0))).slice(0,10).map(h=>h.id);
  const gold=new Set<number>([q.sourceId]);
  const score=(ids:number[])=>recallAtK(ids,gold,10);
  const ftsIds=fts(q.query,10).map(r=>r.id);
  assert.equal(score(base),historical.fractal.perQuery[q.number-1].recall,"historical candidate outcome changed");
  assert.equal(score(ftsIds),historical.fts.perQuery[q.number-1].recall,"historical FTS outcome changed");
  const describe=(ids:number[])=>ids.map(id=>({id,role:byId.get(id)!.role,text:byId.get(id)!.content}));
  result.push({...q,source:byId.get(q.sourceId),base:describe(base),flat:describe(flat),
    baseScore:score(base),flatScore:score(flat),ftsScore:score(ftsIds),sourceVectorRank:exhaustive.findIndex(h=>h.id===q.sourceId)+1,
    semanticIds:queryTree(vec,tree,{topK:20,beam:20}).map(h=>h.leafId),ftsIds:fts(q.query,20).map(r=>r.id),
    ftsSourceMissingTerms:ftsTerms(q.query).filter(term=>!db.query("SELECT rowid FROM docs WHERE docs MATCH ? AND rowid=?").get(term,q.sourceId)),
    // Positive control at the scored interface. This is a scorer intervention,
    // not evidence that an answer model recovered (the bench has no such model).
    sourceInjection:{ids:[q.sourceId,...base.filter(id=>id!==q.sourceId)].slice(0,10),score:score([q.sourceId,...base.filter(id=>id!==q.sourceId)])},
  });
}
assert.equal(embedCalls,0);assert.equal(ftsCalls,24);
// Hand-reviewed evidence substitutions. The judge is the ACTUAL ID scorer;
// no answer-generation stage exists to receive oracle context in this bench.
// Q8's source records the requested URL and 404/500 failure, not search failure.
assert.match(byId.get(1976)!.content,/leaderboard\/monthly\/2025/);
assert.match(byId.get(1976)!.content,/404: Not Found/);
const productHunt=result[7]!;
assert.equal(productHunt.baseScore,0);
assert.equal(productHunt.sourceInjection.score,1);
// Q9: replace ONE returned ID with its byte-identical labelled occurrence.
// Evidence text is invariant; the old scorer's verdict changes solely on ID.
const elements=result[8]!;
const oldIds=elements.base.map(r=>r.id);
assert.equal(oldIds[0],1156);
assert.equal(byId.get(1156)!.content,byId.get(1206)!.content);
const newIds=[1206,...oldIds.slice(1)];
const equivalentIds=rows.filter(r=>r.content===byId.get(1206)!.content).map(r=>r.id);
const interventions={
  productHunt:{queryNumber:8,beforeIds:productHunt.base.map(r=>r.id),afterIds:productHunt.sourceInjection.ids,
    beforeScore:0,afterScore:productHunt.sourceInjection.score,verifiedEvidence:"1976: requested URL, 404 Not Found, page body 500"},
  identicalEvidence:{queryNumber:9,beforeIds:oldIds,afterIds:newIds,textUnchanged:true,
    beforeScore:recallAtK(oldIds,new Set([1206]),10),afterScore:recallAtK(newIds,new Set([1206]),10),equivalentIds,
    multiGoldRecall:recallAtK(oldIds,new Set(equivalentIds),10),anyEquivalentHit:oldIds.some(id=>equivalentIds.includes(id))},
};
assert.equal(interventions.identicalEvidence.beforeScore,0);
assert.equal(interventions.identicalEvidence.afterScore,1);
const evidence={
  provenance:{baseCommit:"487b86bbc661f4c38ad18f74808dd95f6b54d6b2",historicalCodeReference:"a0fb2ba",seed:1,k:10,
    treeBuiltAt:envelope.builtAt,hashes:Object.fromEntries(["tree.json","historical-report.json","corpus.json","vectors.json","bge-small-en-v1.5-q8_0.gguf"].map(p=>[p,hash(`${dir}/${p}`)])),
    codeHashes:Object.fromEntries(["scripts/fms-attribution.ts",... ["fractal-recall.ts","tree-query.ts","cosine.ts","prng.ts","bench/metrics.ts"].map(p=>`CinderpawAgent/src/memory/fractal/${p}`)].map(p=>[p,hash(p)]))},
  calibration:cached.calibration.map((c:any)=>({id:c.id,cosineToArchivedLeaf:cosine(new Float32Array(c.vector),nodeById.get(c.id)!.centroid)})),
  path:{implementation:"FractalRecallEngine.rankedLeafIdsWithVec",embedFallbackCalls:embedCalls,ftsCalls,repeatIdentical:true},interventions,queries:result,
};
save(`${dir}/evidence.json`,evidence);
for(const q of result) console.log(JSON.stringify({number:q.number,source:q.sourceId,historicalZero:q.historicalZero,base:q.baseScore,flat:q.flatScore,vectorRank:q.sourceVectorRank,baseIds:q.base.map(x=>x.id),flatIds:q.flat.map(x=>x.id)}));
console.log(JSON.stringify({calibration:evidence.calibration,path:evidence.path}));
db.close();
