'use strict';
/* 雪屋Conco かき氷パズル: window.GameBullHost on the real GameBull Stage Mode API.
 *
 * The client's own seam (their README section 3, docs/GameBull連携仕様.txt): their game.js builds its session with
 * GameBullFlow.create(window.GameBullHost, ...) and calls only getSession / enterStage / submitClear; their
 * gamebull-flow.js validates every answer. Their gamebull-host.js (stubs that throw) still loads first; this file
 * replaces the object before their game.js reads it. Their contract was a proposal, not a GameBull API, so this file
 * maps it onto the API the other Stage Mode games use (gamebull-whitelabel ADR-0086, contracts/stage-mode.ts; the
 * Stance, Niigata and Himi Kiju ports):
 *
 *   getSession     GET  /play/games/{gameId}/context?tenantSlug   (Bearer bootToken) -> stageMode, lives.count
 *   enterStage     POST /play/plays {bootToken, stage}            1 Life on the server (PAID). Their game only ever
 *                                                                  asks for nextStage
 *   submitClear    their moves replayed on their PuzzleEngine, then
 *                  POST /play/stage-clears {sessionToken, playTimeMs} -> status, progress, the all-clear reward
 *
 * What their contract asks that the API does not have, and what this file does instead:
 *  - idempotent entries (requestId): the API has no idempotency key. The answer is kept per requestId in
 *    sessionStorage (with its play token, which never goes into THEIR storage), so a resend of the same requestId
 *    returns the same admission with no second Life; a request still in flight is awaited, not sent again. An entry
 *    whose answer was lost for good (network / 5xx) is never re-sent: the resend gets a definitive answer with fresh
 *    Lives and a message that a Life may have been used (as on Stance / Himi Kiju);
 *  - activeAdmission after a reload: the running attempt kept in this tab's sessionStorage (until its deadline);
 *  - move proof: GameBull does not replay moves. Their moves are replayed here with their own engine before a clear
 *    is reported (not authoritative: it runs in the browser). datasetVersion is not known to the server;
 *  - time: GameBull requires a time per attempt (admin maxAttemptSeconds, at most 3540 s). Their game has no clock;
 *    gb/yc-hooks.js shows it and ends the attempt at 0 (expire() below). An attempt that is over (time, token) is
 *    dead: their next entry for that stage (same requestId: theirs is one id per stage) is a NEW paid start, only on
 *    the player's own tap (their START).
 * Lives are never subtracted here: the balance is the server's (/context lives.count after every call).
 */
(function () {
  const ENV = window.YUKIYA_GB || {};
  const log = (...a) => console.log('[YC-STAGE]', ...a);
  const q = new URLSearchParams(location.search);
  // The GameBull app launches with ?tenantSlug&bootToken&gameId&returnUrl&apiBase (use-launch-game.ts); the other
  // ports' SDK also accepts sessionToken / token, in that order (playbook section 2).
  const token = q.get('bootToken') || q.get('sessionToken') || q.get('token') || '';
  const tenant = q.get('tenantSlug') || '';
  const api = ((ENV.dev && q.get('devApi')) || ENV.apiBase || '').replace(/\/+$/, '');
  const jwtPayload = t => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; } };
  const player = (jwtPayload(token) || {}).globalUserId || 'unknown';
  const KEY = ('yukiya-gb:v1:' + tenant + ':' + ENV.gameId + ':' + player).slice(0, 220);

  // Server codes -> wording for their title / status lines (their game shows error.message as it is). Wording follows
  // the other Stage Mode ports' screens.
  const MESSAGES = {
    'play.no_lives': 'ライフがありません。GameBullでご確認ください。',
    'stage.daily_limit_reached': '本日の挑戦回数の上限です。進行状況は保存されています。',
    'stage.stage_not_playable': 'ステージが更新されました。もう一度「START」を押してください。',
    'stage.all_cleared': '全600ステージをクリア済みです。',
    'play.session_token_expired': '参加の期限切れです。「START」で再参加できます（ライフ1）。',
    'play.session_token_invalid': 'GameBullに接続できません。GameBullから開き直してください。',
    'guest.session_invalid': 'GameBullに接続できません。GameBullから開き直してください。',
    'play.mode_not_enabled': 'このゲームのステージモードをGameBull側で有効にしてください。',
    'stage.mode_required': 'GameBullのゲーム画面の「Play Stage Mode」から開いてください。',
    'stage.total_mismatch': '管理画面のステージ数を600に設定してください（現在の設定と不一致）。',
    'stage.start_unknown': 'ライフが使われた可能性があります。もう一度「START」を押してください。',
    'stage.launch_required': 'GameBullのゲーム画面から開いてください。',
    'stage.time_exceeded': '時間切れです。「START」で再参加できます（ライフ1）。',
    'stage.attempt_lost': '参加情報がありません。「START」で再参加できます（ライフ1）。',
    'stage.invalid_moves': 'クリアを確認できませんでした。「やり直す」でもう一度お試しください。',
    'network': '通信できませんでした。接続を確認してお試しください。',
    'bad_response': 'GameBullからの応答を確認できませんでした。もう一度お試しください。',
    'bad_context': 'ステージ情報がゲームと一致しません。管理者に確認してください。',
  };
  // definitive: the server answered (no resend helps); resync: their session must re-read /context before the next
  // entry (gb/yc-hooks.js resets their `initialized`); over: the running attempt is finished (back to their TOP).
  const err = (code, o) => Object.assign(new Error(MESSAGES[code] || (o && o.httpStatus >= 500 ? 'GameBullへの接続に失敗しました。時間をおいてお試しください。' : 'GameBullへの接続に失敗しました。')),
    { code, definitive: false, resync: false, over: false }, o || {});
  const emit = (name, detail) => dispatchEvent(new CustomEvent('yukiya-gb:' + name, { detail }));

  /* ── storage (sessionStorage, this tab only; the play token never leaves this object) ── */
  const blank = () => ({ starts: {}, sent: {}, attempts: {}, reward: null });
  let store = blank();
  try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s && s.starts && s.attempts) store = Object.assign(blank(), s); } catch { /* private mode */ }
  function save() {
    for (const k of ['starts', 'attempts']) { const ids = Object.keys(store[k]); if (ids.length > 30) for (const id of ids.slice(0, ids.length - 30)) delete store[k][id]; }
    try { sessionStorage.setItem(KEY, JSON.stringify(store)); } catch { /* private mode */ }
  }
  const alive = a => !!a && !a.dead && !a.result && !a.clear && Date.now() < a.end;
  const live = a => !!a && !a.dead && !a.result && (!!a.clear || Date.now() < a.end);   // a won attempt waits for its report

  /* ── server ── */
  let n = 0;
  async function request(path, { method = 'GET', body, bearer } = {}) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 30000);
    const headers = { Accept: 'application/json' };
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (body) headers['Content-Type'] = 'application/json';
    // GETs are cache-busted with a unique URL (a cached /context showed lives one play behind, playbook section 3).
    const url = api + path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + '_ts=' + Date.now() + '-' + (++n) : '');
    let response, data;
    try {
      response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: abort.signal,
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    } catch { throw err('network'); }
    finally { clearTimeout(timer); }
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      // Codes arrive nested ({error:{code}}) or top-level ({code}) (playbook section 3, error shapes).
      const code = (data && data.error && data.error.code) || (data && typeof data.code === 'string' && data.code) || 'http_' + response.status;
      throw err(code, { definitive: response.status < 500, httpStatus: response.status });
    }
    if (!data || typeof data !== 'object') throw err('bad_response');
    return data;
  }

  let last = null;   // the last /context
  async function readContext() {
    if (!api || !token || !tenant) throw err('stage.launch_required', { definitive: true });
    const data = await request('/play/games/' + encodeURIComponent(ENV.gameId) + '/context?tenantSlug=' + encodeURIComponent(tenant), { bearer: token });
    const m = data.stageMode;
    // stageMode is sent only for a "Play Stage Mode" launch (boot token mode STAGE_CLEAR); "Game Start" gets null.
    if (!m) throw err('stage.mode_required', { definitive: true });
    // Their game knows exactly 600 stages (their flow checks nextStage 601 / completedAll at 600).
    if (m.totalStages !== ENV.totalStages) throw err('stage.total_mismatch', { definitive: true });
    const h = m.highestCleared;
    if (!Number.isInteger(h) || h < 0 || h > m.totalStages || m.nextStage !== (h >= m.totalStages ? null : h + 1)) throw err('bad_context', { definitive: true });
    last = data;
    emit('context', { lives: lives(), stageMode: m });
    return data;
  }
  const lives = () => { const c = last && last.lives && last.lives.count; return Number.isInteger(c) && c >= 0 ? c : null; };
  // After a refusal the lives shown are re-read (best effort).
  async function fresh(e) { try { await readContext(); } catch { /* keep the last */ } return e; }
  // An attempt that can no longer clear: their TOP and a new entry (gb/yc-hooks.js).
  function finish(a, code) { a.dead = true; save(); const e = err(code, { definitive: true, resync: true, over: true }); emit('attempt-over', { stage: a.stage, code, message: e.message }); return e; }

  /* ── their contract ── */
  async function getSession(req) {
    // A won attempt whose report never got an answer (a reload after a failed send) is reported first, with the same
    // body: the stage is not paid for twice.
    for (const a of Object.values(store.attempts)) {
      if (!a.clear || a.result || a.dead) continue;
      log(`Stage ${a.stage}: resending the clear that was not confirmed before the reload.`);
      try { await report(a); } catch { /* the stage stays next; their game shows the server's progress */ }
    }
    const data = await readContext(), m = data.stageMode, done = m.highestCleared >= m.totalStages;
    const next = done ? m.totalStages + 1 : m.nextStage;
    const out = { nextStage: next, completedAll: done };
    // A running attempt for that stage in this tab (a reload, their TOP and back) is theirs again, no new Life.
    const id = Object.keys(store.attempts).find(k => store.attempts[k].stage === next && alive(store.attempts[k]));
    if (id && !done) out.activeAdmission = { admissionId: id, stage: next };
    log(`Build v${ENV.build}. /context: cleared ${m.highestCleared}/${m.totalStages}, next ${m.nextStage}, ${lives()} Lives, ` +
      `${m.maxAttemptSeconds} s per attempt${id && !done ? '; attempt ' + id.slice(0, 8) + ' resumed' : ''} (asked for ${req && req.gameId} / ${req && req.datasetVersion}).`);
    return out;
  }

  const inflight = {};
  function enterStage(req) {
    const id = req && req.requestId;
    if (typeof id !== 'string' || !id || !Number.isInteger(req.stage)) return Promise.reject(err('bad_response', { definitive: true }));
    const prev = store.starts[id] && store.attempts[store.starts[id]];
    if (prev && prev.stage === req.stage && live(prev)) { log(`Entry ${id.slice(0, 8)}: answered before, same admission (no second Life).`); return Promise.resolve({ admissionId: store.starts[id], stage: prev.stage }); }
    if (inflight[id]) return inflight[id];
    return (inflight[id] = doEnter(req).finally(() => { delete inflight[id]; }));
  }
  async function doEnter(req) {
    const id = req.requestId, stage = req.stage;
    if (store.sent[id]) {
      // Sent before and the answer never came: the API cannot look it up. Never sent again (a second Life).
      delete store.sent[id]; save();
      log(`Entry ${id.slice(0, 8)} for stage ${stage}: earlier answer lost; not resent, Lives re-read.`);
      throw await fresh(err('stage.start_unknown', { definitive: true, resync: true }));
    }
    store.sent[id] = { stage, at: Date.now() }; save();
    let data;
    try { data = await request('/play/plays', { method: 'POST', body: { bootToken: token, stage } }); }
    catch (e) {
      if (e.definitive) { delete store.sent[id]; save(); e.resync = true; throw await fresh(e); }
      // Unknown: their session keeps the same requestId; the next tap gets the branch above.
      e.message = '参加結果を確認できません。もう一度「START」を押してください。';
      throw e;
    }
    const sm = data.stageMode, deadline = Date.parse(sm && sm.deadlineAt), expires = Date.parse(data.expiresAt);
    if (typeof data.playToken !== 'string' || !data.playToken || !sm || sm.stage !== stage || !Number.isFinite(deadline) || !(sm.maxAttemptSeconds > 0)) {
      delete store.sent[id]; save(); throw err('bad_response', { resync: true });
    }
    if (sm.kind !== 'PAID') log(`Stage ${stage} entry is ${sm.kind} (their rules expect a paid entry).`);
    const startedAt = Date.now(), admissionId = (crypto.randomUUID ? crypto.randomUUID() : startedAt + '-' + Math.random().toString(36).slice(2));
    // The local end of the attempt, so a clock difference with the server never gives extra time.
    const end = Math.min(deadline, Number.isFinite(expires) ? expires : Infinity, startedAt + sm.maxAttemptSeconds * 1000);
    store.attempts[admissionId] = { token: data.playToken, stage, startedAt, end, limit: sm.maxAttemptSeconds, kind: sm.kind, clear: null, result: null, dead: false };
    store.starts[id] = admissionId; delete store.sent[id]; save();
    try { await readContext(); } catch { log('Lives not re-read after the entry; the next call refreshes them.'); }
    log(`Stage ${stage} entered (${sm.kind}, ${sm.maxAttemptSeconds} s), ${lives()} Lives left.`);
    emit('attempt', { admissionId, stage });
    return { admissionId, stage };
  }

  function submitClear(req) {
    const id = req && req.admissionId;
    if (inflight['c:' + id]) return inflight['c:' + id];
    return (inflight['c:' + id] = doClear(req).finally(() => { delete inflight['c:' + id]; }));
  }
  const DONE = ['CLEARED', 'ALREADY_CLEARED', 'REPLAY'];
  async function doClear(req) {
    const a = store.attempts[req.admissionId];
    if (!a || a.stage !== req.stage) throw await fresh(err('stage.attempt_lost', { definitive: true, resync: true, over: true }));
    if (a.dead) throw finish(a, 'stage.time_exceeded');
    if (!a.result) {
      if (!a.clear) {
        // Their moves on their own engine, as their server/verify-clear.cjs does: every move changes the board, the
        // last one completes it.
        let g = PuzzleEngine.initial(LEVELS[a.stage - 1]), ok = Array.isArray(req.moves) && req.moves.length > 0;
        for (const d of ok ? req.moves : []) {
          if (!['up', 'right', 'down', 'left'].includes(d) || PuzzleEngine.complete(g)) { ok = false; break; }
          const next = PuzzleEngine.slide(g, d); if (JSON.stringify(next) === JSON.stringify(g)) { ok = false; break; } g = next;
        }
        if (!ok || !PuzzleEngine.complete(g)) { log(`Stage ${a.stage}: moves do not solve the stage; not reported.`); throw err('stage.invalid_moves', { definitive: true }); }
        // The same body on every resend (the server answers a repeat with its stored verdict).
        a.clear = { sessionToken: a.token, playTimeMs: Math.max(0, Date.now() - a.startedAt) }; save();
      }
      await report(a);
      try { await readContext(); } catch { /* the clear answer stands */ }
    }
    if (a.result.status === 'TIME_EXCEEDED') throw finish(a, 'stage.time_exceeded');
    return { cleared: true, nextStage: a.stage + 1, completedAll: a.stage === ENV.totalStages };
  }
  async function report(a) {
    let data;
    try { data = await request('/play/stage-clears', { method: 'POST', body: a.clear }); }
    catch (e) {
      log(`Stage ${a.stage} clear not confirmed (${e.code}).`);
      if (e.code === 'play.session_token_expired' || e.code === 'play.session_token_invalid') throw finish(a, 'play.session_token_expired');
      if (e.definitive) e.resync = true;
      throw e;   // their game offers 「クリア結果を再送」: the same body again
    }
    if (![...DONE, 'TIME_EXCEEDED'].includes(data.status) || data.stage !== a.stage) throw err('bad_response');
    a.result = data;
    if (data.reward) { store.reward = data.reward; emit('reward', data.reward); }
    save();
    log(`Stage ${a.stage} clear: ${data.status} (${data.highestCleared}/${data.totalStages} cleared${data.reward ? ', reward ' + data.reward.status : ''}).`);
  }

  window.GameBullHost = { getSession, enterStage, submitClear };

  // For gb/yc-hooks.js only (their game never sees it).
  window.YukiyaGB = {
    lives,
    stageMode: () => last && last.stageMode,
    // The running attempt's time left (ms), null when there is none (or it is won and waiting for its report).
    remainingMs(admissionId) { const a = store.attempts[admissionId]; return a && !a.dead && !a.result && !a.clear ? Math.max(0, a.end - Date.now()) : null; },
    limitSeconds(admissionId) { const a = store.attempts[admissionId]; return a ? a.limit : null; },
    // Their board reached the attempt's deadline without a clear: the attempt is over.
    expire(admissionId) { const a = store.attempts[admissionId]; if (a && alive(a) === false && !a.dead && !a.result && !a.clear) { log(`Stage ${a.stage}: time is up (${a.limit} s).`); finish(a, 'stage.time_exceeded'); } },
    reward: () => store.reward,
    rewardClaimed: () => !!(last && last.stageMode && last.stageMode.rewardClaimed),
  };
})();
