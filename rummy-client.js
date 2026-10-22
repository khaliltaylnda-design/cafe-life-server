// rummy-client.js — واجهة الرامي أونلاين داخل المقهى (ملف خاص بالرامي)
// يتحمّل من index.html بسطر واحد:  <script src="rummy-client.js?v=1"></script>
// يستعمل من index.html: ws, send, seat, sitting, myId, tone — وما يلمس شي آخر (الواجهة في Shadow DOM معزولة).
(function(){
if(window.RummyClient)return;
const CSS=`
:root{--felt:#0f4a2c;--gold:#e7b84b}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:host{all:initial}#app{position:fixed;inset:0;background:#0a3320;color:#fff;font-family:"Segoe UI",Tahoma,system-ui,sans-serif;display:grid;grid-template-rows:1fr auto auto;overflow:hidden;padding-top:env(safe-area-inset-top);direction:rtl}
#table{direction:ltr;display:grid;grid-template-columns:64px 1fr 64px;grid-template-rows:auto 1fr;background:radial-gradient(ellipse at center,#16663b,#0c3d24 80%);min-height:0}
.seat{direction:rtl;text-align:center;font-size:12px;padding:4px;display:flex;flex-direction:column;align-items:center;gap:2px;border-radius:10px;border:2px solid transparent}
.seat.on{border-color:var(--gold);background:#0004}.seat.dead{opacity:.35}.seat span{font-weight:700;font-size:14px}
.s2{grid-column:1/4;justify-self:center}.s3{grid-column:1;grid-row:2;align-self:center}.s1{grid-column:3;grid-row:2;align-self:center}
.fan{display:flex;direction:ltr;max-width:60px;justify-content:center}.bk{width:18px;height:26px;border-radius:3px;border:1px solid #fff;margin-left:-11px;background:repeating-linear-gradient(45deg,#8c1d18,#8c1d18 3px,#a8322b 3px,#a8322b 6px)}.s2 .fan{max-width:none}.s1 .bk,.s3 .bk{margin-left:-14px}.bk:first-child{margin-left:0}
#ctr{grid-column:2;grid-row:2;direction:rtl;overflow:auto;min-height:0;padding:4px}
#stat{text-align:center;font-size:13px;margin-bottom:6px;color:var(--gold)}
#piles{display:flex;gap:14px;justify-content:center;align-items:center;margin-bottom:8px}
.badge{background:#0006;border-radius:10px;padding:6px 10px;text-align:center;font-size:12px}.badge b{display:block;font-size:20px}
.c{width:54px;height:77px;flex:none;background:#fffdf6;border-radius:7px;border:1px solid #0005;box-shadow:0 1px 3px #0006;user-select:none;touch-action:none;position:relative}
.c svg{width:100%;height:100%;display:block;pointer-events:none}
.c.mini{width:36px;height:51px;touch-action:auto}.c.sel{transform:translateY(-12px);box-shadow:0 0 0 2px var(--gold),0 6px 10px #0008}
.c.back{background:repeating-linear-gradient(45deg,#8c1d18,#8c1d18 5px,#a8322b 5px,#a8322b 10px);border:3px solid #fff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
.c.empty{opacity:.25;box-shadow:none}.ghost{position:fixed;pointer-events:none;z-index:30;transform:rotate(5deg) scale(1.1);opacity:.95}
.ml{display:flex;align-items:center;background:#0005;border-radius:8px;padding:4px;margin:4px 0;overflow-x:auto;direction:rtl}
.ml small{font-size:10px;opacity:.8;margin-inline-end:6px;white-space:nowrap}.ml .c+.c{margin-inline-start:-12px}
.over{outline:3px dashed var(--gold);outline-offset:1px;background-color:#e7b84b30}
#hand{background:#062013;max-height:44dvh;overflow:auto;padding:6px;direction:rtl}
.me{font-size:12px;margin-bottom:4px;opacity:.9}.me.on{color:var(--gold)}
.grp{border:1px dashed #fff4;border-radius:8px;padding:2px 4px 4px;margin-bottom:5px}.grp.ok{border:1px solid #6fdc8c;background:#6fdc8c18}
.gh{display:flex;gap:6px;align-items:center;font-size:11px;min-height:22px}
.row{display:flex;min-height:80px;padding-top:12px;flex-wrap:nowrap}.row .c+.c{margin-inline-start:calc(var(--ov,22px)*-1)}
/*jl*/.jl{position:absolute;bottom:-1px;left:0;right:0;text-align:center;font-size:10px;font-weight:700;background:#7b3fb0;color:#fff;border-radius:0 0 6px 6px}
#newg{border:2px dashed #fff5;border-radius:8px;text-align:center;padding:6px;font-size:11px;opacity:.7}
button{font:inherit;border:0;border-radius:8px;padding:8px 12px;background:#ffffff22;color:#fff}button.p{background:var(--gold);color:#222;font-weight:700}button:disabled{opacity:.4}
#bar{display:flex;gap:6px;flex-wrap:wrap;padding:6px 6px calc(6px + env(safe-area-inset-bottom));background:#000a}
#toast{position:fixed;top:calc(env(safe-area-inset-top,0px) + 12px);left:50%;transform:translateX(-50%);background:#000d;padding:8px 14px;border-radius:10px;opacity:0;transition:.25s;pointer-events:none;z-index:25;max-width:90%;text-align:center}#toast.on{opacity:1}
#ov{position:fixed;inset:0;background:#000c;display:none;align-items:center;justify-content:center;z-index:40;padding:16px}
#ov>div{background:#143d2a;border:2px solid var(--gold);border-radius:14px;padding:16px;width:min(360px,100%)}
table{width:100%;border-collapse:collapse;margin:8px 0}td{padding:4px;border-bottom:1px solid #fff2}
`;
const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;z-index:12;display:none';
const root=host.attachShadow({mode:'open'});
root.innerHTML=`<style>${CSS}</style><div id="app"><div id="table"></div><div id="hand"></div><div id="bar"></div><div id="toast"></div><div id="ov"><div id="ovb"></div></div></div>`;
document.body.appendChild(host);
const $=s=>root.querySelector(s);
const SU=['♠','♥','♦','♣'],RK=['🃏','A','2','3','4','5','6','7','8','9','10','J','Q','K'];

const val=r=>(r>=10||r==1)?10:r;           // قيمة الورقة في الكف (الجوكر 20)
const hv=c=>c.r?val(c.r):20;
const posv=p=>p==1?1:(p>=10?10:p);        // قيمة الموقع في السيكونس

/* يرجّع {k,pts,ord} إذا الورقات باكو أو سيكونس صحيح */
function meld(cs){
  const n=cs.length;if(n<3)return null;
  const jk=cs.filter(c=>!c.r),ot=cs.filter(c=>c.r);if(!ot.length)return null;
  const suits=new Set(ot.map(c=>c.s));
  if(n<=5&&ot.every(c=>c.r==ot[0].r)&&suits.size==ot.length)return{k:'باكو',pts:val(ot[0].r)*n,ord:cs};
  if(suits.size!=1||new Set(ot.map(c=>c.r)).size!=ot.length)return null;
  let best=null;
  for(const hi of[0,1]){
    const L=hi?2:1,U=hi?14:13;if(U-L+1<n)continue;
    const v=ot.map(c=>({c,p:(c.r==1&&hi)?14:c.r})).sort((a,b)=>a.p-b.p);
    const mn=v[0].p,mx=v[v.length-1].p;
    if(mx-mn+1-v.length>jk.length)continue;
    const s=Math.min(mn,U-n+1);if(s+n-1<mx)continue;
    const J=[...jk],ord=[];let pts=0;
    for(let p=s;p<s+n;p++){const f=v.find(x=>x.p==p);ord.push(f?f.c:J.pop());pts+=posv(p)}
    if(!best||pts>best.pts)best={k:'سيكونس',pts,ord};
  }
  return best;
}


/* ===== الحلّال: يلقى أحسن تقسيم للكف (الجوكر يعوّض أي بلاصة) ===== */
function cands(R,x){
  const J=R.filter(c=>!c.r),O=R.filter(c=>c.r&&c!==x),out=[],seen=new Set();
  const add=cs=>{const m=meld(cs);if(!m)return;const k=cs.map(c=>c.id).sort((a,b)=>a-b).join();if(seen.has(k))return;seen.add(k);out.push({cs,m})};
  const ss=new Set([x.s]),same=[];O.forEach(c=>{if(c.r==x.r&&!ss.has(c.s)){ss.add(c.s);same.push(c)}});
  for(let mk=0;mk<(1<<same.length);mk++){const b=[x];same.forEach((c,i)=>(mk>>i)&1&&b.push(c));
    for(let j=0;j<=Math.min(J.length,2);j++)if(b.length+j>=3&&b.length+j<=4)add([...b,...J.slice(0,j)])}
  const bs={};O.forEach(c=>{if(c.s==x.s&&!bs[c.r])bs[c.r]=c});
  for(const hi of[0,1]){
    const L=hi?2:1,U=hi?14:13,px=(x.r==1&&hi)?14:x.r;if(px<L||px>U)continue;
    for(let a=Math.max(L,px-13);a<=px;a++)for(let b=px;b<=U;b++){
      if(b-a<2)continue;const cs=[];let need=0;
      for(let p=a;p<=b;p++){const c=p==px?x:bs[p==14?1:p];if(c)cs.push(c);else need++}
      if(need>J.length||need>2)continue;add([...cs,...J.slice(0,need)])
    }
  }
  return out
}
function solve(hand,out){
  const memo=new Map();
  const go=R=>{
    const k=R.map(c=>c.id).sort((a,b)=>a-b).join();if(memo.has(k))return memo.get(k);
    const x=R.find(c=>c.r);let best={s:out?0:-R.length,ms:[]};
    if(x){
      const sk=go(R.filter(c=>c!==x));best={s:sk.s-(out?0:1),ms:sk.ms};
      if(memo.size<60000)for(const{cs,m}of cands(R,x)){
        const ids=new Set(cs.map(c=>c.id)),r=go(R.filter(c=>!ids.has(c.id))),sc=r.s+(out?cs.length*1000+(cs.length>=4?50:0)+m.pts/100:m.pts*20);
        if(sc>best.s)best={s:sc,ms:[m.ord,...r.ms]}
      }
    }
    memo.set(k,best);return best
  };
  return go(hand).ms
}
const msPts=ms=>ms.reduce((a,g)=>a+meld(g).pts,0);


/* ===== هزان الجوكر: تبلّص الورقة الحقيقية اللي يعوّضها الجوكر وتهزو (لازم تكون مانع) ===== */
function jokerSlot(m,k){ // أي ورقة يعوّض الجوكر في السيكونس
  const cs=m.cards,j=cs.findIndex(c=>c.r),c=cs[j],pj=(c.r==1&&j>0)?14:c.r,pos=pj+(k-j);
  return{r:pos==14?1:pos,s:c.s}
}
function trySwap(m,c){
  if(!c.r)return null;
  for(let k=0;k<m.cards.length;k++){
    if(m.cards[k].r)continue;
    if(m.k=='سيكونس'){const w=jokerSlot(m,k);if(w.r!=c.r||w.s!=c.s)continue}
    const cs=[...m.cards];cs[k]=c;const r=meld(cs);
    if(r)return{r,j:m.cards[k]}
  }
  return null
}


/* ===== العرض (ورق حقيقي) ===== */
const PIP={1:[[50,50]],2:[[50,20],[50,80]],3:[[50,20],[50,50],[50,80]],4:[[28,20],[72,20],[28,80],[72,80]],5:[[28,20],[72,20],[50,50],[28,80],[72,80]],6:[[28,20],[72,20],[28,50],[72,50],[28,80],[72,80]],7:[[28,20],[72,20],[50,35],[28,50],[72,50],[28,80],[72,80]],8:[[28,20],[72,20],[50,35],[28,50],[72,50],[50,65],[28,80],[72,80]],9:[[28,18],[72,18],[28,39],[72,39],[50,50],[28,61],[72,61],[28,82],[72,82]],10:[[28,18],[72,18],[50,29],[28,39],[72,39],[28,61],[72,61],[50,71],[28,82],[72,82]]};
function faceSVG(c){
  const F='font-family="Arial,\'Segoe UI Symbol\',sans-serif"';
  if(!c.r)return `<svg viewBox="0 0 70 100" ${F}><rect x="5" y="5" width="60" height="90" rx="5" fill="#f4ecff" stroke="#7b3fb0" stroke-width="2"/><text x="35" y="58" font-size="34" text-anchor="middle">🃏</text><text x="35" y="82" font-size="9" font-weight="700" text-anchor="middle" fill="#7b3fb0">JOKER</text><text x="9" y="16" font-size="11" fill="#7b3fb0">★</text><text x="61" y="92" font-size="11" fill="#7b3fb0" text-anchor="end">★</text></svg>`;
  const col=(c.s==1||c.s==2)?'#c0262d':'#1b1b1b',S=SU[c.s],R=RK[c.r];let g='';
  if(c.r<=10)PIP[c.r].forEach(([x,y])=>{const X=x*.7;g+=`<text x="${X}" y="${y+(c.r==1?14:6)}" font-size="${c.r==1?42:17}" text-anchor="middle" fill="${col}"${y>50?` transform="rotate(180 ${X} ${y})"`:''}>${S}</text>`});
  else g=`<rect x="13" y="14" width="44" height="72" rx="3" fill="#fff4d0" stroke="#c9a23a" stroke-width="1.5"/><text x="35" y="60" font-size="32" font-weight="700" text-anchor="middle" fill="${col}" font-family="Georgia,serif">${R}</text><text x="35" y="30" font-size="14" text-anchor="middle" fill="${col}">${S}</text><text x="35" y="78" font-size="14" text-anchor="middle" fill="${col}" transform="rotate(180 35 74)">${S}</text>`;
  const idx=`<text x="8" y="14" font-size="${R=='10'?10:13}" font-weight="700" text-anchor="middle" fill="${col}">${R}</text><text x="8" y="26" font-size="11" text-anchor="middle" fill="${col}">${S}</text>`;
  return `<svg viewBox="0 0 70 100" ${F}>${g}${idx}<g transform="rotate(180 35 50)">${idx}</g></svg>`
}
function cardEl(c,o={}){
  const d=document.createElement('div');d.className='c'+(o.mini?' mini':'')+(o.sel?' sel':'');
  d.innerHTML=faceSVG(c);if(o.id)d.dataset.id=c.id;if(o.on)d.onclick=o.on;return d
}

/* ===== الحالة المحلية ===== */
const L={st:null,groups:[[]],sel:new Set(),sortMode:0,arm:0,armOpen:0,armOut:0,hidden:false,ws:null,prevTurn:-1};
const H=()=>L.st?L.st.hand:[];
const byId=id=>H().find(c=>c.id===id);
const cs=g=>g.map(byId).filter(Boolean);
const snd=(f,d,t,v)=>{try{tone(f,d,t,v)}catch(e){}};
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('on'),2600)}
function sync(){
  const ids=new Set(H().map(c=>c.id));
  L.groups=L.groups.map(g=>g.filter(id=>ids.has(id)));
  const have=new Set(L.groups.flat());
  H().forEach(c=>{if(!have.has(c.id))L.groups[0].push(c.id)});
  L.groups=L.groups.filter((g,i)=>i==0||g.length);
  L.sel=new Set([...L.sel].filter(id=>ids.has(id)))
}
const show=()=>{L.hidden=false;host.style.display='block'};
function reset(){L.st=null;L.groups=[[]];L.sel.clear();L.arm=L.armOpen=L.armOut=0;host.style.display='none'}
const myTurn=()=>{const d=L.st;return d&&d.status==='play'&&d.turn===d.you};

/* ===== رسائل السيرفر ===== */
function onMsg(d){
  if(d.type==='rum:err'){toast('⚠️ '+d.text);L.arm=L.armOpen=0;return render()}
  if(d.type==='rum:note'){toast(d.text);return render()}
  if(d.type!=='rum:state')return;
  const mine=d.status==='play'&&d.turn===d.you;
  if(mine&&L.prevTurn!==d.you)snd(660,.12,'triangle',.18);
  L.prevTurn=mine?d.you:-1;
  L.st=d;if(!mine)L.arm=L.armOpen=0;
  if(!L.hidden)host.style.display='block';
  sync();render()
}

/* ===== حركات اللاعب (السيرفر هو الحَكَم) ===== */
const send2=o=>send(o);
function draw(from){const d=L.st;if(!d||!myTurn()||d.ph!=='draw')return;send2({type:'rum:draw',from})}
function applySolution(ms){const used=new Set(ms.flat().map(c=>c.id));L.groups=[H().filter(c=>!used.has(c.id)).map(c=>c.id),...ms.map(g=>g.map(c=>c.id))];L.sel.clear()}
function autoArrange(){const ms=solve(H()),t=msPts(ms);applySolution(ms);render();
  toast(ms.length?`لقيت ${ms.length} تشكيلات = ${t} نقطة${L.st.you!=null&&L.st.seats[L.st.you].opened?'':(t>=L.st.min?' ✓ تنجم تمنع':` (الحلان ${L.st.min})`)}`:'ما لقيت حتى تشكيلة في كفك')}
function openClick(){
  const d=L.st;if(!myTurn()||d.ph!=='play')return;
  const man=()=>L.groups.map((g,i)=>i).filter(i=>i>0&&meld(cs(L.groups[i])));
  let idx=man(),tot=idx.reduce((a,i)=>a+meld(cs(L.groups[i])).pts,0);
  if(tot<d.min){
    const ms=solve(H()),t2=msPts(ms);
    if(t2>=d.min){applySolution(ms);idx=man();tot=t2}
    else if(d.took!=null){
      if(!L.armOpen){L.armOpen=1;toast(`هزيت المطيشة وما عندكش ${d.min} — اضغط مرة ثانية باش تاخذ 100 وتخرج من الجولة`);return render()}
    }else return toast(`أحسن تقسيم في كفك ${t2} نقطة والحلان ${d.min} — ما تنجمش تمنع توّا`)
  }
  L.armOpen=0;send2({type:'rum:open',groups:idx.map(i=>L.groups[i])})
}
function layOne(gi){send2({type:'rum:lay',groups:[L.groups[gi]]})}
function place(mi,ids){const d=L.st;if(!myTurn()||d.ph!=='play')return toast('مش دورك'),render();send2({type:'rum:place',meld:mi,cards:ids});L.sel.clear()}
function discard(){
  const d=L.st;if(!myTurn()||d.ph!=='play')return;
  if(L.sel.size!==1)return toast('اختار ورقة وحدة باش تطيّشها');
  send2({type:'rum:discard',card:[...L.sel][0]});L.sel.clear()
}
function flush(){
  if(!myTurn()||L.st.ph!=='play')return;
  if(!L.arm){L.arm=1;render();toast('اضغط مرة أخرى للتأكيد — كان الفرشة غالطة تاخذ 100');setTimeout(()=>{if(L.arm){L.arm=0;render()}},4000);return}
  L.arm=0;send2({type:'rum:flush'})
}
function leave(){
  const d=L.st;
  if(d&&d.status==='play'&&!L.armOut){L.armOut=1;render();toast('كان تخرج في نص الجولة تاخذ 100 — اضغط مرة ثانية للخروج');setTimeout(()=>{if(L.armOut){L.armOut=0;render()}},4000);return}
  send2({type:'rum:leave'});reset()
}
function sortHand(){const g=L.groups[0];L.sortMode^=1;g.sort((x,y)=>{const a=byId(x),b=byId(y);return L.sortMode?(a.r-b.r||a.s-b.s):(a.s-b.s||a.r-b.r)});render()}

/* ===== الرسم ===== */
const seatEl=(i,cls)=>{const d=L.st,p=d.seats[i],n=Math.min(p.n,cls==='s2'?9:6);
  return `<div class="seat ${cls}${d.turn===i&&d.status==='play'?' on':''}${p.dead?' dead':''}"><b>${p.name}</b><span>${p.score}${p.opened?' ✓':''}${p.out?' ❌':''}</span><div class="fan">${'<i class="bk"></i>'.repeat(n)}</div><small>${p.n} ورقة</small></div>`};
function render(){
  const d=L.st;if(!d)return;
  const T=$('#table'),H_=$('#hand'),B=$('#bar');B.innerHTML='';
  const add=(t,f,p)=>{const b=document.createElement('button');b.textContent=t;if(p)b.className='p';b.onclick=f;B.append(b);return b};
  if(d.status==='wait'){
    T.innerHTML=`<div id="ctr" style="grid-column:1/4;grid-row:1/3"><div id="stat">طاولة رامي — تستنى اللاعبين (2 إلى 4)</div>${d.seats.map(s=>`<div class="badge" style="margin:6px auto;max-width:220px">${s.name}</div>`).join('')}</div>`;
    H_.innerHTML='';$('#ov').style.display='none';
    if(d.host)add(d.seats.length>=2?'▶ ابدأ اللعبة':'تحتاج لاعبين على الأقل',()=>send2({type:'rum:start'}),1);
    else add('تستنى الهوست باش يبدا',()=>{});
    add('إخفاء',()=>{L.hidden=true;host.style.display='none'});add('خروج',leave);return
  }
  const n=d.seats.length,pos=n===2?['s2']:n===3?['s1','s3']:['s1','s2','s3'];
  let html='';for(let k=1;k<n;k++)html+=seatEl((d.you+k)%n,pos[k-1]);
  const my=myTurn(),me=d.seats[d.you];
  T.innerHTML=html+'<div id="ctr"><div id="stat"></div><div id="piles"></div><div id="melds"></div></div>';
  $('#stat').textContent=d.status!=='play'?'':me.out?'غلطت في الفرشة ❌ — تستنى الجولة تكمل':my?(d.ph==='draw'?'دورك: اسحب من الكومة ولا من المطيشة':'دورك: بلّص ولا طيّش'):`دور ${d.seats[d.turn].name}…`;
  const pl=$('#piles'),sk=document.createElement('div');sk.className='c back';sk.textContent=d.stock;sk.onclick=()=>draw('s');pl.append(sk);
  const dc=d.disc?cardEl(d.disc,{on:()=>draw('d')}):Object.assign(document.createElement('div'),{className:'c empty'});dc.id='disc';pl.append(dc);
  pl.insertAdjacentHTML('beforeend',`<div class="badge">الحلان<b>${d.min}</b></div>`);
  d.melds.forEach((m,i)=>{const r=document.createElement('div');r.className='ml';r.dataset.mi=i;r.innerHTML=`<small>${d.seats[m.o].name}<br>${m.k}</small>`;
    m.cards.forEach((c,k)=>{const e=cardEl(c,{mini:1});e.style.zIndex=50-k;if(!c.r&&m.k==='سيكونس'){const w=jokerSlot(m,k);e.insertAdjacentHTML('beforeend',`<span class="jl">=${RK[w.r]}${SU[w.s]}</span>`)}r.append(e)});
    r.onclick=()=>{if(L.sel.size)place(i,[...L.sel])};$('#melds').append(r)});
  H_.innerHTML=`<div class="me${my?' on':''}">إنت · ${me.score} نقطة${me.opened?' · مانع ✓':''}${me.out?' · مطيّح من الجولة':''} · ${H().length} ورقة${H().length>14&&my&&d.ph==='play'?' — طيّش ورقة باش ترجع 14':''}</div>`;
  L.groups.forEach((g,gi)=>{
    const cards=cs(g),m=gi>0&&meld(cards),el=document.createElement('div');el.className='grp'+(m?' ok':'');el.dataset.gi=gi;
    const h=document.createElement('div');h.className='gh';h.innerHTML=`<b>${gi?'تشكيلة '+gi:'الكف'}</b>${m?`<span>✓ ${m.k} ${m.pts}</span>`:''}`;
    if(m&&me.opened&&my&&d.ph==='play'){const l=document.createElement('button');l.textContent='نزّل';l.className='p';l.style.padding='2px 8px';l.onclick=()=>layOne(gi);h.append(l)}
    el.append(h);const row=document.createElement('div');row.className='row';
    cards.forEach((c,k)=>{const e=cardEl(c,{sel:L.sel.has(c.id),id:1});e.style.zIndex=cards.length-k;e.onpointerdown=ev=>startDrag(ev,c,e);row.append(e)});
    el.append(row);H_.append(el);
    const nn=cards.length;row.style.setProperty('--ov',(nn>1?Math.max(0,54-Math.min(46,(row.clientWidth-54)/(nn-1))):0)+'px')
  });
  H_.insertAdjacentHTML('beforeend','<div id="newg">＋ اسحب ورقة هنا باش تعمل تشكيلة جديدة</div>');
  if(!me.out){add('ساعدني 💡',autoArrange);add(L.sortMode?'رتّب بالشكل':'رتّب بالقيمة',sortHand)}
  if(my&&d.ph==='play'){
    if(!me.opened)add(L.armOpen?'أكّد (100) ⚠️':'منع',openClick,1);
    if(d.took!=null&&!me.opened)add('رجّع المطيشة',()=>send2({type:'rum:undo'}));
    add(L.arm?'أكّد الفرشة ⚠️':'فرشت 🏁',flush,1);add('طيّش',discard,1)
  }
  add('إخفاء',()=>{L.hidden=true;host.style.display='none'});add(L.armOut?'أكّد الخروج ⚠️':'خروج',leave);
  // ملخص الجولة / نهاية اللعبة
  const ov=$('#ov');
  if(d.status==='round'||d.status==='end'){
    const rows=(d.rows||[]).map(r=>`<tr><td>${r.name}${r.note?` <small>${r.note}</small>`:''}</td><td>${r.d>0?'+':''}${r.d}</td><td><b>${r.score}</b></td></tr>`).join('');
    const ready=typeof myId!=='undefined'&&d.ready.includes(myId);
    $('#ovb').innerHTML=`<h3 style="margin:0 0 6px">${d.status==='end'?'نهاية اللعبة 🏆 فاز '+d.winner:'نهاية الجولة'}</h3><table>${rows}</table>`+
      (d.status==='round'?`<button class="p" id="rmNext"${ready?' disabled':''}>${ready?'تستنى الباقي…':'جولة جديدة'}</button>`
        :(d.host?'<button class="p" id="rmAgain">لعبة جديدة</button> ':'')+'<button id="rmOut">خروج</button>');
    ov.style.display='flex';
    const g=id=>$('#'+id);
    if(g('rmNext'))g('rmNext').onclick=()=>send2({type:'rum:next'});
    if(g('rmAgain'))g('rmAgain').onclick=()=>send2({type:'rum:again'});
    if(g('rmOut'))g('rmOut').onclick=()=>{send2({type:'rum:leave'});reset()}
  }else ov.style.display='none'
}

/* ===== سحب وإفلات ===== */
let ovEl=null;
const hl=e=>{if(ovEl===e)return;ovEl&&ovEl.classList.remove('over');ovEl=e;e&&e.classList.add('over')};
const target=(x,y)=>{const t=root.elementFromPoint(x,y);return t&&t.closest('.ml,.grp,#disc,#newg')};
function startDrag(e,c,el){
  const sx=e.clientX,sy=e.clientY;let ghost=null,ids=null;
  const mv=ev=>{
    if(!ghost){if(Math.hypot(ev.clientX-sx,ev.clientY-sy)<8)return;
      ids=L.sel.has(c.id)?[...L.sel]:[c.id];ghost=el.cloneNode(true);ghost.className='c ghost';$('#app').appendChild(ghost);el.style.opacity=.3}
    ghost.style.left=ev.clientX-27+'px';ghost.style.top=ev.clientY-80+'px';hl(target(ev.clientX,ev.clientY))};
  const up=ev=>{removeEventListener('pointermove',mv);removeEventListener('pointerup',up);removeEventListener('pointercancel',up);hl(null);
    if(!ghost){L.sel.has(c.id)?L.sel.delete(c.id):L.sel.add(c.id);return render()}
    ghost.remove();drop(ev,ids)};
  addEventListener('pointermove',mv);addEventListener('pointerup',up);addEventListener('pointercancel',up)
}
function drop(ev,ids){
  const t=target(ev.clientX,ev.clientY);
  if(!t||!ids.length)return render();
  if(t.classList.contains('ml')){place(+t.dataset.mi,ids);return render()}
  if(t.id==='disc'){L.sel=new Set(ids);discard();return render()}
  const ce=root.elementFromPoint(ev.clientX,ev.clientY).closest('.c[data-id]'),set=new Set(ids);
  let gi;if(t.id==='newg'){L.groups.push([]);gi=L.groups.length-1}else gi=+t.dataset.gi;
  const anchor=ce?+ce.dataset.id:null,right=ce&&ev.clientX>ce.getBoundingClientRect().left+ce.offsetWidth/2;
  L.groups=L.groups.map(g=>g.filter(id=>!set.has(id)));
  const g=L.groups[gi];let at=g.length;
  if(anchor!=null&&!set.has(anchor)){const k=g.indexOf(anchor);at=right?k:k+1}
  g.splice(at,0,...ids);
  L.groups=L.groups.filter((g,i)=>i===0||g.length);L.sel.clear();render()
}

/* ===== الربط مع المقهى: زر + استقبال الرسائل (بلا ما نبدّلو index.html) ===== */
const btn=document.createElement('button');btn.id='rmBtn';btn.style.cssText='display:none;background:#8e44ad;color:#fff';
btn.onclick=()=>{
  if(L.st){show();render();return}
  if(typeof seat==='undefined'||!seat)return;
  show();$('#table').innerHTML='<div id="ctr" style="grid-column:1/4;grid-row:1/3"><div id="stat">جاري الاتصال…</div></div>';$('#hand').innerHTML='';$('#bar').innerHTML='';
  const b=document.createElement('button');b.textContent='إخفاء';b.onclick=()=>{L.hidden=true;host.style.display='none'};$('#bar').append(b);
  send({type:'rum:join',room:seat.t.join(',')})
};
(function mount(){const b=document.getElementById('btns');if(!b)return setTimeout(mount,300);b.appendChild(btn)})();
setInterval(()=>{
  try{
    btn.style.display=(typeof sitting!=='undefined'&&sitting)?'block':'none';
    const tx=L.st?'🎴 طاولة الرامي':'🎴 العب رامي';if(btn.textContent!==tx)btn.textContent=tx;
    if(typeof ws!=='undefined'&&ws&&ws!==L.ws){
      L.ws=ws;
      ws.addEventListener('message',e=>{let d;try{d=JSON.parse(e.data)}catch{return}if(typeof d.type==='string'&&d.type.indexOf('rum:')===0)onMsg(d)});
      ws.addEventListener('close',reset)
    }
  }catch(e){}
},300);
window.RummyClient={onMsg,reset,show};
})();
