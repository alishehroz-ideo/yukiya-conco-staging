/* Proposed GameBull integration contract, not an existing GameBull API. */
(function(root){
function create(host,version,total=600,storage){
 let state={nextStage:1,completedAll:false,admission:null,ready:false};let busy=false;
 const validStage=n=>Number.isInteger(n)&&n>=1&&n<=total;
 function requireHost(){if(!host||!['getSession','enterStage','submitClear'].every(k=>typeof host[k]==='function'))throw Error('GameBullとの接続設定が必要です。運営へお問い合わせください。')}
 function checkAdmission(a,stage){if(!a||typeof a.admissionId!=='string'||!a.admissionId||a.stage!==stage)throw Error('GameBullの参加確認に失敗しました。');return {admissionId:a.admissionId,stage:a.stage}}
 function key(stage){const k='yukiya-entry:'+version+':'+stage;let id;try{id=storage?.getItem(k)}catch{}if(!id){id=root.crypto?.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2);try{storage?.setItem(k,id)}catch{}}return id}
 async function lock(fn){if(busy)throw Error('処理中です。しばらくお待ちください。');busy=true;try{return await fn()}finally{busy=false}}
 async function initialize(){return lock(async()=>{requireHost();const s=await host.getSession({gameId:'yukiya-conco',datasetVersion:version});if(!s||typeof s.completedAll!=='boolean'||(!s.completedAll&&!validStage(s.nextStage))||(s.completedAll&&s.nextStage!==total+1))throw Error('GameBullの進行情報を確認できません。');state={nextStage:s.nextStage,completedAll:s.completedAll,admission:null,ready:true};if(s.activeAdmission&&!s.completedAll)state.admission=checkAdmission(s.activeAdmission,s.nextStage);return snapshot()})}
 async function enter(){return lock(async()=>{requireHost();if(!state.ready)throw Error('参加情報を読み込んでください。');if(state.completedAll)throw Error('全ステージをクリア済みです。');if(state.admission)return {...state.admission};const stage=state.nextStage;const a=await host.enterStage({gameId:'yukiya-conco',datasetVersion:version,stage,lifeCost:1,requestId:key(stage)});state.admission=checkAdmission(a,stage);return {...state.admission}})}
 async function clear(directions){return lock(async()=>{requireHost();if(!state.admission)throw Error('参加確認がありません。');const a=state.admission;const s=await host.submitClear({gameId:'yukiya-conco',datasetVersion:version,stage:a.stage,admissionId:a.admissionId,requestId:a.admissionId+':clear',moves:directions.slice()});if(!s||s.cleared!==true||s.nextStage!==a.stage+1||s.completedAll!==(a.stage===total))throw Error('クリア結果を確認できません。再送してください。');state={nextStage:s.nextStage,completedAll:s.completedAll,admission:null,ready:true};return {...s}})}
 function snapshot(){return {...state,admission:state.admission?{...state.admission}:null,busy}}
 return {initialize,enter,clear,snapshot};
}
const api={create};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GameBullFlow=api;
})(globalThis);
