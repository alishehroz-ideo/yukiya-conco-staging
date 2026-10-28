/* Shared deterministic puzzle rules, browser and server. */
(function(root){
function counts(g){return g.flat().reduce((a,v)=>(v>1&&(a[v]=(a[v]||0)+1),a),{})}
function complete(g){return Object.values(counts(g)).every(n=>n===1)}
function slide(g,d){const a=g.map(r=>r.slice()),h=a.length,w=a[0].length,vertical=d==='up'||d==='down',reverse=d==='down'||d==='right';for(let l=0;l<(vertical?w:h);l++){let target=null;for(let k=0;k<(vertical?h:w);k++){const p=reverse?(vertical?h:w)-1-k:k,y=vertical?p:l,x=vertical?l:p,v=a[y][x];if(v===1){target=null;continue}if(!v)continue;a[y][x]=0;if(target&&a[target[0]][target[1]]===v)continue;let pos=k;if(target){const t=vertical?target[0]:target[1];pos=(reverse?(vertical?h:w)-1-t:t)+1}else{pos=k;while(pos>0){const pp=reverse?(vertical?h:w)-pos:pos-1,yy=vertical?pp:l,xx=vertical?l:pp;if(a[yy][xx]===1)break;pos--}}const p2=reverse?(vertical?h:w)-1-pos:pos;target=vertical?[p2,l]:[l,p2];a[target[0]][target[1]]=v;}}return a}

function initial(l){return Array.from({length:l.h},(_,y)=>Array.from({length:l.w},(_,x)=>l.cols[x][l.h-1-y]));}
const api={initial,counts,complete,slide};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PuzzleEngine=api;
})(globalThis);
