'use strict';

/* =========================================================
   設定値
   ========================================================= */
const STORE_KEY = 'toeic-drill:v1';
const VOCAB_INTERVALS = [1, 3, 7, 14, 30]; // 語彙：正解ごとに延ばす間隔（日）
const REVIEW_INTERVALS = [1, 3, 7];        // ミス復習：再出題の間隔（日）
const REVIEW_CLEAR_STREAK = 3;             // 「確実」かつ正解がこの回数続いたら復習から外す
const BACKUP_REMIND_DAYS = 14;
const DEFAULT_SETTINGS = { vocabPerDay: 10, part5PerDay: 12, reviewLimit: 15 };

const CONFIDENCE = { sure: '確実', unsure: '迷った', guess: '勘' };
const MISTAKE_REASONS = [
  '読み飛ばし', '早とちり', '品詞', '時制', '主語と動詞の一致',
  '前置詞・接続詞', '語彙を知らなかった', '言い換えに気づかなかった', 'その他',
];
const STAGE_LABELS = { vocab: '語彙', main: 'Part 5', review: 'ミス復習' };
const POS_LABELS = { verb: '動詞', noun: '名詞', adjective: '形容詞', adverb: '副詞' };
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

/* =========================================================
   日付（端末のローカル日付で扱う）
   ========================================================= */
function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function today() { return formatDate(new Date()); }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return formatDate(d); }
function shortDate(s) { const d = parseDate(s); return `${d.getMonth() + 1}/${d.getDate()}`; }
function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }

/* =========================================================
   学習記録（localStorage）
   ========================================================= */
let state;

function defaultState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    logs: [],        // 1回答ごとの記録
    reviews: {},     // ミス復習中の問題 { id: { streak, next, added } }
    vocab: {},       // 語彙の間隔反復 { id: { stage, next, correct, wrong } }
    seen: {},        // Part 5 をメインで出題した回数 { id: n }
    session: null,   // 進行中のセッション（途中再開用）
    dailyDone: null, // 今日のドリルを終えた日付
    lastBackup: null,
  };
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function normalizeState(raw) {
  const base = defaultState();
  if (!isObj(raw)) return base;
  return {
    ...base,
    ...raw,
    settings: { ...base.settings, ...(isObj(raw.settings) ? raw.settings : {}) },
    logs: Array.isArray(raw.logs) ? raw.logs : [],
    reviews: isObj(raw.reviews) ? raw.reviews : {},
    vocab: isObj(raw.vocab) ? raw.vocab : {},
    seen: isObj(raw.seen) ? raw.seen : {},
  };
}

function loadState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORE_KEY)));
  } catch {
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('記録を保存できませんでした。設定からバックアップを書き出してください。');
  }
}

/* =========================================================
   問題データ
   ========================================================= */
const data = { part5: [], part5ById: new Map(), vocab: [], vocabById: new Map(), vocabByWord: new Map(), related: new Map() };

async function loadData() {
  const [part5, vocab] = await Promise.all(['data/part5.json', 'data/vocab.json'].map(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} (${res.status})`);
    return res.json();
  }));
  data.part5 = part5;
  data.vocab = vocab;
  part5.forEach((q) => data.part5ById.set(q.id, q));
  vocab.forEach((v) => {
    data.vocabById.set(v.id, v);
    data.vocabByWord.set(v.word.toLowerCase(), v);
  });
  // related（紛らわしい語）は双方向に登録して、誤答の選択肢に使わない
  const link = (a, b) => {
    if (!data.related.has(a)) data.related.set(a, new Set());
    data.related.get(a).add(b);
  };
  for (const v of vocab) {
    for (const w of v.related || []) {
      const other = data.vocabByWord.get(w.toLowerCase());
      if (other) { link(v.id, other.id); link(other.id, v.id); }
    }
  }
}

/* =========================================================
   小物
   ========================================================= */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findWord(sentence, word) {
  const m = sentence.match(new RegExp(`\\b${escRe(word)}\\b`, 'i'));
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* =========================================================
   間隔反復
   ========================================================= */
// 語彙：正解で 1→3→7→14→30日後、不正解で1日後に戻す
function updateVocab(id, correct, date) {
  const v = state.vocab[id] || { stage: 0, next: null, correct: 0, wrong: 0 };
  if (correct) {
    v.next = addDays(date, VOCAB_INTERVALS[Math.min(v.stage, VOCAB_INTERVALS.length - 1)]);
    v.stage = Math.min(v.stage + 1, VOCAB_INTERVALS.length);
    v.correct++;
  } else {
    v.stage = 0;
    v.next = addDays(date, 1);
    v.wrong++;
  }
  state.vocab[id] = v;
  return v.next;
}

// ミス復習：不正解・迷った・勘 → 1日後。復習中に「確実」かつ正解なら 3日後→7日後→卒業
function updateReview(id, correct, confidence, date) {
  const solid = correct && confidence === 'sure';
  const r = state.reviews[id];
  if (!r) {
    if (solid) return null;
    state.reviews[id] = { streak: 0, next: addDays(date, REVIEW_INTERVALS[0]), added: date };
    return state.reviews[id].next;
  }
  if (solid) {
    r.streak++;
    if (r.streak >= REVIEW_CLEAR_STREAK) {
      delete state.reviews[id];
      return null;
    }
    r.next = addDays(date, REVIEW_INTERVALS[r.streak]);
  } else {
    r.streak = 0;
    r.next = addDays(date, REVIEW_INTERVALS[0]);
  }
  return r.next;
}

/* =========================================================
   セッションの組み立て
   ========================================================= */
function meaningTokens(v) {
  return v.meaning.replace(/[（(][^）)]*[）)]/g, '').split(/[、,]/).map((s) => s.trim()).filter(Boolean);
}

// 意味が紛らわしい語は誤答の選択肢にしない
function isConfusable(a, b) {
  if (data.related.get(a.id)?.has(b.id)) return true;
  const tb = new Set(meaningTokens(b));
  return meaningTokens(a).some((t) => tb.has(t));
}

function pickDistinct(candidates, n, exclude) {
  const used = new Set([...exclude].map((s) => s.toLowerCase()));
  const out = [];
  for (const c of candidates) {
    const k = c.toLowerCase();
    if (used.has(k)) continue;
    used.add(k);
    out.push(c);
    if (out.length === n) break;
  }
  return out;
}

function buildVocabItem(v) {
  const modes = ['meaning'];
  if (findWord(v.example, v.word)) {
    modes.push('blank');
    if (v.synonyms?.length) modes.push('paraphrase');
  }
  const mode = modes[Math.floor(Math.random() * modes.length)];
  const others = shuffle(data.vocab.filter((o) => o.id !== v.id && !isConfusable(v, o)));
  const samePos = others.filter((o) => o.pos === v.pos);
  const pool = samePos.length >= 3 ? samePos : others;

  let correct;
  let wrong;
  if (mode === 'meaning') {
    correct = v.meaning;
    wrong = pickDistinct(pool.map((o) => o.meaning), 3, [correct]);
  } else if (mode === 'blank') {
    correct = v.word;
    wrong = v.distractors?.length >= 3
      ? shuffle(v.distractors).slice(0, 3)
      : pickDistinct(pool.map((o) => o.word), 3, [correct]);
  } else {
    correct = v.synonyms[0];
    wrong = pickDistinct(pool.map((o) => o.synonyms?.[0]).filter(Boolean), 3, v.synonyms);
  }
  const choices = shuffle([correct, ...wrong]);
  return { stage: 'vocab', id: v.id, mode, choices, answer: choices.indexOf(correct) };
}

function buildPart5Item(stage, q) {
  return { stage, id: q.id, order: shuffle(q.choices.map((_, i) => i)) };
}

function buildSession(date, extra = false) {
  const st = state.settings;
  const items = [];

  // 1. 語彙：期限の来た語を優先し、残りを新しい語で埋める
  if (!extra) {
    const due = data.vocab
      .filter((v) => state.vocab[v.id] && state.vocab[v.id].next <= date)
      .sort((a, b) => state.vocab[a.id].next.localeCompare(state.vocab[b.id].next));
    const fresh = data.vocab.filter((v) => !state.vocab[v.id]);
    shuffle([...due, ...fresh].slice(0, st.vocabPerDay)).forEach((v) => items.push(buildVocabItem(v)));
  }

  // 2. メイン：復習中の問題を除き、出題回数の少ない問題から
  const inReview = new Set(Object.keys(state.reviews));
  shuffle(data.part5.filter((q) => !inReview.has(q.id)))
    .sort((a, b) => (state.seen[a.id] || 0) - (state.seen[b.id] || 0))
    .slice(0, st.part5PerDay)
    .forEach((q) => items.push(buildPart5Item('main', q)));

  // 3. ミス復習：期限の来たものを古い順に、1日の上限まで（残りは翌日以降へ）
  if (!extra) {
    Object.entries(state.reviews)
      .filter(([id, r]) => r.next <= date && data.part5ById.has(id))
      .sort((a, b) => a[1].next.localeCompare(b[1].next))
      .slice(0, st.reviewLimit)
      .forEach(([id]) => items.push(buildPart5Item('review', data.part5ById.get(id))));
  }

  return { date, extra, items, index: 0, current: null, finished: false };
}

function dueReviewCount(date) {
  return Object.values(state.reviews).filter((r) => r.next <= date).length;
}

function dueVocabCount(date) {
  return Object.values(state.vocab).filter((v) => v.next && v.next <= date).length;
}

/* =========================================================
   画面遷移
   ========================================================= */
const root = document.getElementById('app');
let route = 'home';
let shownAt = { index: -1, time: 0 }; // 回答時間の計測用

function go(r) {
  route = r;
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (route === 'session' && !activeSession()) route = 'home';
  ({ home: renderHome, session: renderSession, done: renderDone, settings: renderSettings })[route]();
}

function activeSession() {
  const s = state.session;
  return s && s.date === today() && !s.finished ? s : null;
}

/* ---------- ホーム ---------- */
function renderHome() {
  const date = today();
  if (state.session && state.session.date !== date) {
    state.session = null; // 前日の続きは持ち越さない（復習期限は残るので取りこぼしはない）
    saveState();
  }
  const s = activeSession();
  const doneToday = state.dailyDone === date;

  let todayCard;
  if (s) {
    todayCard = `
      <h2>${s.extra ? '追加セット' : '今日のドリル'}の途中です</h2>
      <p class="sub">${s.index} / ${s.items.length} 問まで回答済み</p>
      <button class="btn btn-primary" data-action="resume">続きから</button>`;
  } else if (doneToday) {
    todayCard = `
      <div class="done-badge">✓ 今日のドリルは完了</div>
      <button class="btn" data-action="result">今日の結果を見る</button>
      <button class="btn" data-action="extra">Part 5 をもう1セット</button>`;
  } else {
    const st = state.settings;
    const vocabDue = Math.min(dueVocabCount(date), st.vocabPerDay);
    const reviewDue = dueReviewCount(date);
    const reviewTake = Math.min(reviewDue, st.reviewLimit);
    todayCard = `
      <h2>今日のドリル</h2>
      <ul class="plan">
        <li><span>1. 語彙</span><span>${st.vocabPerDay}問${vocabDue ? `（うち復習 ${vocabDue}）` : ''}</span></li>
        <li><span>2. Part 5</span><span>${st.part5PerDay}問</span></li>
        <li><span>3. ミス復習</span><span>${reviewTake}問${reviewDue > reviewTake ? `（残り ${reviewDue - reviewTake} は翌日以降）` : ''}</span></li>
      </ul>
      <button class="btn btn-primary" data-action="start">はじめる</button>`;
  }

  const month = date.slice(0, 7);
  const practiced = new Set(state.logs.filter((l) => l.date.startsWith(month)).map((l) => l.date));
  const vocabLearning = Object.keys(state.vocab).length;
  const vocabMastered = Object.values(state.vocab).filter((v) => v.stage >= VOCAB_INTERVALS.length).length;
  const unseen = data.part5.filter((q) => !state.seen[q.id] && !state.reviews[q.id]).length;

  let backupNote = '';
  if (state.logs.length >= 20 && (!state.lastBackup || daysBetween(state.lastBackup, date) >= BACKUP_REMIND_DAYS)) {
    backupNote = `<div class="notice">${state.lastBackup ? `前回のバックアップから${daysBetween(state.lastBackup, date)}日たちました。` : 'まだバックアップがありません。'}
      スマホのブラウザは保存データを消すことがあるので、<a href="#" data-action="settings">設定</a>から書き出しておきましょう。</div>`;
  }

  root.innerHTML = `
    <div class="home-head">
      <h1>TOEIC 毎日ドリル</h1>
      <button class="icon-btn" data-action="settings" aria-label="設定">⚙︎</button>
    </div>
    <p class="sub">${parseDate(date).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })}</p>
    ${backupNote}
    <div class="card today-card">${todayCard}</div>
    <div class="stats">
      <div class="stat"><b>${practiced.size}</b><span>今月の実施日数</span></div>
      <div class="stat"><b>${Object.keys(state.reviews).length}</b><span>ミス復習中</span></div>
      <div class="stat"><b>${vocabMastered}<small style="font-size:14px">/${vocabLearning}</small></b><span>語彙 定着/学習中</span></div>
    </div>
    <div class="card">
      <h2>${parseDate(date).getMonth() + 1}月の記録</h2>
      ${calendarHTML(date, practiced)}
    </div>
    <p class="sub page-foot">未出題の Part 5：${unseen} 問 ／ 未学習の語彙：${data.vocab.length - vocabLearning} 語</p>`;
}

function calendarHTML(date, practiced) {
  const d = parseDate(date);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  let html = '日月火水木金土'.split('').map((w) => `<div class="wd">${w}</div>`).join('');
  html += '<div></div>'.repeat(first.getDay());
  for (let i = 1; i <= days; i++) {
    const ds = formatDate(new Date(d.getFullYear(), d.getMonth(), i));
    html += `<div class="d${practiced.has(ds) ? ' on' : ''}${ds === date ? ' today' : ''}">${i}</div>`;
  }
  return `<div class="cal">${html}</div>`;
}

/* ---------- 出題 ---------- */
function stageProgress(s) {
  const item = s.items[s.index];
  const sameStage = s.items.filter((it) => it.stage === item.stage);
  const pos = s.items.slice(0, s.index + 1).filter((it) => it.stage === item.stage).length;
  return `${STAGE_LABELS[item.stage]} ${pos}/${sameStage.length}`;
}

function renderSession() {
  const s = activeSession();
  if (s.index >= s.items.length) { finishSession(); return; }
  const item = s.items[s.index];
  if (!s.current || s.current.index !== s.index) {
    s.current = { index: s.index, selected: null, answered: false };
    saveState();
  }
  if (shownAt.index !== s.index) shownAt = { index: s.index, time: Date.now() };

  const top = `
    <div class="topbar">
      <button class="icon-btn" data-action="home" aria-label="中断してホームへ（続きから再開できます）">✕</button>
      <div class="progress"><div style="width:${(s.index / s.items.length) * 100}%"></div></div>
      <span class="count">${s.index + 1}/${s.items.length}</span>
    </div>`;
  const body = item.stage === 'vocab' ? vocabView(item, s.current) : part5View(item, s.current);
  root.innerHTML = top + body;
}

function choiceButtons(labels, cur, isCorrect) {
  return `<div class="choices">${labels.map((label, i) => {
    let cls = 'choice';
    if (cur.answered) {
      if (isCorrect(i)) cls += ' correct';
      else if (i === cur.selected) cls += ' wrong';
      else cls += ' dim';
    } else if (i === cur.selected) {
      cls += ' selected';
    }
    return `<button class="${cls}" data-action="select" data-i="${i}" ${cur.answered ? 'disabled' : ''}>
      <span class="letter">${LETTERS[i]}</span><span>${esc(label)}</span></button>`;
  }).join('')}</div>`;
}

function fillBlank(text, cur, answerText) {
  const filled = cur.answered ? `<span class="blank filled">${esc(answerText)}</span>` : '<span class="blank">&nbsp;</span>';
  return esc(text).replace(/-{3,}/, filled);
}

function part5View(item, cur) {
  const q = data.part5ById.get(item.id);
  const labels = item.order.map((i) => q.choices[i]);
  const isCorrect = (i) => item.order[i] === q.answer;
  const chip = item.stage === 'review'
    ? `<span class="chip review">${stageProgress(state.session)}</span>`
    : `<span class="chip">${stageProgress(state.session)} · ${q.category === 'vocabulary' ? '語彙' : '文法'}</span>`;

  let feedback = '';
  let action;
  if (!cur.answered) {
    action = cur.selected === null
      ? '<p class="hint">選択肢をタップ（タップし直して変更できます）</p>'
      : `<p class="label">（${LETTERS[cur.selected]}）で回答。確信度は？</p>
         <div class="conf">${Object.entries(CONFIDENCE).map(([k, v]) => `<button class="btn ${k === 'sure' ? 'btn-primary' : ''}" data-action="confidence" data-c="${k}">${v}</button>`).join('')}</div>`;
  } else {
    feedback = part5Feedback(item, q, cur);
    const needReason = !cur.correct && !cur.reason;
    action = `<button class="btn btn-primary" data-action="next" ${needReason ? 'disabled' : ''}>
      ${needReason ? '↑ ミスの原因を選んでください' : (state.session.index + 1 >= state.session.items.length ? '結果を見る' : '次へ')}</button>`;
  }

  return `
    <div class="qbody">
      ${chip}
      <p class="question">${fillBlank(q.question, cur, q.choices[q.answer])}</p>
      ${choiceButtons(labels, cur, isCorrect)}
      ${feedback}
    </div>
    <div class="actionbar">${action}</div>`;
}

function part5Feedback(item, q, cur) {
  const conf = CONFIDENCE[cur.confidence];
  let flags = '';
  if (!cur.correct && cur.confidence === 'sure') {
    flags += '<div class="flag danger">⚠ 「確実」で間違えた ＝ 危険なミス。どこで思い込んだかを確認しましょう。</div>';
  } else if (cur.correct && cur.confidence !== 'sure') {
    flags += `<div class="flag">正解でも「${conf}」だったので、${item.stage === 'review' ? '復習を続けます' : '復習リストに入れました'}（${shortDate(cur.nextReview)} に再出題）。</div>`;
  }
  if (item.stage === 'review') {
    if (cur.nextReview === null) flags += '<div class="flag" style="background:var(--ok-soft);color:var(--ok)">🎉 3回連続「確実」で正解。この問題は復習から外れました。</div>';
    else if (cur.correct && cur.confidence === 'sure') flags += `<div class="flag" style="background:var(--ok-soft);color:var(--ok)">「確実」で正解（${state.reviews[q.id]?.streak ?? 0}/${REVIEW_CLEAR_STREAK}）。次は ${shortDate(cur.nextReview)}。</div>`;
  }
  if (!cur.correct) flags += `<div class="flag">${shortDate(cur.nextReview)} にもう一度出題します。</div>`;

  const reasons = cur.correct ? '' : `
    <div class="reasons">
      <h3>ミスの原因は？（1つ選ぶ）</h3>
      <div class="reason-grid">${MISTAKE_REASONS.map((r) => `<button class="reason ${cur.reason === r ? 'selected' : ''}" data-action="reason" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
    </div>`;

  return `
    <div class="feedback card">
      <div class="result ${cur.correct ? 'ok' : 'ng'}">${cur.correct ? '○ 正解' : '× 不正解'}<small>確信度：${conf}</small></div>
      ${flags}
      <div class="explain">
        <h3>解説</h3><p>${esc(q.explanation)}</p>
        <h3>引っかけポイント</h3><p>${esc(q.trap)}</p>
      </div>
      ${q.tags?.length ? `<div class="tags">${q.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      ${reasons}
    </div>`;
}

function vocabView(item, cur) {
  const v = data.vocabById.get(item.id);
  const isCorrect = (i) => i === item.answer;
  let prompt;
  if (item.mode === 'meaning') {
    prompt = `<p class="prompt">意味を選んでください</p>
      <div class="word">${esc(v.word)}</div><div class="pos">${POS_LABELS[v.pos] || ''}</div>`;
  } else {
    const r = findWord(v.example, v.word);
    const before = esc(v.example.slice(0, r.start));
    const after = esc(v.example.slice(r.end));
    const hit = esc(v.example.slice(r.start, r.end));
    if (item.mode === 'blank') {
      const blank = cur.answered ? `<span class="blank filled">${hit}</span>` : '<span class="blank">&nbsp;</span>';
      prompt = `<p class="prompt">空欄に入る語は？</p><p class="question">${before}${blank}${after}</p>`;
    } else {
      prompt = `<p class="prompt">マークした語に最も近い意味の語は？</p><p class="question">${before}<mark>${hit}</mark>${after}</p>`;
    }
  }

  let feedback = '';
  let action = '<p class="hint">選択肢をタップすると答え合わせ</p>';
  if (cur.answered) {
    const notes = item.mode === 'blank'
      ? item.choices.filter((c) => c !== v.word).map((c) => {
        const o = data.vocabByWord.get(c.toLowerCase());
        return o ? `<li>${esc(c)}：${esc(o.meaning)}</li>` : '';
      }).join('')
      : '';
    const st = state.vocab[v.id];
    feedback = `
      <div class="feedback card">
        <div class="result ${cur.correct ? 'ok' : 'ng'}">${cur.correct ? '○ 正解' : '× 不正解'}<small>次は ${shortDate(st.next)}</small></div>
        <div class="explain">
          <h3>${esc(v.word)}（${POS_LABELS[v.pos] || ''}）</h3><p>${esc(v.meaning)}</p>
          <h3>同義語</h3><p>${esc(v.synonyms.join(', '))}</p>
          <h3>例文</h3><p>${esc(v.example)}</p>
          ${notes ? `<h3>ほかの選択肢</h3><ul class="choice-notes">${notes}</ul>` : ''}
        </div>
      </div>`;
    action = `<button class="btn btn-primary" data-action="next">${state.session.index + 1 >= state.session.items.length ? '結果を見る' : '次へ'}</button>`;
  }

  return `
    <div class="qbody">
      <span class="chip">${stageProgress(state.session)}</span>
      ${prompt}
      ${choiceButtons(item.choices, cur, isCorrect)}
      ${feedback}
    </div>
    <div class="actionbar">${action}</div>`;
}

function elapsedSeconds() {
  return Math.min(600, Math.round((Date.now() - shownAt.time) / 1000));
}

function afterAnswerRender() {
  render();
  document.querySelector('.feedback')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectChoice(i) {
  const s = activeSession();
  const item = s.items[s.index];
  const cur = s.current;
  if (cur.answered) return;
  cur.selected = i;
  if (item.stage !== 'vocab') { render(); return; }

  // 語彙はタップした時点で答え合わせ
  const date = today();
  const correct = i === item.answer;
  const next = updateVocab(item.id, correct, date);
  state.logs.push({ questionId: item.id, date, correct, confidence: null, seconds: elapsedSeconds(), mistakeReason: null, nextReview: next, stage: 'vocab', mode: item.mode });
  Object.assign(cur, { answered: true, correct });
  saveState();
  afterAnswerRender();
}

function answerPart5(confidence) {
  const s = activeSession();
  const item = s.items[s.index];
  const cur = s.current;
  if (cur.answered || cur.selected === null) return;
  const q = data.part5ById.get(item.id);
  const date = today();
  const correct = item.order[cur.selected] === q.answer;
  const next = updateReview(q.id, correct, confidence, date);
  if (item.stage === 'main') state.seen[q.id] = (state.seen[q.id] || 0) + 1;
  state.logs.push({ questionId: q.id, date, correct, confidence, seconds: elapsedSeconds(), mistakeReason: null, nextReview: next, stage: item.stage });
  Object.assign(cur, { answered: true, correct, confidence, nextReview: next, reason: null, logIndex: state.logs.length - 1 });
  saveState();
  afterAnswerRender();
}

function chooseReason(reason) {
  const cur = activeSession().current;
  cur.reason = reason;
  const log = state.logs[cur.logIndex];
  if (log) log.mistakeReason = reason;
  saveState();
  render();
}

function nextItem() {
  const s = activeSession();
  s.index++;
  s.current = null;
  if (s.index >= s.items.length) { finishSession(); return; }
  saveState();
  render();
  window.scrollTo(0, 0);
}

function finishSession() {
  const s = state.session;
  s.finished = true;
  if (!s.extra) state.dailyDone = s.date;
  saveState();
  go('done');
}

function startSession(extra) {
  const s = buildSession(today(), extra);
  if (!s.items.length) { toast('出題できる問題がありません'); return; }
  state.session = s;
  saveState();
  go('session');
}

/* ---------- 今日の結果 ---------- */
function renderDone() {
  const date = today();
  const logs = state.logs.filter((l) => l.date === date);
  const row = (stage) => {
    const ls = logs.filter((l) => l.stage === stage);
    if (!ls.length) return '';
    const ok = ls.filter((l) => l.correct).length;
    return `<div class="summary-row"><span>${STAGE_LABELS[stage]}</span><span>${ok} / ${ls.length} 正解</span></div>`;
  };
  const p5 = logs.filter((l) => l.stage !== 'vocab');
  const danger = p5.filter((l) => !l.correct && l.confidence === 'sure');
  const unsureOk = p5.filter((l) => l.correct && l.confidence !== 'sure').length;

  const reasonCount = {};
  p5.filter((l) => l.mistakeReason).forEach((l) => { reasonCount[l.mistakeReason] = (reasonCount[l.mistakeReason] || 0) + 1; });
  const reasons = Object.entries(reasonCount).sort((a, b) => b[1] - a[1]);

  const snippet = (id) => {
    const q = data.part5ById.get(id);
    if (!q) return esc(id);
    return esc(q.question.length > 70 ? `${q.question.slice(0, 70)}…` : q.question);
  };

  root.innerHTML = `
    <h1>今日の結果</h1>
    <p class="sub">${shortDate(date)} ・ 合計 ${logs.length} 問</p>
    <div class="card">${row('vocab')}${row('main')}${row('review')}${logs.length ? '' : '<p class="sub">今日はまだ回答がありません</p>'}</div>
    ${p5.length ? `<div class="card">
      <div class="summary-row"><span>⚠ 危険なミス（確実で不正解）</span><b style="color:var(--ng)">${danger.length}</b></div>
      <div class="summary-row"><span>正解だが迷った・勘（復習へ）</span><b>${unsureOk}</b></div>
    </div>` : ''}
    ${reasons.length ? `<div class="card"><h2>ミスの原因</h2>${reasons.map(([r, n]) => `<div class="summary-row"><span>${esc(r)}</span><span>${n}</span></div>`).join('')}</div>` : ''}
    ${danger.length ? `<div class="card"><h2>危険なミスの一覧</h2><ul class="miss-list">${danger.map((l) => `<li>${snippet(l.questionId)}<div class="meta">原因：${esc(l.mistakeReason || '未選択')}</div></li>`).join('')}</ul></div>` : ''}
    <div class="page-foot">
      <button class="btn btn-primary" data-action="home">ホームへ</button>
      <button class="btn" data-action="extra">Part 5 をもう1セット</button>
    </div>`;
}

/* ---------- 設定 ---------- */
function renderSettings() {
  const st = state.settings;
  const field = (key, label, min, max) => `
    <label class="field"><span>${label}</span>
      <input type="number" inputmode="numeric" min="${min}" max="${max}" value="${st[key]}" data-setting="${key}"></label>`;
  root.innerHTML = `
    <div class="topbar"><button class="icon-btn" data-action="home" aria-label="ホームへ">←</button><h1 style="margin:0">設定</h1></div>
    <div class="card">
      <h2>1日の問題数</h2>
      ${field('vocabPerDay', '語彙', 1, 50)}
      ${field('part5PerDay', 'Part 5', 1, 50)}
      ${field('reviewLimit', 'ミス復習の上限', 1, 100)}
      <p class="sub">復習が上限を超えた分は、翌日以降に回ります。次のドリルから反映されます。</p>
    </div>
    <div class="card">
      <h2>記録のバックアップ</h2>
      <p class="sub">スマホのブラウザは、しばらく使わないと保存データを消すことがあります。ときどき書き出して、iCloud Drive や Google ドライブに保存しておきましょう。</p>
      <p class="sub">前回の書き出し：${state.lastBackup ? shortDate(state.lastBackup) : 'なし'} ／ 回答記録：${state.logs.length} 件</p>
      <button class="btn btn-primary" data-action="export">記録を書き出す（JSON）</button>
      <button class="btn" data-action="import">記録を読み込む</button>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </div>
    <div class="card">
      <h2>データの消去</h2>
      <button class="btn btn-danger" data-action="reset">すべての記録を消去</button>
    </div>
    <p class="sub page-foot">問題データ：Part 5 ${data.part5.length} 問 ／ 語彙 ${data.vocab.length} 語</p>`;
}

async function exportBackup() {
  const name = `toeic-drill-backup-${today()}.json`;
  const json = JSON.stringify({ app: 'toeic-drill', exportedAt: new Date().toISOString(), state });
  const file = new File([json], name, { type: 'application/json' });
  const touch = window.matchMedia('(pointer: coarse)').matches;
  // スマホは共有シート（「ファイルに保存」など）、PC は通常のダウンロード
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      markBackup();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  markBackup();
}

function markBackup() {
  state.lastBackup = today();
  saveState();
  render();
  toast('書き出しました');
}

async function importBackup(file) {
  let raw;
  try {
    const parsed = JSON.parse(await file.text());
    raw = parsed.state ?? parsed;
    if (!Array.isArray(raw.logs) || !isObj(raw.reviews) || !isObj(raw.vocab)) throw new Error('format');
  } catch {
    toast('このファイルは読み込めませんでした');
    return;
  }
  if (!window.confirm(`バックアップ（回答記録 ${raw.logs.length} 件）を読み込みます。\n今の記録は上書きされます。よろしいですか？`)) return;
  state = normalizeState(raw);
  state.session = null;
  saveState();
  toast('読み込みました');
  go('home');
}

function resetAll() {
  if (!window.confirm('すべての学習記録を消去します。元に戻せません。')) return;
  if (!window.confirm('本当に消去しますか？（先にバックアップを書き出すことをおすすめします）')) return;
  state = defaultState();
  saveState();
  toast('消去しました');
  go('home');
}

/* =========================================================
   イベント
   ========================================================= */
const actions = {
  start: () => startSession(false),
  extra: () => startSession(true),
  resume: () => go('session'),
  home: () => go('home'),
  result: () => go('done'),
  settings: () => go('settings'),
  select: (el) => selectChoice(Number(el.dataset.i)),
  confidence: (el) => answerPart5(el.dataset.c),
  reason: (el) => chooseReason(el.dataset.r),
  next: () => nextItem(),
  export: () => exportBackup(),
  import: () => document.getElementById('import-file').click(),
  reset: () => resetAll(),
};

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  e.preventDefault();
  actions[el.dataset.action]?.(el);
});

root.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'import-file' && el.files[0]) {
    importBackup(el.files[0]);
    el.value = '';
  } else if (el.dataset.setting) {
    const n = Math.round(Number(el.value));
    const min = Number(el.min);
    const max = Number(el.max);
    state.settings[el.dataset.setting] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULT_SETTINGS[el.dataset.setting];
    el.value = state.settings[el.dataset.setting];
    saveState();
    toast('保存しました');
  }
});

// 日付をまたいで開きっぱなしだった場合や、別タブで更新された場合に表示を合わせる
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !data.part5.length) return;
  state = loadState();
  if (route === 'home' || !activeSession()) render();
});

/* =========================================================
   起動
   ========================================================= */
async function init() {
  state = loadState();
  try {
    await loadData();
  } catch (e) {
    root.innerHTML = `<div class="card" style="margin-top:30vh"><h2>問題データを読み込めませんでした</h2><p class="sub">${esc(e.message)}</p><button class="btn" onclick="location.reload()">再読み込み</button></div>`;
    return;
  }
  render();
  // 保存データがブラウザに消されにくくなるよう依頼（対応ブラウザのみ）
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
