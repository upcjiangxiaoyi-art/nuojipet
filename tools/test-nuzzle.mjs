// Run: node tools/test-nuzzle.mjs. Native Node only; no browser packages.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const url = new URL('../pet-renderer.js',import.meta.url);
const text = (await readFile(url,'utf8')).replaceAll('import.meta.url',JSON.stringify(url.href));
const mod = await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const {getNuzzlePose:pose,getNuzzlePoint:point,NUZZLE_DURATION_MS:duration,PET_STATES,NuojiRenderer,getWalkStrideLength}=mod;
for(let i=0;i<=420;i++){
    const p=pose(i/100);
    for(const [x,y] of [[145,462],[214,465],[350,477]]) {
        assert.deepEqual(point(x,y,p),{x,y});
    }
    // Facial landmarks have unchanged pairwise distances: no face stretch.
    const a=point(176,144,p), b=point(207,130,p);
    assert.ok(Math.abs(Math.hypot(a.x-b.x,a.y-b.y)-Math.hypot(31,14))<1e-9);
    for(let y=230;y<430;y+=5){
        const a=point(170,y,p),b=point(330,y,p),c=point(170,y+5,p);
        assert.ok((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)>0,'skin must not fold');
    }
}
for(const t of [0,4.2,9]){
 const p=pose(t);assert.ok(Math.abs(p.lean)+Math.abs(p.x)+Math.abs(p.y)<1e-12);
}
assert.deepEqual(pose(0,true),pose(100,true));
assert.ok(pose(1.325).rub>0.99 && pose(2.375).rub>0.99);
assert.equal(pose(1.8).rub,0);
const renderer={state:'nuzzling',stateStartedAt:-100,draw(){}};
NuojiRenderer.prototype.setState.call(renderer,'nuzzling');
assert.ok(renderer.stateStartedAt>=0,'repeat nuzzle restarts the one-shot');

// Execute the actual interaction controller with a fake clock and DOM shell.
// Browser layout/hit-testing are out of scope; gesture/state/timer functions run unchanged.
let clock=0, nextId=1;
const timers=new Map();
const win={matchMedia:()=>({matches:false}),setTimeout(fn,delay){const id=nextId++;timers.set(id,{fn,due:clock+delay});return id;},clearTimeout(id){timers.delete(id)},cancelAnimationFrame(){},addEventListener(){},removeEventListener(){}};
const fakeRenderer={state:'idle',form:'sitting',setState(s){this.state=s},setForm(s){this.form=s},currentForm(){return this.form}};
const root={setAttribute(){},dataset:{},classList:{add(){},remove(){}}};
const context=vm.createContext({window:win,document:{getElementById(){return null}},Date:{now:()=>clock},performance:{now:()=>clock},console,URL,PET_STATES,NUZZLE_DURATION_MS:duration,NuojiRenderer,getWalkStrideLength,fakeRenderer,root});
let code=await readFile(new URL('../index.js',import.meta.url),'utf8');
code=code.slice(code.indexOf('\n')+1,code.lastIndexOf("if (document.readyState === 'loading')"))
    .replaceAll('import.meta.url',JSON.stringify(url.href)).replaceAll('export function','function');
vm.runInContext(code+`\nrenderer=fakeRenderer; ui={root,bubble:{classList:{remove(){},add(){}}}}; settings={enabled:true,autoWalk:false,showBubble:false};
 globalThis.test={doublePetNuoji,beginThinking,handleTypingInput,handlePointerMove,
 setDrag(){drag.active=true;drag.pointerId=1;drag.startX=0;drag.startY=0;setPixelPosition=()=>{};},
 reaction(){return reactionTimer},state(){return renderer.state},form(){return renderer.form}};`,context);
function advance(ms){clock+=ms;for(const [id,t] of [...timers])if(t.due<=clock){timers.delete(id);t.fn()}}
const app=context.test;
app.doublePetNuoji();assert.equal(app.state(),'nuzzling');advance(4199);assert.equal(app.state(),'nuzzling');advance(1);assert.equal(app.state(),'idle');
app.doublePetNuoji();advance(1000);app.doublePetNuoji();advance(3200);assert.equal(app.state(),'nuzzling');advance(1000);assert.equal(app.state(),'idle');
app.doublePetNuoji();const nuzzleTimer=app.reaction();
app.handleTypingInput({target:{matches:s=>s==='#send_textarea',value:'hi'}});
assert.equal(app.state(),'listening');assert.ok(!timers.has(nuzzleTimer));
app.doublePetNuoji();const beforeDrag=app.reaction();app.setDrag();
app.handlePointerMove({pointerId:1,clientX:20,clientY:0,stopImmediatePropagation(){},preventDefault(){}});
assert.equal(app.state(),'listening');assert.ok(!timers.has(beforeDrag));
app.doublePetNuoji();const beforeGeneration=app.reaction();app.beginThinking('test');
assert.equal(app.state(),'thinking');assert.equal(app.form(),'ball');assert.ok(!timers.has(beforeGeneration));
advance(4200);assert.equal(app.state(),'thinking','old affection timer cannot end generation');
console.log('PASS: 421 nuzzle poses; pinned paws, rigid face, valid skin, two strokes, neutral endpoints, reduced motion, restart and controller completion/typing/drag/generation interruptions.');
