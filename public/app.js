const $ = (id) => document.getElementById(id);
const state = { items: [], running: false, abort: null, stopFlag: false, caps: null, rootHandle: null, phase: 'idle' };
const VIDEO_RE = /\.(mp4|m4v|mov|mkv|avi|webm|flv|wmv|mpg|mpeg|ts|m2ts|mts|3gp|3g2|ogv|vob|divx|f4v|rm|rmvb|asf|mxf)$/i;
const HAS_HANDLE_API = typeof DataTransferItem !== 'undefined' && 'getAsFileSystemHandle' in DataTransferItem.prototype;

function fmtSize(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtDur(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg; t.className = `toast ${kind}`; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, 4200);
}

async function loadCaps() {
  try {
    const r = await fetch('/api/capabilities');
    const c = await r.json();
    state.caps = c;
    $('caps').innerHTML = '';
    const add = (text, cls, title) => {
      const s = document.createElement('span');
      s.className = `cap ${cls}`; s.textContent = text; if (title) s.title = title; $('caps').appendChild(s);
    };
    add(c.ffmpeg.split(' Copyright')[0], 'ok');
    add(c.untrunc ? 'untrunc 已就绪' : 'untrunc 未安装', c.untrunc ? 'ok' : 'bad');
    add(HAS_HANDLE_API ? '拖拽可原地覆盖' : '拖拽只读', HAS_HANDLE_API ? 'ok' : 'bad');
    if (c.logFile) add('运行日志 JSONL', '', c.logFile);
    if (!HAS_HANDLE_API) {
      const n = $('modeNote');
      n.hidden = false;
      n.innerHTML = '当前浏览器不支持 File System Access API（Safari / Firefox 均不支持），拖进来的文件<b>无法写回原路径</b>。'
        + '请改用「选择文件夹（原生）」或粘贴路径 —— 服务端直接原地修复，速度也更快。想用拖拽请换 Chrome / Edge。';
    }
  } catch { toast('无法连接本地服务', 'bad'); }
}

const status = { startedAt: 0, timer: null, total: 0, done: 0, repaired: 0, skipped: 0, failed: 0, mode: null };

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function renderStatusCounts() {
  $('statusCounts').innerHTML = status.mode === 'diagnose'
    ? `<span class="ok">健康 <b>${status.skipped}</b></span><span class="bad">有问题 <b>${status.failed}</b></span>`
    : `<span class="ok">修复 <b>${status.repaired}</b></span>`
      + `<span class="ok">跳过 <b>${status.skipped}</b></span><span class="bad">失败 <b>${status.failed}</b></span>`;
}

function startStatus(mode, total) {
  Object.assign(status, { startedAt: Date.now(), total, done: 0, repaired: 0, skipped: 0, failed: 0, mode });
  const p = $('statusPanel');
  p.hidden = false; p.classList.remove('done', 'warn', 'bad');
  $('failedPanel').hidden = true;
  $('statusTitle').textContent = mode === 'repair' ? '正在修复（覆盖原文件）' : '正在诊断';
  $('curFile').textContent = '准备中…';
  $('curIndex').textContent = total ? `1 / ${total}` : '';
  $('curStage').textContent = '启动中…';
  $('curMetrics').textContent = '';
  $('fileBar').classList.remove('indeterminate');
  $('fileBar').style.width = '0%';
  $('bar').style.width = '0%';
  $('overallText').textContent = `0 / ${total}`;
  $('elapsed').textContent = '00:00';
  renderStatusCounts();
  clearInterval(status.timer);
  status.timer = setInterval(() => { $('elapsed').textContent = fmtClock(Date.now() - status.startedAt); }, 500);
  p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function endStatus() {
  clearInterval(status.timer); status.timer = null;
  $('elapsed').textContent = fmtClock(Date.now() - status.startedAt);
  const p = $('statusPanel');
  p.classList.remove('done', 'warn', 'bad');
  const diagnose = status.mode === 'diagnose';
  let cls = 'done';
  let title = diagnose ? '诊断完成：全部健康' : '修复完成';
  let stage = '全部处理完毕';
  if (state.stopFlag) { cls = 'warn'; title = '已停止'; stage = '已中止，剩余文件未处理'; }
  else if (status.failed) {
    cls = diagnose ? 'warn' : 'bad';
    title = diagnose ? `诊断完成：${status.failed} 个文件有问题` : `修复结束：${status.failed} 个失败`;
  } else if (status.done < status.total) {
    cls = 'bad'; title = '执行中断'; stage = `仅处理 ${status.done} / ${status.total}，请查看提示`;
  }
  p.classList.add(cls);
  $('statusTitle').textContent = title;
  $('curStage').textContent = stage;
  $('curMetrics').textContent = '';
  $('fileBar').classList.remove('indeterminate');
  const pct = status.total ? (status.done / status.total) * 100 : 100;
  $('fileBar').style.width = `${pct}%`;
  $('bar').style.width = `${pct}%`;
  $('overallText').textContent = `${status.done} / ${status.total}`;
  renderStatusCounts();
}

function setFileProgress({ name, index, stage, percent, speed, fps, outTime, size }) {
  if (name != null) $('curFile').textContent = name;
  if (index != null && status.total) $('curIndex').textContent = `${index + 1} / ${status.total}`;
  if (stage) $('curStage').textContent = stage;
  const bar = $('fileBar');
  if (percent == null) bar.classList.add('indeterminate');
  else { bar.classList.remove('indeterminate'); bar.style.width = `${Math.max(0, Math.min(100, percent))}%`; }
  const bits = [];
  if (percent != null) bits.push(`${percent.toFixed(0)}%`);
  if (outTime) bits.push(fmtDur(outTime));
  if (speed && speed !== 'N/A') bits.push(speed);
  if (fps) bits.push(`${fps.toFixed(0)} fps`);
  if (size) bits.push(fmtSize(size));
  $('curMetrics').textContent = bits.join(' · ');
}

function setOverall(done, total) {
  status.done = done;
  $('bar').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('overallText').textContent = `${done} / ${total}`;
}

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = 'message', data = '';
      for (const l of block.split('\n')) {
        if (l.startsWith('event: ')) ev = l.slice(7);
        else if (l.startsWith('data: ')) data += l.slice(6);
      }
      if (data) onEvent(ev, JSON.parse(data));
    }
  }
}

function addItem(it) {
  if (state.items.some((x) => x.key === it.key)) return false;
  state.items.push({ ...it, status: 'pending', logs: [], diagnosis: null, strategy: '', reasons: [], selected: true });
  invalidateRepairList();
  return true;
}

function render() {
  const list = $('list');
  list.innerHTML = '';
  $('empty').hidden = state.items.length > 0;
  for (const it of state.items) {
    const row = document.createElement('div');
    row.className = `row${it.open ? ' open' : ''}`;
    row.dataset.key = it.key;

    const main = document.createElement('div');
    main.className = 'row-main';
    const label = it.status === 'running'
      ? (it.percent != null ? `处理中 ${it.percent.toFixed(0)}%` : '处理中')
      : ({ pending: '待处理', healthy: '健康', damaged: '有损伤', broken: '严重损坏', repaired: '已修复', skipped: '已跳过', failed: '修复失败', error: '出错', unreadable: '不可读', deleted: '已删除' }[it.status] || it.status);
    const detail = it.status === 'running'
      ? `<span style="color:var(--accent)">${esc(it.stage || '处理中…')}</span>`
      : it.status === 'repaired'
      ? `<span class="strat">${esc(it.strategy)}</span>`
      : it.reasons?.length
        ? `<span class="why">${esc(it.reasons.join('；').slice(0, 160))}</span>`
        : it.diagnosis?.problems?.length
          ? `<span class="prob">${esc(it.diagnosis.problems.map((p) => p.desc).join('；').slice(0, 180))}</span>`
          : it.diagnosis?.info
            ? `<span>${esc(metaLine(it.diagnosis.info))}</span>`
            : '<span style="color:var(--dim2)">—</span>';
    main.innerHTML = `<span class="c-name"><span class="fname" title="${esc(it.path || it.name)}">${esc(it.name)}</span>`
      + `<span class="frel">${esc(it.rel || (it.mode === 'handle' ? '拖拽句柄' : ''))}</span></span>`
      + `<span class="c-size">${fmtSize(it.size)}</span>`
      + `<span class="c-status"><span class="badge ${it.status}">${label}</span></span>`
      + `<span class="c-detail">${detail}</span>`;
    main.onclick = () => { it.open = !it.open; render(); };
    row.appendChild(main);

    const logBox = document.createElement('div');
    logBox.className = 'row-log';
    const pre = document.createElement('pre');
    pre.textContent = buildLogText(it);
    logBox.appendChild(pre);
    row.appendChild(logBox);
    list.appendChild(row);
  }
  const has = state.items.length > 0;
  $('btnDiagnose').disabled = !has || state.running;
  $('btnClear').disabled = !has || state.running;
  renderSteps();
  if (state.phase === 'confirm') updateRepairSelection();
  updateCounts();
}

// Progress events fire many times per second; patch the one row instead of
// rebuilding the whole list (which would reset scroll and collapse open logs).
function updateRowProgress(it) {
  const row = document.querySelector(`#list .row[data-key="${CSS.escape(it.key)}"]`);
  if (!row) return;
  const badge = row.querySelector('.badge');
  if (badge) badge.textContent = it.percent != null ? `处理中 ${it.percent.toFixed(0)}%` : '处理中';
  const detail = row.querySelector('.c-detail');
  if (detail) detail.innerHTML = `<span style="color:var(--accent)">${esc(it.stage || '处理中…')}</span>`;
}

function metaLine(info) {
  if (!info) return '';
  const v = info.video;
  const parts = [info.format, fmtDur(info.duration)];
  if (v) parts.push(`${v.width}×${v.height}`, v.codec, v.hdr ? 'HDR' : `${v.bitDepth || 8}bit`);
  return parts.filter(Boolean).join(' · ');
}

function buildLogText(it) {
  const L = [];
  if (it.path) L.push(`路径: ${it.path}`);
  L.push(`模式: ${it.mode === 'handle' ? '浏览器句柄（流式上传/回传）' : '服务端真实路径（原地修复）'}`);
  if (it.diagnosis) {
    const d = it.diagnosis;
    L.push(`判定: ${d.verdict}    解码检查: ${d.decodeChecked}`);
    if (d.info) L.push(`信息: ${metaLine(d.info)}`);
    if (d.boxes) L.push(`MP4 box: ${d.boxes.map((b) => `${b.type}(${fmtSize(b.size)})`).join(' ')}`);
    for (const p of d.problems || []) {
      L.push(`问题 [${p.code}] ${p.desc}`);
      for (const s of p.samples || []) L.push(`    ${s}`);
    }
    if (d.probeError) L.push(`ffprobe: ${d.probeError}`);
  }
  if (it.tried?.length) L.push(`尝试策略: ${it.tried.join(' → ')}`);
  if (it.strategy) L.push(`成功策略: ${it.strategy}`);
  for (const r of it.reasons || []) L.push(`失败原因: ${r}`);
  if (it.logs.length) { L.push('', '--- 修复日志 ---', ...it.logs); }
  return L.join('\n') || '（暂无日志，点击行展开/收起）';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateCounts() {
  const c = { total: state.items.length, healthy: 0, repaired: 0, failed: 0, damaged: 0, deleted: 0 };
  for (const it of state.items) {
    if (it.status === 'healthy' || it.status === 'skipped') c.healthy++;
    else if (it.status === 'repaired') c.repaired++;
    else if (it.status === 'failed' || it.status === 'error' || it.status === 'unreadable') c.failed++;
    else if (it.status === 'damaged' || it.status === 'broken') c.damaged++;
    else if (it.status === 'deleted') c.deleted++;
  }
  $('counts').innerHTML = `<span>共 <b>${c.total}</b></span><span class="ok">健康/跳过 <b>${c.healthy}</b></span>`
    + `<span class="warn">待修 <b>${c.damaged}</b></span><span class="ok">已修复 <b>${c.repaired}</b></span>`
    + `<span class="bad">失败 <b>${c.failed}</b></span>`
    + (c.deleted ? `<span>已删除 <b>${c.deleted}</b></span>` : '');
}

// ---------- two-step flow: diagnose → confirm list → repair ----------
const REPAIR_VERDICTS = ['damaged', 'broken', 'unreadable'];
const VERDICT_LABEL = { damaged: '有损伤', broken: '严重损坏', unreadable: '不可读' };

function setPhase(phase) {
  state.phase = phase;
  render();
}

function renderSteps() {
  const cur = { idle: 1, diagnosing: 1, confirm: 2, repairing: 3, repaired: 3 }[state.phase] || 1;
  for (const li of $('steps').children) {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', n === cur);
    li.classList.toggle('done', n < cur);
    li.querySelector('.step-n').textContent = n < cur ? '✓' : String(n);
  }
}

function repairCandidates() {
  return state.items.filter((it) => it.status !== 'deleted' && it.diagnosis && REPAIR_VERDICTS.includes(it.diagnosis.verdict));
}

// New files make any previously confirmed list stale.
function invalidateRepairList() {
  if (state.phase === 'confirm' || state.phase === 'repaired') state.phase = 'idle';
  $('repairPanel').hidden = true;
  $('failedPanel').hidden = true;
}

function buildRepairList() {
  const list = repairCandidates();
  for (const it of list) it.selected = true;
  const panel = $('repairPanel');
  const clean = list.length === 0;
  panel.hidden = false;
  panel.classList.toggle('clean', clean);
  $('rlClean').hidden = !clean;
  $('rlBody').hidden = clean;
  $('rlFoot').hidden = clean;
  $('rlTools').hidden = clean;
  $('rlSub').textContent = clean
    ? `已检查 ${state.items.length} 个文件，未发现需要修复的问题`
    : `${state.items.length} 个文件中 ${list.length} 个需要修复 · ${state.items.length - list.length} 个健康`;
  renderRepairList();
  state.phase = 'confirm';
  render();
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderRepairList() {
  const body = $('rlBody');
  body.innerHTML = '';
  for (const it of repairCandidates()) {
    const row = document.createElement('label');
    row.className = `rl-row${it.selected ? '' : ' off'}`;
    const probs = (it.diagnosis.problems || []).map((p) => p.desc).join('；');
    row.innerHTML = `<input type="checkbox"${it.selected ? ' checked' : ''}>`
      + `<span class="rl-name"><span class="fname" title="${esc(it.path || it.name)}">${esc(it.name)}</span>`
      + `<span class="frel">${esc(it.rel || (it.mode === 'handle' ? '拖拽句柄' : ''))}</span></span>`
      + `<span class="rl-size">${fmtSize(it.size)}</span>`
      + `<span class="rl-meta"><span class="badge ${it.diagnosis.verdict}">${VERDICT_LABEL[it.diagnosis.verdict] || it.diagnosis.verdict}</span>`
      + `<span class="rl-prob" title="${esc(probs)}">${esc(probs || '—')}</span></span>`;
    row.querySelector('input').onchange = (e) => {
      it.selected = e.target.checked;
      row.classList.toggle('off', !it.selected);
      updateRepairSelection();
    };
    body.appendChild(row);
  }
  updateRepairSelection();
}

function selectedForRepair() {
  return repairCandidates().filter((it) => it.selected);
}

function updateRepairSelection() {
  const list = repairCandidates();
  const sel = list.filter((it) => it.selected);
  const bytes = sel.reduce((n, it) => n + (it.size || 0), 0);
  $('rlTitle').textContent = list.length ? `待修复清单 · 已选 ${sel.length} / ${list.length}` : '诊断结果';
  $('rlConfirm').textContent = sel.length ? `确认修复 ${sel.length} 个（${fmtSize(bytes)}）` : '确认修复';
  $('rlConfirm').disabled = !sel.length || state.running;
}

// ---------- failed-source cleanup ----------
function failedItems() {
  return state.items.filter((it) => it.status === 'failed');
}

function renderFailedPanel() {
  const list = failedItems();
  const panel = $('failedPanel');
  if (!list.length || state.running) { panel.hidden = true; return; }
  panel.hidden = false;
  const handleN = list.filter((i) => i.mode === 'handle').length;
  $('fpTitle').textContent = `${list.length} 个文件修复失败`;
  $('fpSub').textContent = '原文件均保持不动，可手动处理或一键删除';
  const body = $('fpList');
  body.innerHTML = '';
  for (const it of list) {
    const row = document.createElement('div');
    row.className = 'fp-row';
    const why = (it.reasons || []).join('；') || '修复失败';
    row.innerHTML = `<span class="fp-name"><span class="fname" title="${esc(it.path || it.name)}">${esc(it.name)}</span>`
      + `<span class="frel">${esc(it.rel || (it.mode === 'handle' ? '拖拽句柄' : ''))}</span></span>`
      + `<span class="fp-size">${fmtSize(it.size)}</span>`
      + `<span class="fp-why" title="${esc(why)}">${esc(why)}</span>`;
    body.appendChild(row);
  }
  $('fpNote').innerHTML = handleN
    ? `路径模式 ${list.length - handleN} 个移入<strong>废纸篓</strong>（可还原）；拖拽模式 ${handleN} 个因浏览器限制<strong>永久删除</strong>。`
    : '全部移入<strong>废纸篓</strong>，可随时还原。';
  $('fpDelete').textContent = handleN === list.length
    ? `永久删除 ${list.length} 个失败源文件`
    : `删除 ${list.length} 个失败源文件（移入废纸篓）`;
}

async function deleteFailed(list, { ask = true } = {}) {
  const empty = { trashed: 0, removed: 0, errors: [] };
  if (!list.length || state.running) return empty;
  const pathItems = list.filter((i) => i.mode === 'path');
  const handleItems = list.filter((i) => i.mode === 'handle');
  if (ask) {
    const bytes = list.reduce((n, it) => n + (it.size || 0), 0);
    const lines = list.map((it) => `· ${it.name}（${fmtSize(it.size)}）→ ${it.mode === 'handle' ? '永久删除' : '废纸篓'}`).join('\n');
    const warn = handleItems.length
      ? `\n\n注意：${handleItems.length} 个拖拽模式文件受浏览器限制将被【永久删除】，无法还原。`
      : '\n\n全部移入废纸篓，可随时还原。';
    if (!confirm(`即将删除 ${list.length} 个修复失败的源文件（${fmtSize(bytes)}）：\n\n${lines}${warn}\n\n只删除失败文件，健康 / 已修复的文件不受影响。确定继续？`)) return empty;
  }
  if (handleItems.length && !await ensureWritePermission(handleItems)) return empty;
  const btn = $('fpDelete');
  btn.disabled = true;
  const errors = [];
  let trashedN = 0, removedN = 0;
  if (pathItems.length) {
    try {
      const r = await fetch('/api/trash-failed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: pathItems.map((i) => i.path) }),
      });
      const data = await r.json();
      const trashed = new Set(data.trashed || []);
      for (const it of pathItems) {
        if (trashed.has(it.path)) { it.status = 'deleted'; trashedN++; }
        else errors.push(it.name);
      }
    } catch {
      for (const it of pathItems) errors.push(it.name);
    }
  }
  for (const it of handleItems) {
    try {
      await it.handle.remove();
      it.status = 'deleted'; removedN++;
    } catch {
      errors.push(it.name);
    }
  }
  btn.disabled = false;
  renderFailedPanel();
  render();
  const parts = [];
  if (trashedN) parts.push(`${trashedN} 个已移入废纸篓`);
  if (removedN) parts.push(`${removedN} 个已永久删除`);
  if (errors.length) parts.push(`${errors.length} 个删除失败：${errors.slice(0, 3).join('、')}${errors.length > 3 ? ' 等' : ''}`);
  toast(parts.join('；') || '没有可删除的文件', errors.length ? 'bad' : 'ok');
  return { trashed: trashedN, removed: removedN, errors };
}

// ---------- intake ----------
async function walkHandle(dirHandle, prefix, out) {
  for await (const entry of dirHandle.values()) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') await walkHandle(entry, rel, out);
    else if (VIDEO_RE.test(entry.name)) {
      const f = await entry.getFile();
      out.push({ key: `h:${rel}`, name: entry.name, rel, size: f.size, mode: 'handle', handle: entry });
    }
  }
}

async function intakeDataTransfer(dt) {
  const items = [...dt.items];
  const handles = [];
  if (HAS_HANDLE_API) {
    for (const it of items) {
      if (it.kind !== 'file') continue;
      try { const h = await it.getAsFileSystemHandle(); if (h) handles.push(h); } catch { /* ignore */ }
    }
  }
  if (handles.length) {
    const out = [];
    let rootDir = null;
    for (const h of handles) {
      if (h.kind === 'directory') { rootDir = h; await walkHandle(h, h.name, out); }
      else if (VIDEO_RE.test(h.name)) {
        const f = await h.getFile();
        out.push({ key: `h:${h.name}`, name: h.name, rel: '', size: f.size, mode: 'handle', handle: h });
      }
    }
    if (rootDir) state.rootHandle = rootDir;
    let added = 0;
    for (const o of out) if (addItem(o)) added++;
    toast(added ? `已载入 ${added} 个视频（拖拽句柄模式）` : '没有新增视频文件', added ? 'ok' : '');
    render();
    return;
  }

  // No handle API: read-only entries. Diagnosis is possible but write-back is not.
  const files = [...dt.files].filter((f) => VIDEO_RE.test(f.name));
  if (files.length) {
    toast('此浏览器无法写回原文件，请用「选择文件夹（原生）」或粘贴路径', 'bad');
    $('modeNote').hidden = false;
  } else {
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.some((e) => e.isDirectory)) toast('此浏览器无法写回原文件，请用「选择文件夹（原生）」或粘贴路径', 'bad');
    else toast('没有识别到视频文件', 'bad');
  }
}

async function loadPaths(paths) {
  const results = [];
  let added = 0;
  for (const p of paths) {
    try {
      const r = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
      const d = await r.json();
      if (!r.ok) { results.push({ path: p, ok: false, error: d.error || `HTTP ${r.status}` }); continue; }
      let n = 0;
      for (const f of d.files) if (addItem({ key: `p:${f.path}`, name: f.name, rel: f.rel, size: f.size, mode: 'path', path: f.path })) { added++; n++; }
      results.push({ path: p, ok: true, kind: d.kind || 'dir', count: d.files.length, added: n });
    } catch (e) { results.push({ path: p, ok: false, error: String(e) }); }
  }
  state.rootHandle = null;
  render();
  return { added, results };
}

async function loadPath(p) {
  if (!p) return;
  const { added, results } = await loadPaths([p]);
  if (added) toast(`已载入 ${added} 个视频（路径模式 · 免上传 · 可原地覆盖）`, 'ok');
  else toast(results[0]?.ok ? '没有新增视频文件' : (results[0]?.error || '没有新增视频文件'), results[0]?.ok ? '' : 'bad');
}

// ---------- multi-path paste (no upload) ----------
function parsePaths(text) {
  const out = [], seen = new Set();
  const push = (raw) => {
    let p = String(raw).trim().replace(/;+$/, '');
    if (!p || p.startsWith('#')) return;
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1).trim();
    if (p.startsWith('file://')) {
      try { p = decodeURIComponent(new URL(p).pathname); } catch { p = p.replace(/^file:\/\/(localhost)?/, ''); }
    }
    if (!p || seen.has(p)) return;
    seen.add(p); out.push(p);
  };
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 1) { for (const l of lines) push(l); return out; }
  // Single line: split on whitespace / ';' outside quotes so quoted paths with spaces survive.
  let cur = '', quote = null;
  for (const ch of lines[0] || '') {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (/\s/.test(ch) || ch === ';') { push(cur); cur = ''; continue; }
    cur += ch;
  }
  push(cur);
  return out;
}

function autoresizePaste() {
  const ta = $('pathInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(Math.max(ta.scrollHeight, 46), 176) + 'px';
}

function updatePasteMeta() {
  const n = parsePaths($('pathInput').value).length;
  const c = $('pasteCount');
  c.textContent = n ? `${n} 个路径` : '';
  c.classList.toggle('on', n > 0);
  const go = $('pathGo');
  go.disabled = !n || state.running;
  go.textContent = n > 1 ? `载入 ${n} 个路径` : '载入';
  autoresizePaste();
}

function renderPathReport(results, added) {
  const box = $('pathReport');
  if (!results.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'pr-head';
  head.innerHTML = `<span>路径报告</span><span class="pr-sum">${added} 个新视频 · ${results.filter((r) => r.ok).length}/${results.length} 个路径有效</span>`;
  box.appendChild(head);
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'pr-row ' + (r.ok ? (r.added ? 'ok' : 'dup') : 'bad');
    const icon = r.ok ? (r.added ? '✓' : '·') : '✕';
    const detail = r.ok
      ? (r.added
        ? `${r.kind === 'dir' ? '文件夹' : '文件'} · 新增 ${r.added} 个视频${r.count > r.added ? `（${r.count - r.added} 个已存在）` : ''}`
        : (r.count ? '全部已存在，跳过' : '没有视频文件'))
      : r.error;
    row.innerHTML = `<span class="pr-icon">${icon}</span><span class="pr-path" title="${esc(r.path)}">${esc(r.path)}</span><span class="pr-detail" title="${esc(detail)}">${esc(detail)}</span>`;
    box.appendChild(row);
  }
}

async function loadMany() {
  if (state.running) { toast('任务进行中，请等待完成后再载入', 'bad'); return; }
  const paths = parsePaths($('pathInput').value);
  if (!paths.length) { toast('请先粘贴至少一个路径', ''); return; }
  const go = $('pathGo');
  const label = go.textContent;
  go.disabled = true; go.textContent = '载入中…';
  $('pasteBox').classList.add('loading');
  const { added, results } = await loadPaths(paths);
  $('pasteBox').classList.remove('loading');
  go.textContent = label;
  renderPathReport(results, added);
  updatePasteMeta();
  if (added) toast(`已载入 ${added} 个视频（路径模式 · 免上传 · 可原地覆盖）`, 'ok');
  else toast('没有新增视频文件，详见路径报告', 'bad');
}

// ---------- run ----------
function setRunning(on) {
  state.running = on;
  $('btnStop').hidden = !on;
  $('deep').disabled = on; $('allowReencode').disabled = on;
  updatePasteMeta();
  render();
}

async function ensureWritePermission(items) {
  const targets = state.rootHandle ? [state.rootHandle] : items.filter((i) => i.mode === 'handle').map((i) => i.handle);
  for (const h of targets) {
    if (!h?.queryPermission) continue;
    const opts = { mode: 'readwrite' };
    if (await h.queryPermission(opts) === 'granted') continue;
    if (await h.requestPermission(opts) !== 'granted') {
      toast('没有写入授权，无法覆盖原文件', 'bad');
      return false;
    }
    if (state.rootHandle) break;
  }
  return true;
}

async function runPathMode(mode, items) {
  const files = items.map((i) => i.path);
  if (!files.length) return 0;
  const ctrl = new AbortController();
  state.abort = ctrl;
  const byPath = new Map(items.map((i) => [i.path, i]));
  const res = await fetch('/api/jobs', {
    method: 'POST', signal: ctrl.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, files, deep: $('deep').value === '1', allowReencode: $('allowReencode').checked, reference: $('refPath').value || null }),
  });
  if (!res.ok) throw new Error(`服务端错误 ${res.status}`);
  await readSSE(res, (ev, d) => handleEvent(ev, d, byPath));
  return files.length;
}

function handleEvent(ev, d, byPath) {
  const it = byPath.get(d.path);
  if (ev === 'file-start' && it) {
    it.status = 'running'; it.percent = null; it.stage = '准备中…';
    setFileProgress({ name: it.name, index: d.index, stage: '准备中…', percent: null });
    render();
  } else if (ev === 'file-progress') {
    setFileProgress({ name: it?.name, index: d.index, stage: d.stage, percent: d.percent, speed: d.speed, fps: d.fps, outTime: d.outTime, size: d.size });
    if (it) { it.percent = d.percent; it.stage = d.stage; updateRowProgress(it); }
  } else if (ev === 'log' && it) {
    it.logs.push(d.message);
    if (it.open) render();
  } else if (ev === 'diagnosis' && it) {
    it.diagnosis = d.diagnosis; render();
  } else if (ev === 'file-done' && it) {
    it.status = d.action === 'repaired' ? 'repaired' : d.action === 'skipped' ? 'skipped'
      : d.action === 'failed' ? 'failed' : d.verdict;
    it.strategy = d.strategy || ''; it.reasons = d.reasons || []; it.tried = d.tried || [];
    it.percent = null; it.stage = '';
    if (d.action === 'repaired') status.repaired++;
    else if (d.action === 'skipped') status.skipped++;
    else if (d.action === 'failed') status.failed++;
    else if (d.action === 'diagnosed') { if (d.verdict === 'healthy') status.skipped++; else status.failed++; }
    renderStatusCounts(); render();
  } else if (ev === 'progress') {
    setOverall(d.done, status.total);
  } else if (ev === 'done') {
    setOverall(d.total, status.total);
    if (state.mode === 'diagnose') {
      const bad = d.total - d.skipped;
      toast(`诊断完成：健康 ${d.skipped} · 有问题 ${bad}`, bad ? '' : 'ok');
    } else {
      toast(`完成：修复 ${d.repaired} · 跳过 ${d.skipped} · 失败 ${d.failed}`, d.failed ? 'bad' : 'ok');
    }
  }
}

function uploadWithProgress(file, name, onPct) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/stage?name=${encodeURIComponent(name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct((e.loaded / e.total) * 100, e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); }
      } else reject(new Error(`上传失败 ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('上传网络错误'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(file);
  });
}

async function runHandleMode(mode, items, offset = 0) {
  for (let n = 0; n < items.length; n++) {
    if (state.stopFlag) break;
    const it = items[n];
    const idx = offset + n;
    it.status = 'running'; it.logs = []; it.percent = null; it.stage = '读取文件…';
    setFileProgress({ name: it.name, index: idx, stage: '读取文件…', percent: null });
    setOverall(idx, status.total);
    render();
    let stageId = null, resultId = null;
    try {
      const file = await it.handle.getFile();
      it.size = file.size;
      it.logs.push(`上传到本地服务（${fmtSize(file.size)}）…`);
      setFileProgress({ name: it.name, index: idx, stage: '上传到本地服务', percent: 0 });
      const up = await uploadWithProgress(file, it.name, (pct, loaded) => {
        it.percent = pct; it.stage = '上传到本地服务';
        setFileProgress({ name: it.name, index: idx, stage: '上传到本地服务', percent: pct, size: loaded });
        updateRowProgress(it);
      });
      stageId = up.id;

      const rr = await fetch('/api/repair-staged', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: stageId, mode, stream: true, deep: $('deep').value === '1', allowReencode: $('allowReencode').checked }),
      });
      if (!rr.ok) throw new Error(`服务端错误 ${rr.status}`);
      let d = null;
      await readSSE(rr, (ev, p) => {
        if (ev === 'file-progress') {
          it.percent = p.percent; it.stage = p.stage;
          setFileProgress({ name: it.name, index: idx, stage: p.stage, percent: p.percent, speed: p.speed, fps: p.fps, outTime: p.outTime, size: p.size });
          updateRowProgress(it);
        } else if (ev === 'log') { it.logs.push(p.message); if (it.open) render(); }
        else if (ev === 'diagnosis') { it.diagnosis = p.diagnosis; render(); }
        else if (ev === 'result') d = p;
      });
      if (!d) throw new Error('服务端未返回结果');
      it.tried = d.tried || [];

      if (state.stopFlag) {
        it.status = 'pending'; it.logs.push('已停止，原文件未改动');
      } else if (mode === 'diagnose') {
        it.status = d.diagnosis.verdict;
        if (it.status === 'healthy') status.skipped++; else status.failed++;
      } else if (d.action === 'skipped') {
        it.status = 'skipped'; status.skipped++; it.logs.push('文件健康，跳过');
      } else if (d.action === 'repaired') {
        resultId = d.resultId;
        it.logs.push(`下载修复产物并写回原文件（策略：${d.strategy}）…`);
        const dl = await fetch(`/api/fetch/${resultId}`);
        if (!dl.ok) throw new Error('下载修复产物失败');
        const totalBytes = Number(dl.headers.get('Content-Length')) || 0;
        const writable = await it.handle.createWritable();
        const reader = dl.body.getReader();
        let received = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          await writable.write(value);
          received += value.length;
          const pct = totalBytes ? (received / totalBytes) * 100 : null;
          it.percent = pct; it.stage = '写回原文件';
          setFileProgress({ name: it.name, index: idx, stage: '写回原文件', percent: pct, size: received });
          updateRowProgress(it);
        }
        await writable.close();
        it.status = 'repaired'; it.strategy = d.strategy; status.repaired++;
        it.logs.push('已覆盖原文件');
      } else {
        it.status = 'failed'; it.reasons = d.reasons || ['修复失败']; status.failed++;
        it.logs.push('原文件未改动');
      }
    } catch (e) {
      it.status = 'failed'; it.reasons = [String(e)]; status.failed++;
      it.logs.push(`出错：${e}`);
    } finally {
      for (const id of [stageId, resultId]) {
        if (id) fetch(`/api/staged/${id}`, { method: 'DELETE' }).catch(() => {});
      }
      it.percent = null; it.stage = '';
      renderStatusCounts();
      setOverall(idx + 1, status.total);
      render();
    }
  }
}

async function start(mode, targets) {
  targets = targets || state.items.filter((i) => i.status !== 'deleted');
  if (state.running || !targets.length) return;
  state.stopFlag = false;
  state.mode = mode;
  state.phase = mode === 'repair' ? 'repairing' : 'diagnosing';
  startStatus(mode, targets.length);
  setRunning(true);
  try {
    const pathItems = targets.filter((i) => i.mode === 'path');
    const handleItems = targets.filter((i) => i.mode === 'handle');
    let offset = 0;
    if (pathItems.length) offset = await runPathMode(mode, pathItems);
    if (handleItems.length && !state.stopFlag) await runHandleMode(mode, handleItems, offset);
  } catch (e) {
    if (e.name !== 'AbortError') toast(`执行出错：${e}`, 'bad');
  } finally {
    state.abort = null;
    // An aborted run leaves the in-flight row marked 处理中; nothing is running anymore.
    for (const it of state.items) {
      if (it.status === 'running') { it.status = 'pending'; it.percent = null; it.stage = ''; }
    }
    setRunning(false);
    endStatus();
    const complete = !state.stopFlag && status.done >= status.total;
    if (mode === 'diagnose' && complete) buildRepairList();
    else {
      $('repairPanel').hidden = true;
      state.phase = mode === 'repair' && complete ? 'repaired' : 'idle';
      render();
    }
    if (mode === 'repair' && $('rlAutoDelete').checked) {
      const failedRun = targets.filter((i) => i.status === 'failed');
      if (failedRun.length) await deleteFailed(failedRun, { ask: false });
    }
    renderFailedPanel();
  }
}

// ---------- wiring ----------
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('over'); }));
drop.addEventListener('drop', async (e) => { e.preventDefault(); await intakeDataTransfer(e.dataTransfer); });
drop.addEventListener('click', (e) => { if (e.target === drop || (e.target.closest('.drop-inner') && !e.target.closest('button,input,textarea,.paste-box'))) pickFiles(); });
drop.addEventListener('keydown', (e) => { if (e.target.closest('input,textarea,button,select')) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(); } });

async function pickFiles() {
  if (HAS_HANDLE_API && window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true, excludeAcceptAllOption: false });
      let added = 0;
      for (const h of handles) {
        if (!VIDEO_RE.test(h.name)) continue;
        const f = await h.getFile();
        if (addItem({ key: `h:${h.name}`, name: h.name, rel: '', size: f.size, mode: 'handle', handle: h })) added++;
      }
      toast(added ? `已载入 ${added} 个视频（可原地覆盖）` : '没有新增视频文件', added ? 'ok' : '');
      render();
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const d = await fetch('/api/pick-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ multiple: true }) }).then((r) => r.json()).catch(() => null);
  if (d?.ok) {
    if (!d.paths.length) toast('所选文件中没有视频', 'bad');
    else { const { added } = await loadPaths(d.paths); toast(added ? `已载入 ${added} 个视频（路径模式 · 免上传）` : '没有新增视频文件', added ? 'ok' : ''); }
  }
  else if (d && !d.cancelled) toast(d.error || '选择失败', 'bad');
}

$('pickFiles').onclick = (e) => { e.stopPropagation(); pickFiles(); };
$('pickFolder').onclick = async (e) => {
  e.stopPropagation();
  if (HAS_HANDLE_API) {
    try {
      const h = await window.showDirectoryPicker({ mode: 'readwrite' });
      state.rootHandle = h;
      const out = [];
      await walkHandle(h, h.name, out);
      let added = 0;
      for (const o of out) if (addItem(o)) added++;
      toast(added ? `已载入 ${added} 个视频（可原地覆盖）` : '该文件夹没有视频', added ? 'ok' : '');
      render(); return;
    } catch (err) { if (err.name === 'AbortError') return; }
  }
  const r = await fetch('/api/pick-folder', { method: 'POST' });
  const d = await r.json();
  if (d.ok) await loadPath(d.path);
  else if (!d.cancelled) toast(d.error || '选择失败', 'bad');
};
$('pathGo').onclick = (e) => { e.stopPropagation(); loadMany(); };
$('pathInput').onclick = (e) => e.stopPropagation();
$('pathInput').oninput = () => updatePasteMeta();
$('pathInput').onkeydown = (e) => {
  e.stopPropagation();
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); loadMany(); }
};
$('pasteClear').onclick = (e) => {
  e.stopPropagation();
  $('pathInput').value = '';
  $('pathReport').hidden = true;
  updatePasteMeta();
};

$('pickRef').onclick = async (e) => {
  e.stopPropagation();
  const d = await fetch('/api/pick-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ multiple: false }) }).then((r) => r.json()).catch(() => null);
  if (d?.ok && d.paths[0]) { $('refPath').value = d.paths[0]; toast('参考文件已设置', 'ok'); }
  else if (d && !d.cancelled) toast(d.error || '选择失败', 'bad');
};
$('clearRef').onclick = (e) => { e.stopPropagation(); $('refPath').value = ''; };

$('btnDiagnose').onclick = () => start('diagnose');
$('rlAll').onclick = () => { for (const it of repairCandidates()) it.selected = true; renderRepairList(); };
$('rlNone').onclick = () => { for (const it of repairCandidates()) it.selected = false; renderRepairList(); };
$('rlCancel').onclick = () => {
  $('repairPanel').hidden = true;
  setPhase('idle');
  toast('已取消，原文件未改动。可重新诊断或调整勾选后再确认。', '');
};
$('rlConfirm').onclick = async () => {
  const sel = selectedForRepair();
  if (!sel.length || state.running) return;
  const bytes = sel.reduce((n, it) => n + (it.size || 0), 0);
  const ok = confirm(`即将修复并【直接覆盖】${sel.length} 个原文件（${fmtSize(bytes)}），不保留备份。\n\n`
    + '安全保证：修复产物先写临时文件，通过校验（可解析、时长不短于原片 90%、可解码）才替换原名；'
    + '任何一步失败，原文件保持不动。\n\n清单之外和未勾选的文件不会被改动。确定继续？');
  if (!ok) return;
  if (sel.some((i) => i.mode === 'handle') && !await ensureWritePermission(sel)) return;
  $('repairPanel').hidden = true;
  start('repair', sel);
};
$('fpDelete').onclick = () => deleteFailed(failedItems(), { ask: true });
$('btnClear').onclick = () => {
  state.items = []; state.rootHandle = null;
  clearInterval(status.timer); status.timer = null;
  $('statusPanel').hidden = true;
  $('repairPanel').hidden = true;
  $('failedPanel').hidden = true;
  setPhase('idle');
};
$('btnStop').onclick = () => { state.stopFlag = true; state.abort?.abort(); toast('正在停止…', ''); };

loadCaps();
updatePasteMeta();
render();