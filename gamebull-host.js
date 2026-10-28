/* GameBull must implement this host object using its own authenticated services.
   Do not put service keys in the browser. This file defines no API endpoints. */
window.GameBullHost = {
 async getSession(request) {
   // Return { nextStage: 1..600 (601 when finished), completedAll: boolean,
   //          activeAdmission?: {admissionId: string, stage: number} }.
   throw new Error('GameBull側で getSession を接続してください。');
 },
 async enterStage(request) {
   // In one server transaction: authenticate, verify request.datasetVersion,
   // check stage is the next uncleared stage, reuse existing active admission,
   // consume exactly one life ONCE per user/requestId, persist admission.
   // Return { admissionId: string, stage: request.stage }.
   throw new Error('GameBull側でライフ1消費と enterStage を接続してください。');
 },
 async submitClear(request) {
   // Verify owned admission + dataset + replay on server (see ../server).
   // Commit progress once per admissionId. At stage 600 enqueue one reward
   // with a unique (user, campaign) key. Return the same result on retries:
   // {cleared:true,nextStage:request.stage+1,completedAll:request.stage===600}.
   throw new Error('GameBull側で submitClear と達成特典を接続してください。');
 }
};
