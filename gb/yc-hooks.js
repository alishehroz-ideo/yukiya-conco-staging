'use strict';
/* 雪屋Conco かき氷パズル: GameBull hooks, loaded after the client's game.js (their files unchanged). Classic scripts
 * share globals, so their top-level lets (flow, initialized, admission, won, pending, confirmed, index) and functions
 * (titleMessage, message, render) are read and used here. What this adds, all for GameBull Stage Mode:
 *  - their session read at load (their own flow.initialize(): /context, no Life), so the loading page comes down on a
 *    known state and a launch that cannot play says so at once;
 *  - a small pill with the server's Lives, and during an attempt the time left (GameBull requires a time per attempt;
 *    their game has none). At 0 the attempt is over: their TOP, with the reason; their START then enters anew;
 *  - after a refusal from the bridge (error.resync) their session is re-read on the next START (their
 *    `initialized` back to false), so the stage, Lives and admission always come from the server;
 *  - the all-clear voucher card (status from the server), whose button closes the game into the GameBull app's
 *    coupon (gamebull:close + to: /coupons/<id>, relayed by the loading page; trap W18);
 *  - a 「GameBullに戻る」 button when the launch cannot play (Game Start, no launch, admin stage count);
 *  - audioSession "playback" on the first tap while their sound is on (iPhone silent switch, trap W2).
 */
(function () {
  const ENV = window.YUKIYA_GB || {};
  const gb = window.YukiyaGB, host = window.GameBullHost;
  const q = s => document.querySelector(s);
  const embedded = window.parent !== window;
  const log = s => console.log('[YC-GB] ' + s);
  log(`Build v${ENV.build} (${ENV.gameId}, ${ENV.totalStages} stages, ${ENV.datasetVersion}, API ${ENV.apiBase}).`);

  function closeToGameBull(to) {
    if (!embedded) return false;
    const msg = { type: 'gamebull:close' }; if (to) msg.to = to;
    log('gamebull:close ' + JSON.stringify(msg) + ' (through the loading page relay).');
    window.parent.postMessage(msg, location.origin);
    return true;
  }

  /* ── styles for the few GameBull elements (scoped to .ycgb-*, trap W10); colours from their café art ── */
  const css = document.createElement('style');
  css.textContent = `
  .ycgb-pill{position:fixed;z-index:20;top:calc(8px + env(safe-area-inset-top,0px));right:10px;display:flex;flex-direction:column;align-items:flex-end;gap:5px;pointer-events:none;
    font:700 13px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap}
  .ycgb-pill span{padding:6px 10px;border-radius:999px;background:rgba(91,63,43,.86);color:#fff4e2;box-shadow:0 2px 6px rgba(0,0,0,.18)}
  .ycgb-pill .ycgb-low{background:#d84a4f;color:#fff}
  .ycgb-back{all:unset;cursor:pointer;display:block;margin:10px auto 0;padding:9px 18px;border-radius:12px;background:#5b3f2b;
    color:#fff4e2;font:700 14px system-ui,sans-serif;text-align:center}
  .ycgb-reward{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;
    background:rgba(60,40,28,.6);padding:16px;box-sizing:border-box}
  .ycgb-card{width:min(360px,100%);background:#fff8ee;border:3px solid #e8a0a4;border-radius:18px;padding:20px 18px;
    box-sizing:border-box;text-align:center;color:#5b3f2b;font:500 14px/1.55 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3)}
  .ycgb-card h2{margin:0 0 4px;font-size:22px}
  .ycgb-card h3{margin:12px 0 2px;font-size:17px}
  .ycgb-card p{margin:6px 0}
  .ycgb-card img{display:block;max-width:100%;max-height:160px;margin:10px auto;border-radius:10px}
  .ycgb-card button{all:unset;box-sizing:border-box;cursor:pointer;display:block;width:100%;margin-top:10px;padding:11px 12px;
    border-radius:12px;text-align:center;font:700 15px system-ui,sans-serif}
  .ycgb-card .ycgb-primary{background:#e8676b;color:#fff}
  .ycgb-card .ycgb-secondary{background:#efe2cf;color:#5b3f2b}`;
  document.head.appendChild(css);

  /* ── Lives / time pill ── */
  const pill = document.createElement('div'); pill.className = 'ycgb-pill'; pill.hidden = true; pill.setAttribute('aria-live', 'off');
  const livesEl = document.createElement('span'), timeEl = document.createElement('span');
  pill.append(timeEl, livesEl); document.body.append(pill);
  const fmt = ms => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  addEventListener('yukiya-gb:context', e => { const n = e.detail.lives; livesEl.textContent = 'ライフ ' + (n == null ? '—' : n); pill.hidden = false; });

  setInterval(() => {
    const id = admission && admission.admissionId, left = id ? gb.remainingMs(id) : null;
    const show = left != null && !won && !q('#game-screen').hidden;
    timeEl.hidden = !show;
    if (show) { timeEl.textContent = '残り ' + fmt(left); timeEl.classList.toggle('ycgb-low', left <= 60000); }
    // The attempt's time is up with no clear (on their board or back on their TOP): it is over.
    if (left === 0 && !won && !pending) gb.expire(id);
  }, 250);

  /* ── the end of an attempt: their TOP with the reason; their START enters anew (1 Life) ── */
  addEventListener('yukiya-gb:attempt-over', e => {
    const text = e.detail.message;
    // After their own catch / finally (their submitWin shows its line and re-renders first).
    setTimeout(() => {
      admission = null; initialized = false; won = false; confirmed = false;
      q('#game-screen').hidden = true; q('#title-screen').hidden = false;
      titleMessage(text); message(text);
      log(`Stage ${e.detail.stage}: attempt over (${e.detail.code}); their TOP, a new entry is a new Life.`);
    }, 0);
  });

  /* ── a refusal: their session is re-read on the next START ── */
  for (const k of ['getSession', 'enterStage', 'submitClear']) {
    const theirs = host[k];
    host[k] = function () {
      return theirs.apply(host, arguments).catch(e => { if (e && e.resync) initialized = false; throw e; });
    };
  }

  /* ── the all-clear voucher (wording: the other Stage Mode ports' screens) ── */
  const safeUrl = v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u : null; } catch { return null; } };
  function showReward(reward) {
    if (q('.ycgb-reward')) return;
    const text = { ISSUED: 'ギフト券が発行され、GameBullのクーポン一覧に入りました。', ALREADY_CLAIMED: 'この店舗の報酬はすでに受け取り済みです。',
      NONE_CONFIGURED: '', OUT_OF_STOCK: '報酬は一時的に在庫切れです。後でGameBullアプリのゲーム画面から受け取れます。' }[reward.status] ?? '報酬の状態はGameBullでご確認ください。';
    const wrap = document.createElement('div'); wrap.className = 'ycgb-reward'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
    const card = document.createElement('div'); card.className = 'ycgb-card'; wrap.append(card);
    const add = (tag, value) => { if (!value) return; const el = document.createElement(tag); el.textContent = value; card.append(el); };
    add('h2', '全600ステージクリア！');
    if (reward.status !== 'NONE_CONFIGURED') add('h3', reward.title || '全クリア報酬');
    add('p', text); add('p', reward.benefit);
    const img = safeUrl(reward.imageUrl);
    if (img && reward.status !== 'NONE_CONFIGURED') { const im = new Image(); im.alt = reward.title || '全クリア報酬'; im.referrerPolicy = 'no-referrer'; im.src = img.href; card.append(im); }
    const redeem = reward.status === 'ISSUED' && safeUrl(reward.redeemUrl);
    if (redeem) {
      const b = document.createElement('button'); b.className = 'ycgb-primary'; b.textContent = 'GameBullでギフト券を開く';
      // Inside the app the frame has no allow-popups: close the game and let the app open the coupon
      // (gamebull-whitelabel d85807c honours to: /coupons/<id>). Outside the app, open the wallet link.
      b.onclick = () => { const m = /^\/coupons\/[^/?#]+$/.exec(redeem.pathname); if (!closeToGameBull(m ? m[0] : undefined)) window.open(redeem.href, '_blank', 'noopener,noreferrer'); };
      card.append(b);
    }
    const c = document.createElement('button'); c.className = 'ycgb-secondary'; c.textContent = '閉じる';
    c.onclick = () => wrap.remove(); card.append(c);
    document.body.append(wrap);
    log('All-clear reward card: ' + reward.status + '.');
  }
  addEventListener('yukiya-gb:reward', e => showReward(e.detail));

  /* ── at load: their session (no Life), then the loading page comes down ── */
  const FATAL = ['stage.mode_required', 'stage.launch_required', 'stage.total_mismatch', 'play.mode_not_enabled', 'play.session_token_invalid', 'guest.session_invalid', 'bad_context'];
  const done = () => { try { window.parent.gbLoaderProgress && window.parent.gbLoaderProgress(1); window.parent.gbLoaderDone && window.parent.gbLoaderDone(); } catch { /* not in our frame */ } };
  flow.initialize().then(s => {
    initialized = true;
    log(`Session ready: next stage ${s.nextStage}${s.completedAll ? ' (all cleared)' : ''}${s.admission ? ', running attempt resumed' : ''}.`);
  }).catch(e => {
    titleMessage(e.message || 'GameBullへの接続に失敗しました。');
    log('Start-up: ' + (e.code || '') + ' ' + e.message);
    if (embedded && FATAL.includes(e.code)) {
      const b = document.createElement('button'); b.className = 'ycgb-back'; b.textContent = 'GameBullに戻る'; b.onclick = () => closeToGameBull();
      q('#title-message').after(b);
    }
  }).finally(done);

  /* ── iPhone: their sounds play with the silent switch on (trap W2); their music / effects default ON ── */
  document.addEventListener('pointerdown', () => {
    let p = {}; try { p = JSON.parse(localStorage.getItem('jelly-audio') || '{}'); } catch { /* defaults */ }
    try { if ((p.music !== false || p.fx !== false) && navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* n/a */ }
  }, { capture: true, passive: true });
})();
