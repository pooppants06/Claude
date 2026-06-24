import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fetchPolymarketEvent } from "./src/sources/polymarket/gamma.js";
import { fetchNorskTippingOddsen } from "./src/sources/norsktipping/oddsen.js";
import { compareMarkets } from "./src/compare/compare.js";
import { shinProbabilities } from "./src/normalize/shin.js";
import { teamKey } from "./src/normalize/teams.js";
const EXTRA:Record<string,string>={ivorycoast:"cotedivoire",czechrepublic:"czechia",turkey:"turkiye",capeverde:"caboverde"};
const norm=(s:string)=>{const k=teamKey(s);return EXTRA[k]??k;};
const pairKey=(a:string,b:string)=>[norm(a),norm(b)].sort().join("|");
const mean=(x:number[])=>x.reduce((a,b)=>a+b,0)/x.length;

// Build OA canonical Shin odds for one event from its bookmakers (bulk + per-event)
function buildEventOA(books:any[],home:string,away:string){
  const nH=norm(home),nA=norm(away);
  const side=(name:string)=>{const k=norm(name);return k===nH?"HOME":k===nA?"AWAY":null;};
  const acc:Record<string,Record<string,number[]>>={};
  const add=(key:string,sel:string,p:number)=>{((acc[key]??={})[sel]??=[]).push(p);};
  for(const b of books||[])for(const m of b.markets||[]){
    const oc=m.outcomes||[];
    if(m.key==="h2h"||m.key==="h2h_h1"){const per=m.key==="h2h_h1"?"#1H":"";
      const h=oc.find((o:any)=>side(o.name)==="HOME"),a=oc.find((o:any)=>side(o.name)==="AWAY"),d=oc.find((o:any)=>o.name==="Draw");
      if(h?.price>1&&a?.price>1&&d?.price>1){add("MATCH_WINNER"+per,"HOME",h.price);add("MATCH_WINNER"+per,"DRAW",d.price);add("MATCH_WINNER"+per,"AWAY",a.price);}}
    else if(m.key==="totals"||m.key==="alternate_totals"||m.key==="totals_h1"){const per=m.key==="totals_h1"?"#1H":"";
      const byLine:Record<string,any>={};for(const o of oc){(byLine[o.point]??={})[String(o.name).toLowerCase()]=o.price;}
      for(const [pt,ou] of Object.entries(byLine) as any){if(ou.over>1&&ou.under>1){const k=`TOTAL_GOALS@${Number(pt)}`+per;add(k,"OVER",ou.over);add(k,"UNDER",ou.under);}}}
    else if(m.key==="btts"){const y=oc.find((o:any)=>/yes/i.test(o.name)),n=oc.find((o:any)=>/^no$/i.test(o.name));
      if(y?.price>1&&n?.price>1){add("BTTS","YES",y.price);add("BTTS","NO",n.price);}}
  }
  const out:Record<string,Record<string,{shinOdds:number,n:number}>>={};
  for(const [key,sels] of Object.entries(acc)){
    const sk=Object.keys(sels); if(sk.length<2)continue;
    const decs=sk.map(k=>mean(sels[k])); const shin=shinProbabilities(decs);
    const n=Math.min(...sk.map(k=>sels[k].length));
    out[key]={}; sk.forEach((k,i)=>out[key][k]={shinOdds:1/shin[i]!,n});
  }
  return out;
}

async function getJson(u:string){try{const r=await fetch(u,{headers:{accept:"application/json"}});if(!r.ok)return null;const t=await r.text();return t.length>2?JSON.parse(t):null;}catch{return null;}}
async function wcSlugs(){let all:any[]=[];for(const off of [0,500]){const b=await getJson(`https://gamma-api.polymarket.com/events?tag_id=102232&closed=false&limit=500&offset=${off}`);if(!b||!b.length)break;all=all.concat(b);if(b.length<500)break;}const re=/^fifwc-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}$/;const seen=new Set<string>();return all.filter(e=>re.test(e.slug||"")&&!seen.has(e.slug)&&seen.add(e.slug)).map(e=>e.slug);}

function buildAllOA(){
  const bulk=JSON.parse(readFileSync("/tmp/oa_bulk.json","utf8"));
  const byPair:Record<string,any>={};
  for(const e of bulk){
    let books=[...(e.bookmakers||[])];
    if(existsSync(`/tmp/oa_ev/${e.id}.json`)){const pe=JSON.parse(readFileSync(`/tmp/oa_ev/${e.id}.json`,"utf8"));books=books.concat(pe.bookmakers||[]);}
    byPair[pairKey(e.home_team,e.away_team)]={home:e.home_team,away:e.away_team,oa:buildEventOA(books,e.home_team,e.away_team)};
  }
  return byPair;
}

async function one(slug:string,oaIdx:Record<string,any>){
  let ev:any;try{ev=await fetchPolymarketEvent(`https://polymarket.com/sports/world-cup/${slug}`);}catch{return [];}
  let nt:any=[];try{nt=await fetchNorskTippingOddsen(ev.meta);}catch{return [];}
  const snap=compareMarkets(ev.meta,[{source:"polymarket",markets:ev.markets,status:"live"},{source:"norsktipping",markets:nt,status:"live"}],{polymarket:"live",norsktipping:"live"});
  const oaEv=oaIdx[pairKey(ev.meta.teams.home,ev.meta.teams.away)];
  if(!oaEv)return [];
  const oaH=norm(oaEv.home), oaA=norm(oaEv.away);
  // The snapshot's HOME/AWAY follow Polymarket's orientation; OA cells are keyed
  // by Odds API's home/away. When the two books disagree on which side is "home"
  // these are reversed, so for match-winner we must join by TEAM IDENTITY, not
  // position. OVER/UNDER/YES/NO are orientation-independent → join by key.
  const oaKeyFor=(mKey:string,s:any):string|null=>{
    if(mKey.startsWith("MATCH_WINNER")){
      if(s.key==="DRAW")return "DRAW";
      const k=norm(s.label);
      if(k===oaH)return "HOME";
      if(k===oaA)return "AWAY";
      return null;
    }
    return s.key;
  };
  const out:any[]=[];
  for(const m of snap.markets){
    if(!m.complete)continue;
    const oaM=oaEv.oa[m.key]; if(!oaM)continue;
    const ntDec=m.selections.map((s:any)=>s.quotes.norsktipping?.decimal??null);
    if(ntDec.some((d:any)=>!(d&&d>1)))continue;
    const ntShin=shinProbabilities(ntDec as number[]);
    m.selections.forEach((s:any,i:number)=>{
      const pm=s.quotes.polymarket?.decimal??null; if(!(pm&&pm>1))return;
      const oaKey=oaKeyFor(m.key,s); if(!oaKey)return;
      const oaCell=oaM[oaKey]; if(!oaCell)return;
      const pmPct=100/pm, oaShinPct=100/oaCell.shinOdds;
      if(Math.min(pmPct,oaShinPct)<2)return;
      const pmSpread=s.quotes.polymarket?.meta?.spread??null; // 0..1 order-book spread
      out.push({title:ev.meta.title,marketLabel:m.label,selectionLabel:s.label,
        pmOdds:pm, ntOdds:ntDec[i], ntShinOdds:1/ntShin[i]!, oaShinOdds:oaCell.shinOdds, oaBooks:oaCell.n,
        pmSpread, pmPct, oaShinPct, ratio:pmPct/oaShinPct});
    });
  }
  return out;
}
async function pool(items:string[],n:number,fn:any){const out:any[]=[];let i=0;async function w(){while(i<items.length){const idx=i++;out[idx]=await fn(items[idx]);}}await Promise.all(Array.from({length:n},()=>w()));return out;}
async function run(){
  const oaIdx=buildAllOA();
  const slugs=await wcSlugs();
  const all=(await pool(slugs,4,(s:string)=>one(s,oaIdx))).flat().filter((r:any)=>r.oaBooks>=2);
  // Opposite direction: Polymarket prices the bet LONGER (less likely) than the
  // consensus → lowest pmPct/oaShinPct ratio first. invRatio = how much more
  // likely the de-vigged market thinks it is than Polymarket.
  all.forEach((r:any)=>{r.invRatio=r.oaShinPct/r.pmPct;});
  all.sort((a:any,b:any)=>a.ratio-b.ratio);
  const top=all.slice(0,40);
  writeFileSync("/tmp/multi/top_opp.json",JSON.stringify({at:Date.now(),top,total:all.length},null,2));
  console.log(`comparable outcomes (PM & OA-Shin, >=2 books): ${all.length}`);
  console.log("TOP 20 (PM odds HIGHEST / least likely vs OA-Shin):");
  top.slice(0,20).forEach((r:any,i:number)=>console.log(`${String(i+1).padStart(2)}. ${r.invRatio.toFixed(2)}x  ${r.title.slice(0,22).padEnd(22)} ${(r.marketLabel+"/"+r.selectionLabel).slice(0,40).padEnd(40)} PM ${r.pmOdds.toFixed(2)} OAshin ${r.oaShinOdds.toFixed(2)} sprd ${r.pmSpread!=null?(r.pmSpread*100).toFixed(1)+"c":"--"} (${r.oaBooks}bk)`));
}
run().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
