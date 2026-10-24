import { afterEach, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CronJobsRepo } from "../src/cron/jobs.ts";
import { CronScheduler } from "../src/cron/scheduler.ts";
import { TaskLimit } from "../src/cron/limit.ts";
import type { CronJobInput } from "../src/types.ts";
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(extra: Record<string, unknown> = {}) {
  const db = openDatabase(":memory:"); databases.push(db); const repo = new CronJobsRepo(db.raw);
  const job = repo.upsert({ name: "Release", task: "Notify me", schedule: {kind:"every",intervalMs:60000}, delivery:{kind:"chat",sessionId:"chat"}, ...extra } as CronJobInput);
  return {db,repo,job};
}
test("watch policy survives edits, defaults to 30-day expiry, and rejects missing proof", () => {
  const {repo,job}=setup({kind:"watch",watch:{sourceUrl:"https://example.com/releases",contains:"Version 3 is available"}});
  expect(job.kind).toBe("watch"); expect(job.expiresAt).toBeGreaterThanOrEqual(job.createdAt+30*86400000);
  expect(repo.upsert({...job,name:"Renamed"}).watch).toEqual(job.watch);
  expect(()=>repo.upsert({...job,watch:undefined})).toThrow();
});
test("watch does not infer or notify until freshly fetched visible source text matches", async () => {
  const {repo,job}=setup({kind:"watch",watch:{sourceUrl:"https://example.com/releases",contains:"Version 3 is available"}});
  let now=job.nextRunMs!; let notifications=0; let inference=0; let body='<html><script>Version 3 is available</script><body>Not yet</body></html>';
  const scheduler=new CronScheduler({repo,now:()=>new Date(now),runJob:async()=>{inference++;return{text:"Model says yes",finished:true}},watchFetch:()=>async()=>({ok:true,status:200,headers:{"content-type":"text/html"},text:async()=>body}),deliver:()=>{notifications++}} as any);
  await scheduler.tick(); expect(inference).toBe(0); expect(notifications).toBe(0); expect(repo.get(job.id)!.history.at(-1)?.status).toBe("waiting");
  now+=60000; body='<html><body>Version 3 is available</body></html>'; await scheduler.tick();
  expect(notifications).toBe(1); expect(repo.get(job.id)!.enabled).toBe(false);
  expect(repo.get(job.id)!.history.at(-1)?.proof).toMatchObject({sourceUrl:job.watch!.sourceUrl,excerpt:"Version 3 is available"});
  await scheduler.tick(); expect(notifications).toBe(1);
});
test("expired watches stop without a request and can renew explicitly",async()=>{
  const {repo,job}=setup({kind:"watch",watch:{sourceUrl:"https://example.com",contains:"Launched"},expiryDays:1});
  let calls=0; const scheduler=new CronScheduler({repo,now:()=>new Date(job.createdAt+2*86400000),runJob:async()=>{calls++;return{text:"yes",finished:true}},watchFetch:()=>async()=>{calls++;throw Error("not reached")}} as any);
  await scheduler.tick(); expect(calls).toBe(0);expect(repo.get(job.id)!.enabled).toBe(false);expect(repo.get(job.id)!.history.at(-1)?.status).toBe("expired");
  const renewed=repo.upsert({...repo.get(job.id)!,expiryDays:30,enabled:true}); expect(renewed.expiresAt).toBeGreaterThan(job.expiresAt!);
});
test("restart catches up a reminder once; a missed repeating agent task waits for its next time, still on",async()=>{
  const {repo,job}=setup({kind:"reminder"});const agent=repo.upsert({name:"Publish",task:"Publish post",schedule:job.schedule,delivery:job.delivery});
  const now=job.nextRunMs!+86400000;let ran:string[]=[];
  const scheduler=new CronScheduler({repo,catchUpOnStart:true,now:()=>new Date(now),runJob:async j=>{ran.push(j.id);return{text:j.task,finished:true}},deliver:()=>{}});
  await scheduler.tick();await scheduler.tick();
  // Closing the app at night must not switch "every weekday at 9" off.
  expect(ran).toEqual([job.id]);expect(repo.get(agent.id)!.enabled).toBe(true);expect(repo.get(agent.id)!.history.at(-1)?.status).toBe("skipped");
  expect(repo.get(agent.id)!.nextRunMs!).toBeGreaterThan(now);
  const second=new CronScheduler({repo,now:()=>new Date(now),runJob:async j=>{ran.push(j.id);return{text:"",finished:true}},deliver:()=>{}});await second.tick();expect(ran).toEqual([job.id]);
});
test("no weekly limit is the default: agent tasks run",async()=>{
  const {db,repo,job}=setup();let calls=0;
  const limit=new TaskLimit(db.raw);expect(limit.view()).toEqual({weeklyUsd:null,asked:false,spentUsd:0});
  const scheduler=new CronScheduler({repo,limit,now:()=>new Date(job.nextRunMs!),runJob:async()=>{calls++;return{text:"",finished:true,costUsd:3}},deliver:()=>{}});await scheduler.tick();
  expect(calls).toBe(1);expect(limit.remaining()).toBe(Infinity);expect(limit.view().spentUsd).toBe(3);
});

test("a claimed occurrence survives restart without replay, and a crash shows no phantom spend",async()=>{
 const {repo,job}=setup({budgetUsd:2}); const at=job.nextRunMs!;
 expect(repo.claimRun(job,at,at+60000)).toBe(true);expect(repo.claimRun(job,at,at+60000)).toBe(false);
 expect(repo.get(job.id)!.spentUsd).toBe(0);
 let executions=0;const resumed=new CronScheduler({repo,catchUpOnStart:true,now:()=>new Date(at+60000),runJob:async()=>{executions++;return{text:"",finished:true}}});await resumed.tick();
 expect(executions).toBe(0);expect(repo.get(job.id)!.enabled).toBe(true);
});
test("a one-off missed while closed is paused, and Resume runs it now",async()=>{
 const {repo}=setup();const due=Date.now()-3600000;
 const once=repo.upsert({name:"Send report",task:"Send the report",schedule:{kind:"at",isoTimestamp:new Date(due).toISOString()},delivery:{kind:"chat",sessionId:"chat"}});
 // A past time is not scheduled on its own; force the state of a run missed while closed.
 (repo as any)["updateAfterRun"](once.id,0,due,{runAt:0,status:"success",durationMs:0},0);
 const missed=repo.get(once.id)!;let executions=0;
 const scheduler=new CronScheduler({repo,catchUpOnStart:true,now:()=>new Date(),runJob:async()=>{executions++;return{text:"Sent",finished:true}},deliver:()=>{}});
 await scheduler.tick();expect(executions).toBe(0);expect(repo.get(missed.id)!.enabled).toBe(false);
 repo.setEnabled(missed.id,true);expect(repo.get(missed.id)!.nextRunMs).not.toBeNull();
});
test("a run that times out is counted against the weekly limit and does not switch a repeating task off",async()=>{
 const {db,repo,job}=setup();const limit=new TaskLimit(db.raw);let stop!:()=>void;
 const scheduler=new CronScheduler({repo,limit,jobTimeoutMs:20,now:()=>new Date(job.nextRunMs!),stopJob:()=>stop(),
   runJob:()=>new Promise(resolve=>{stop=()=>resolve({text:"",finished:false,costUsd:0.4})}),deliver:()=>{}});
 await scheduler.tick();
 const after=repo.get(job.id)!;expect(after.history.at(-1)?.status).toBe("timeout");expect(after.enabled).toBe(true);
 expect(limit.view().spentUsd).toBeCloseTo(0.4);
});
test("a used-up weekly limit skips the next run with a reason on screen, keeps the task, and frees up after 7 days",async()=>{
 const {db,repo,job}=setup();let at=job.nextRunMs!;let executions=0;
 const limit=new TaskLimit(db.raw,()=>at);limit.set(0.5);
 const scheduler=new CronScheduler({repo,limit,now:()=>new Date(at),runJob:async()=>{executions++;return{text:"Done",finished:true,costUsd:0.5}},deliver:()=>{}});
 await scheduler.tick();expect(repo.get(job.id)!.spentUsd).toBe(0.5);at+=60000;await scheduler.tick();
 expect(executions).toBe(1);const last=repo.get(job.id)!;
 expect(last.history.at(-1)?.status).toBe("budget_exceeded");expect(last.history.at(-1)?.result).toContain("weekly limit");expect(last.enabled).toBe(true);
 at+=7*86400000;await scheduler.tick();expect(executions).toBe(2);
});
test("the limit can be raised or removed, and a bad amount is refused",()=>{
 const {db}=setup();const limit=new TaskLimit(db.raw);
 expect(limit.set(10)).toMatchObject({weeklyUsd:10,asked:true});expect(limit.set(null)).toMatchObject({weeklyUsd:null,asked:true});
 for(const bad of [0,-1,NaN,Infinity])expect(()=>limit.set(bad)).toThrow();
});
test("watch HTTP errors cannot become proof and private sources are refused",async()=>{
 const {repo,job}=setup({kind:"watch",watch:{sourceUrl:"https://example.com",contains:"Available"}});
 expect(()=>repo.upsert({...job,watch:{sourceUrl:"https://127.0.0.1/private",contains:"Available"}})).toThrow();
 let notifications=0;const scheduler=new CronScheduler({repo,now:()=>new Date(job.nextRunMs!),runJob:async()=>{throw Error("must not infer")},watchFetch:()=>async()=>({ok:false,status:503,headers:{},text:async()=>"Available",json:async()=>null}),deliver:()=>{notifications++}});
 await scheduler.tick();expect(notifications).toBe(0);expect(repo.get(job.id)!.history.at(-1)?.status).toBe("failed");expect(repo.get(job.id)!.history.at(-1)?.proof).toBeUndefined();
});

test("watch proof excludes hidden subtrees, templates and inline CSS-hidden text", async () => {
  const { verifyWatch } = await import("../src/cron/watch.ts");
  const watch = {sourceUrl:"https://example.com/releases",contains:"Version 3 is available"};
  const fragments = [
    '<div hidden>Version 3 is available</div>',
    '<div hidden="until-found"><span>Version 3 is available</span></div>',
    '<div aria-hidden="true">Version 3 is available</div>',
    '<div style="display: none">Version 3 is available</div>',
    '<div style="DISPLAY : NONE !important"><span>Version 3 is available</span></div>',
    '<div style="visibility: hidden">Version 3 is available</div>',
    '<div style="content-visibility: hidden">Version 3 is available</div>',
    '<template><div>Version 3 is available</div></template>',
    '<noscript>Version 3 is available</noscript>',
    '<style>.release::after{content:"Version 3 is available"}</style>',
    '<!-- Version 3 is available -->',
  ];
  for (const fragment of fragments) {
    const proof=await verifyWatch(watch,async()=>({ok:true,status:200,headers:{"content-type":"text/html"},text:async()=>`<html><body>${fragment}<p>Not released yet</p></body></html>`,json:async()=>null}),1);
    expect(proof,fragment).toBeUndefined();
  }
  const proof=await verifyWatch(watch,async()=>({ok:true,status:200,headers:{"content-type":"text/html"},text:async()=>'<html><body><p aria-hidden="false">Version 3 <strong>is available</strong></p></body></html>',json:async()=>null}),1);
  expect(proof?.excerpt).toBe("Version 3 is available");
});

test("finishing an old agent run preserves an edited schedule and charges its spend", async () => {
  const {repo,job}=setup({budgetUsd:2,schedule:{kind:"every",intervalMs:3600000}});
  const at=job.nextRunMs!; let finish!: (outcome:{text:string;finished:boolean;costUsd:number})=>void;let deliveries=0;
  const scheduler=new CronScheduler({repo,now:()=>new Date(at),runJob:()=>new Promise(resolve=>{finish=resolve}),deliver:()=>{deliveries++}});
  const running=scheduler.tick();
  const edited=repo.upsert({...repo.get(job.id)!,schedule:{kind:"every",intervalMs:120000}});
  finish({text:"Old result",finished:true,costUsd:0.25});await running;
  const settled=repo.get(job.id)!;
  expect(settled.schedule).toEqual(edited.schedule);expect(settled.nextRunMs).toBe(edited.nextRunMs);expect(settled.spentUsd).toBe(0.25);expect(deliveries).toBe(0);
});
test("a watch edited while fetching is not disabled or notified by the old source proof", async () => {
  const {repo,job}=setup({kind:"watch",watch:{sourceUrl:"https://example.com/old",contains:"Available"}});
  let finish!: (value:import('../src/types.ts').CinderpawFetchResponse)=>void;let deliveries=0;
  const scheduler=new CronScheduler({repo,now:()=>new Date(job.nextRunMs!),runJob:async()=>{throw Error("no inference")},watchFetch:()=>()=>new Promise(resolve=>{finish=resolve}),deliver:()=>{deliveries++}});
  const running=scheduler.tick();
  const edited=repo.upsert({...repo.get(job.id)!,watch:{sourceUrl:"https://example.com/new",contains:"Available"}});
  finish({ok:true,status:200,headers:{"content-type":"text/html"},text:async()=>'<p>Available</p>',json:async()=>null});await running;
  const settled=repo.get(job.id)!;expect(settled.enabled).toBe(true);expect(settled.watch).toEqual(edited.watch);expect(settled.nextRunMs).toBe(edited.nextRunMs);expect(deliveries).toBe(0);
});
test("restart never catches up reminders with webhook side effects", async () => {
  const {repo,job}=setup({kind:"reminder",delivery:{kind:"webhook",url:"https://example.com/publish"}});let executions=0;let deliveries=0;
  const scheduler=new CronScheduler({repo,catchUpOnStart:true,now:()=>new Date(job.nextRunMs!+1),runJob:async()=>{executions++;return{text:"Send",finished:true}},deliver:()=>{deliveries++}});
  await scheduler.tick();expect(executions).toBe(0);expect(deliveries).toBe(0);expect(repo.get(job.id)!.enabled).toBe(true);expect(repo.get(job.id)!.history.at(-1)?.status).toBe("skipped");
});

test("task edits and pause advance the revision even when the wall clock does not", () => {
  const {repo,job}=setup();const original=Date.now;
  try {
    Date.now=()=>job.updatedAt;
    const edited=repo.upsert({...job,name:"Changed"});expect(edited.updatedAt).toBeGreaterThan(job.updatedAt);
    repo.setEnabled(job.id,false);expect(repo.get(job.id)!.updatedAt).toBeGreaterThan(edited.updatedAt);
  }finally{Date.now=original;}
});
test("pausing a pending run keeps it paused, records its charge and suppresses delivery", async () => {
  const {repo,job}=setup({budgetUsd:2});let finish!:(value:{text:string;finished:boolean;costUsd:number})=>void;let deliveries=0;
  const scheduler=new CronScheduler({repo,now:()=>new Date(job.nextRunMs!),runJob:()=>new Promise(resolve=>{finish=resolve}),deliver:()=>{deliveries++}});
  const running=scheduler.tick();repo.setEnabled(job.id,false);const paused=repo.get(job.id)!;
  finish({text:"Old answer",finished:true,costUsd:0.2});await running;
  const settled=repo.get(job.id)!;expect(settled.enabled).toBe(false);expect(settled.nextRunMs).toBe(paused.nextRunMs);expect(settled.spentUsd).toBe(0.2);expect(deliveries).toBe(0);expect(settled.history.some(record=>record.status==="running")).toBe(false);
});
