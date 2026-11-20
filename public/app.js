const $ = (id) => document.getElementById(id);
const state = { items: [], running: false, abort: null, stopFlag: false, caps: null, rootHandle: null, phase: 'idle', retryCount: 0 };
const VIDEO_RE = /\.(mp4|m4v|mov|mkv|avi|webm|flv|wmv|mpg|mpeg|ts|m2ts|mts|3gp|3g2|ogv|vob|divx|f4v|rm|rmvb|asf|mxf)$/i;

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

// Promise-based themed confirmation dialog, replacing blocking window.confirm.
// Resolves true on confirm, false on cancel / Esc / backdrop click.
// opts: { title, subtitle, tone:'info'|'danger'|'warn', icon:'merge'|'repair'|'trash'|'arrow',
//         stats:[{label,value,small?}], rows:[{label,value}], lines:[html], warn:html,
//         confirmText, cancelText, dangerConfirm }
const DLG_ICONS = {
  merge: '<path d="M4 7h5l2 3h9v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"/><path d="M4 7V6a2 2 0 0 1 2-2h4l2 3"/>',
  repair: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l8.3-8.3a4 4 0 0 0 5.4-5.4l-3 3-3-3 3-3Z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  arrow: '<path d="M4 12h15M13 6l6 6-6 6"/>',
};
function askConfirm(opts = {}) {
  const {
    title = '请确认', subtitle = '', tone = 'info', icon = 'merge',
    stats = [], rows = [], lines = [], warn = '',
    confirmText = '确定', cancelText = '取消', dangerConfirm = false,
  } = opts;
  return new Promise((resolve) => {
    const root = $('confirmRoot');
    const stroke = tone === 'danger' ? '#ffb4ae' : tone === 'warn' ? '#e8c97a' : '#9dc0f5';
    const statsHtml = stats.length
      ? `<div class="dlg-stats${stats.length === 2 ? ' two' : ''}">${stats.map((s) =>
          `<div class="dlg-stat"><div class="dlg-stat-l">${esc(s.label)}</div>`
          + `<div class="dlg-stat-v${s.small ? ' sm' : ''}">${esc(s.value)}</div></div>`).join('')}</div>`
      : '';
    const rowsHtml = rows.map((r) =>
      `<div class="dlg-row"><div class="dlg-row-l">${esc(r.label)}</div><div class="dlg-row-v">${esc(r.value)}</div></div>`).join('');
    const linesHtml = lines.length ? `<div class="dlg-lines">${lines.join('<br>')}</div>` : '';
    const warnHtml = warn
      ? `<div class="dlg-warn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v5m0 3h.01"/><path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg><div>${warn}</div></div>`
      : '';
    const okClass = dangerConfirm ? 'btn-danger' : 'btn-primary';
    root.innerHTML = `<div class="dlg-mask"><div class="dlg dlg-${tone}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="dlg-head">
        <div class="dlg-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${DLG_ICONS[icon] || DLG_ICONS.merge}</svg></div>
        <div class="dlg-heading"><div class="dlg-title">${esc(title)}</div>${subtitle ? `<div class="dlg-sub">${esc(subtitle)}</div>` : ''}</div>
      </div>
      ${(statsHtml || rowsHtml || linesHtml || warnHtml) ? `<div class="dlg-body">${statsHtml}${rowsHtml}${linesHtml}${warnHtml}</div>` : ''}
      <div class="dlg-foot">
        <button type="button" class="btn" data-dlg="cancel">${esc(cancelText)}</button>
        <button type="button" class="btn ${okClass}" data-dlg="ok">${esc(confirmText)}</button>
      </div>
    </div></div>`;
    root.hidden = false;
    const okBtn = root.querySelector('[data-dlg="ok"]');
    const cancelBtn = root.querySelector('[data-dlg="cancel"]');
    (dangerConfirm ? cancelBtn : okBtn).focus();
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      root.hidden = true;
      root.innerHTML = '';
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') {
        // Let a focused button handle its own activation; otherwise confirm.
        if (document.activeElement === cancelBtn) { e.preventDefault(); finish(false); }
        else { e.preventDefault(); finish(true); }
      } else if (e.key === 'Tab') {
        const btns = [cancelBtn, okBtn];
        const i = btns.indexOf(document.activeElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('.dlg-mask').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) finish(false); });
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
  });
}

async function loadCaps() {
  try {
    const r = await fetch('/api/capabilities');
    const c = await r.json();
    state.caps = c;
    const ready = !!(c.ffmpeg && c.untrunc);
    $('caps').innerHTML = `<div class="env" id="envBox">
      <button type="button" class="env-btn" id="envBtn" aria-expanded="false" title="查看运行环境">
        <span class="env-dot ${ready ? 'ok' : 'warn'}"></span>
        <span>运行环境${ready ? '就绪' : '待检查'}</span>
        <span class="env-caret">⌄</span>
      </button>
      <div class="env-panel" id="envPanel" hidden>
        <div class="env-row"><span>解码器</span><b title="${esc(c.ffmpeg || '')}">${esc((c.ffmpeg || '').split(' Copyright')[0] || '—')}</b></div>
        <div class="env-row"><span>结构修复</span><b class="${c.untrunc ? 'ok' : 'warn'}">${c.untrunc ? 'untrunc 已就绪' : 'untrunc 未安装'}</b></div>
        <div class="env-row"><span>文件传输</span><b>本地路径 · 不上传字节</b></div>
        ${c.logFile ? `<div class="env-row"><span>运行日志</span><b title="${esc(c.logFile)}">JSONL</b></div>` : ''}
        <div class="env-note">所有导入方式统一走本地路径，服务端原地修复，不上传任何文件字节。</div>
      </div>
    </div>`;
    $('envBtn').onclick = (e) => {
      e.stopPropagation();
      const p = $('envPanel');
      p.hidden = !p.hidden;
      $('envBtn').setAttribute('aria-expanded', String(!p.hidden));
      $('envBtn').classList.toggle('open', !p.hidden);
    };
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
  // Authoritative progress is the set of paths that produced a file-done event.
  // Unlike the server's progress counter this stays correct across reconnects,
  // where a stream can drop between file-done and progress.
  state.completedPaths = new Set();
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
  let gotDone = false;
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
      // ': ping' heartbeat has no data field and is intentionally ignored.
      if (data) { if (ev === 'done') gotDone = true; onEvent(ev, JSON.parse(data)); }
    }
  }
  return gotDone;
}

function addItem(it, { quiet = false } = {}) {
  if (state.items.some((x) => x.key === it.key)) return false;
  state.items.push({ ...it, status: 'pending', logs: [], diagnosis: null, strategy: '', reasons: [], selected: true, attempts: [] });
  invalidateRepairList();
  if (!quiet) render();
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
      ? `<span class="strat">${esc(it.strategy)}</span>${it.level === 'degraded' ? '<span class="badge degraded">降级可用</span>' : ''}`
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
  if (it.attempts?.length) {
    L.push('--- 策略明细 ---');
    for (const a of it.attempts) {
      const tag = a.ok ? (a.level === 'degraded' ? '降级' : '通过') : '未通过';
      const secs = a.ms != null ? ` ${(a.ms / 1000).toFixed(1)}s` : '';
      const why = (a.reasons || []).join('；').slice(0, 90);
      L.push(`  [${tag}] ${a.strategy}${secs}${why ? ' — ' + why : ''}`);
    }
  }
  if (it.strategy) L.push(`成功策略: ${it.strategy}`);
  if (it.level === 'degraded') L.push('注意: 降级修复产物可播放，但可能仍有残留解码错误，建议另存备份。');
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
  $('fpTitle').textContent = `${list.length} 个文件修复失败`;
  $('fpSub').textContent = '原文件均保持不动，可单独重试或一键删除';
  const body = $('fpList');
  body.innerHTML = '';
  for (const it of list) {
    const row = document.createElement('div');
    row.className = 'fp-row';
    const why = (it.reasons || []).join('；') || '修复失败';
    row.innerHTML = `<span class="fp-name"><span class="fname" title="${esc(it.path || it.name)}">${esc(it.name)}</span>`
      + `<span class="frel">${esc(it.rel || '')}</span></span>`
      + `<span class="fp-size">${fmtSize(it.size)}</span>`
      + `<span class="fp-why" title="${esc(why)}">${esc(why)}</span>`;
    body.appendChild(row);
  }
  $('fpNote').innerHTML = '全部移入<strong>废纸篓</strong>，可随时还原。';
  $('fpDelete').textContent = `删除 ${list.length} 个失败源文件（移入废纸篓）`;
}

// Retry only the failed files. They go through the same diagnose→confirm→repair
// flow; healthy/repaired files are never touched. Failed items are marked
// pending first so the normal start() pipeline picks them up.
let retryArmed = false;
let retryArmTimer = null;
function resetRetryButton() {
  retryArmed = false;
  clearTimeout(retryArmTimer);
  const b = $('fpRetry');
  if (b) { b.textContent = '重试失败项'; b.classList.remove('armed'); }
}
function retryFailed() {
  const list = failedItems();
  if (!list.length || state.running) return;
  const btn = $('fpRetry');
  if (!retryArmed) {
    // First click arms a lightweight two-step confirmation — no modal needed
    // for this harmless action, but it still avoids accidental clicks.
    retryArmed = true;
    btn.textContent = `再点一次，重试 ${list.length} 项`;
    btn.classList.add('armed');
    btn.title = '仅重新诊断并修复失败文件，健康/已修复文件不改动';
    clearTimeout(retryArmTimer);
    retryArmTimer = setTimeout(resetRetryButton, 4000);
    return;
  }
  resetRetryButton();
  for (const it of list) {
    it.status = 'pending'; it.diagnosis = null; it.reasons = [];
    it.attempts = []; it.logs = [];
  }
  $('failedPanel').hidden = true;
  start('repair', list);
}

async function deleteFailed(list, { ask = true } = {}) {
  const empty = { trashed: 0, removed: 0, errors: [] };
  if (!list.length || state.running) return empty;
  const pathItems = list.filter((i) => i.mode === 'path' || i.mode === 'handle');
  if (ask) {
    const bytes = list.reduce((n, it) => n + (it.size || 0), 0);
    const ok = await askConfirm({
      title: '删除失败源文件',
      subtitle: `将 ${list.length} 个修复失败的文件移入废纸篓`,
      icon: 'trash', tone: 'danger',
      stats: [
        { label: '文件数', value: String(list.length) },
        { label: '涉及大小', value: fmtSize(bytes) },
      ],
      lines: ['只删除失败文件，健康 / 已修复的文件不受影响。'],
      warn: '文件移入废纸篓，可随时还原；不会永久删除。',
      confirmText: '移入废纸篓', dangerConfirm: true,
    });
    if (!ok) return empty;
  }
  const btn = $('fpDelete');
  btn.disabled = true;
  const errors = [];
  let trashedN = 0;
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
  btn.disabled = false;
  renderFailedPanel();
  render();
  const parts = [];
  if (trashedN) parts.push(`${trashedN} 个已移入废纸篓`);
  if (errors.length) parts.push(`${errors.length} 个删除失败：${errors.slice(0, 3).join('、')}${errors.length > 3 ? ' 等' : ''}`);
  toast(parts.join('；') || '没有可删除的文件', errors.length ? 'bad' : 'ok');
  return { trashed: trashedN, removed: 0, errors };
}

// ---------- intake ----------
// Drag/drop never exposes a full local path in the browser (a hard security
// limit). Since the server runs on this same machine, all intake is unified on
// path mode: dropping files opens the native picker so we obtain real paths and
// repair in place — no file bytes are ever uploaded through the browser.
async function intakeDataTransfer(dt) {
  const items = [...dt.items];
  const files = [...dt.files].filter((f) => VIDEO_RE.test(f.name));
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const hasDir = entries.some((e) => e.isDirectory);
  if (!files.length && !hasDir && !entries.length) { toast('没有识别到视频文件', 'bad'); return; }

  toast('正在打开原生选择器以获取真实路径（拖入的内容需在弹窗中确认），随后直接原地修复…', '');
  if (hasDir) {
    const r = await fetch('/api/pick-folder', { method: 'POST' });
    const d = await r.json();
    if (d.ok) await loadPath(d.path);
    else if (!d.cancelled) toast(d.error || '选择失败', 'bad');
  } else {
    const d = await fetch('/api/pick-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ multiple: true }) }).then((r) => r.json()).catch(() => null);
    if (d?.ok) {
      if (!d.paths.length) toast('所选文件中没有视频', 'bad');
      else { const { added } = await loadPaths(d.paths); toast(added ? `已载入 ${added} 个视频（路径模式 · 原地覆盖）` : '没有新增视频文件', added ? 'ok' : ''); }
    } else if (d && !d.cancelled) toast(d.error || '选择失败', 'bad');
  }
}

// Scan many paths in a single request. The server normalises/dedupes and scans
// with bounded concurrency, so pasting hundreds of links no longer issues
// hundreds of serial requests that can stall or get stuck.
async function loadPaths(paths) {
  // During a repair run, targets are fixed when start() begins. Adding files
  // now would show them as pending while never executing them — misleading and
  // easy to mistake for a dropped file. Keep the list read-only until done.
  if (state.running) {
    toast('修复进行中，请等本轮结束后再添加文件', 'bad');
    return { added: 0, results: [] };
  }
  const results = new Array(paths.length);
  let added = 0;
  try {
    const r = await fetch('/api/scan-many', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // Per-input report, aligned to the original paste order. addItem dedupes
    // by key, so overlaps between paths (folder + a file inside it) are safe.
    for (let i = 0; i < paths.length; i++) {
      const r = d.results?.[i] || { ok: false, error: '无扫描结果' };
      let n = 0;
      if (r.ok) {
        for (const f of (r.files || [])) {
          if (addItem({ key: `p:${f.path}`, name: f.name, rel: f.rel, size: f.size, mode: 'path', path: f.path }, { quiet: true })) { added++; n++; }
        }
      }
      results[i] = { path: r.input ?? paths[i], ok: r.ok, kind: r.kind, count: r.count, added: n, error: r.error };
    }
    if (d.duplicates > 0) toast(`已跳过 ${d.duplicates} 个重复路径`, '');
  } catch (e) {
    for (let i = 0; i < paths.length; i++) results[i] = { input: paths[i], ok: false, error: String(e) };
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

async function runPathMode(mode, items) {
  if (!items.length) return 0;
  const byPath = new Map(items.map((i) => [i.path, i]));
  // Iterative resume: each round sends only the files not yet completed. If the
  // SSE stream drops before the server's 'done' event, we reconnect from the
  // last completed file instead of restarting hundreds of files from scratch.
  let pending = items.slice();
  const MAX_RECONNECT = 3;
  let reconnect = 0;
  while (pending.length && !state.stopFlag) {
    const files = pending.map((i) => i.path);
    const donePaths = new Set();
    const ctrl = new AbortController();
    state.abort = ctrl;
    let gotDone = false;
    let res;
    try {
      res = await fetch('/api/jobs', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode, files, deep: $('deep').value === '1',
          allowReencode: $('allowReencode').checked,
          reference: $('refPath').value || null,
          resumeFrom: state.completedPaths ? state.completedPaths.size : status.done,
        }),
      });
      if (!res.ok) throw new Error(`服务端错误 ${res.status}`);
      gotDone = await readSSE(res, (ev, d) => {
        if (ev === 'file-done' && d.path) donePaths.add(d.path);
        handleEvent(ev, d, byPath);
      });
    } catch (e) {
      if (e.name === 'AbortError') break;
      // A dropped connection shows up here; treat like an incomplete stream.
      gotDone = false;
    } finally {
      state.abort = null;
    }

    // Keep only files that never produced a file-done event.
    pending = pending.filter((i) => !donePaths.has(i.path));
    if (gotDone || state.stopFlag || !pending.length) break;
    reconnect++;
    if (reconnect > MAX_RECONNECT) {
      toast(`连接多次中断，仍有 ${pending.length} 个文件未完成。请检查后对失败项重试`, 'bad');
      for (const i of pending) { i.status = 'pending'; i.percent = null; i.stage = ''; }
      render();
      break;
    }
    const completedN = state.completedPaths ? state.completedPaths.size : status.done;
    toast(`连接中断，正在从第 ${completedN + 1} 个续跑剩余 ${pending.length} 个文件…`, '');
    await new Promise((r) => setTimeout(r, 600));
  }
  return items.length;
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
    it.level = d.level || null; it.attempts = d.attempts || [];
    it.percent = null; it.stage = '';
    if (d.action === 'repaired') status.repaired++;
    else if (d.action === 'skipped') status.skipped++;
    else if (d.action === 'failed') status.failed++;
    else if (d.action === 'diagnosed') { if (d.verdict === 'healthy') status.skipped++; else status.failed++; }
    // Count each path once even if a reconnect re-delivers a file-done.
    if (d.path && state.completedPaths) state.completedPaths.add(d.path);
    setOverall(state.completedPaths ? state.completedPaths.size : status.done + 1, status.total);
    renderStatusCounts(); render();
  } else if (ev === 'progress') {
    // Progress is advisory only; authoritative done count comes from file-done.
  } else if (ev === 'done') {
    if (state.completedPaths) setOverall(state.completedPaths.size, status.total);
    else setOverall(d.total, status.total);
    // Use the client-side accumulated counts: the server's per-round counters
    // restart at 0 on each reconnect, so they under-report across resumes.
    if (state.mode === 'diagnose') {
      const healthy = status.skipped, bad = status.failed;
      toast(`诊断完成：健康 ${healthy} · 有问题 ${bad}`, bad ? '' : 'ok');
    } else {
      toast(`完成：修复 ${status.repaired} · 跳过 ${status.skipped} · 失败 ${status.failed}`, status.failed ? 'bad' : 'ok');
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
    const pathItems = targets.filter((i) => i.mode === 'path' || i.mode === 'handle');
    if (pathItems.length) await runPathMode(mode, pathItems);
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
  const d = await fetch('/api/pick-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ multiple: true }) }).then((r) => r.json()).catch(() => null);
  if (d?.ok) {
    if (!d.paths.length) toast('所选文件中没有视频', 'bad');
    else { const { added } = await loadPaths(d.paths); toast(added ? `已载入 ${added} 个视频（路径模式 · 原地覆盖）` : '没有新增视频文件', added ? 'ok' : ''); }
  } else if (d && !d.cancelled) toast(d.error || '选择失败', 'bad');
}

$('pickFiles').onclick = (e) => { e.stopPropagation(); pickFiles(); };
$('pickFolder').onclick = async (e) => {
  e.stopPropagation();
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
  const ok = await askConfirm({
    title: '确认修复并覆盖原文件',
    subtitle: `即将直接覆盖 ${sel.length} 个原文件，不保留备份`,
    icon: 'repair', tone: 'danger',
    stats: [
      { label: '待修复', value: String(sel.length) },
      { label: '涉及大小', value: fmtSize(bytes) },
    ],
    lines: ['<b>安全保证：</b>产物先写临时文件，通过校验（可解析、时长不短于原片 90%、可解码）才替换原名。',
      '任何一步失败，原文件保持不动；清单之外和未勾选的文件不会被改动。'],
    warn: '此操作会直接覆盖原文件且不保留备份。请确认已了解风险。',
    confirmText: '确认修复', dangerConfirm: true,
  });
  if (!ok) return;
  $('repairPanel').hidden = true;
  start('repair', sel);
};
$('fpRetry').onclick = retryFailed;
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
// ============================ 合并视频 ============================
// Same intake philosophy as repair: only real local paths ever reach the
// server, so clips are never uploaded. Order in this list is the merge order.
const mstate = {
  clips: [], running: false, abort: null, stopFlag: false,
  plan: null, plans: [], suggested: '', suggestedList: [], lastOutput: '', logs: [],
  summary: null, session: null,
  drag: -1, dragTask: -1, mExpanded: new Set(), taskNames: {},
  planTimer: null, planSeq: 0, timer: null,
};

function switchView(view, { hash = true } = {}) {
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.view === view;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  $('viewRepair').hidden = view !== 'repair';
  $('viewMerge').hidden = view !== 'merge';
  // Deep-linkable: #merge opens the merge tab directly.
  if (hash) history.replaceState(null, '', view === 'merge' ? '#merge' : '#repair');
  if (view === 'merge' && mstate.clips.length && !mstate.plans.length) mSchedulePlan();
}
for (const t of document.querySelectorAll('.tab')) t.onclick = () => switchView(t.dataset.view);

function mActionTag(c) {
  if (c.error) return '<span class="mtag skip">跳过</span>';
  if (c.action === undefined) return '<span class="mtag none">分析中…</span>';
  if (c.action === null) return '<span class="mtag none">—</span>';
  const map = {
    copy: ['copy', '无损'], remux: ['remux', '重封装'], audio: ['audio', '仅修音频'],
    silence: ['audio', '补静音'], encode: ['encode', '重编码'], skip: ['skip', '跳过'],
  };
  const [cls, label] = map[c.action] || ['none', c.action];
  return `<span class="mtag ${esc(cls)}">${esc(label)}</span>`;
}

function clipActionOf(info, plan) {
  if (!info || !info.ok) return null;
  if (!plan || !plan.ok) return null;
  if (plan.strategy === 'copy') return 'copy';
  if (plan.strategy === 'remux') return 'remux';
  if (plan.copyVideo) return info.audio ? 'audio' : 'silence';
  return 'encode';
}

function mAppendFiles(files) {
  let added = 0;
  for (const f of files) {
    if (mstate.clips.some((c) => c.path === f.path)) continue;
    mstate.clips.push({
      path: f.path, name: f.name, size: f.size, rel: f.rel || '',
      dur: 0, info: null, error: null, action: undefined, breakAfter: false,
    });
    added++;
  }
  return added;
}

function mDirOf(p) {
  const i = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'));
  return i > 0 ? String(p).slice(0, i) : '.';
}
const mBaseOf = (p) => String(p).split(/[\\/]/).pop() || '';

// Mirrors the server's media-suffix list: a typed extension is never trusted,
// the merge plan decides the real container. Kept here only so the field shows
// the same name that will be written; the server always re-normalises.
const MEDIA_EXT_RE = /\.(?:mp4|m4v|mov|mkv|avi|webm|flv|wmv|mpg|mpeg|m2ts|mts|ts|3gp|3g2|ogv|ogm|vob|rm|rmvb|asf|divx|f4v|hevc|h264|aac|mp3|m4a|flac|wav|ogg)$/i;
function mNormOutName(raw, ext) {
  let s = String(raw || '').trim().replace(MEDIA_EXT_RE, '');
  const dot = s.startsWith('.') ? '.' : '';
  const chars = [...s];
  s = (chars.length > 60 ? chars.slice(0, 60).join('') : s)
    .replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').replace(/[\s.\-_]+$/g, '');
  return `${dot}${s || 'video'}.${ext || 'mp4'}`;
}

// A task's identity is its *set* of member paths, not whichever clip happens
// to be first. Storing the name / expanded flag on `group[0]` loses them the
// moment the user reorders rows inside the task. Sorting the paths makes the
// key order-independent, so intra-task moves keep metadata; split/join create
// a new set and therefore a fresh task with default settings (expected).
function mTaskKey(group) {
  return group.map((c) => c.path).sort().join('\u0001');
}
function mTaskName(group) {
  return String(mstate.taskNames[mTaskKey(group)] || '');
}
// The value is passed through verbatim — the server's resolveOutput() decides
// the folder (bare name → first clip's own folder) and always applies the
// plan's extension. Never pre-build a path or keep a typed suffix here.
function mTaskOutput(group) {
  return mTaskName(group).trim() || null;
}

// A task boundary lives on the clip before it (`breakAfter`), so reordering and
// removal keep groups coherent without a second array to keep in sync.
function mSplitTasks(source = mstate.clips) {
  const tasks = [];
  let cur = [];
  const clips = source;
  for (let i = 0; i < clips.length; i++) {
    cur.push(clips[i]);
    if (clips[i].breakAfter || i === clips.length - 1) {
      tasks.push(cur);
      cur = [];
    }
  }
  return tasks;
}

function mRenderRow(c, i, list, canSplit) {
  const row = document.createElement('div');
  row.className = 'mrow' + (c.error ? ' bad-row' : '');
  row.draggable = true;
  row.dataset.i = String(i);
  const dur = c.dur ? fmtDur(c.dur) : (c.error ? '—' : '…');
  const size = c.size ? fmtSize(c.size) : '';
  const spec = c.info
    ? `${c.info.video.width}×${c.info.video.height} · ${c.info.video.codec}${c.info.video.fps ? ` · ${Math.round(c.info.video.fps)}fps` : ''}${c.info.audio ? '' : ' · 无音轨'}`
    : (c.error || '分析中…');
  const split = canSplit
    ? `<button type="button" data-act="split" class="split${c.breakAfter ? ' on' : ''}" title="${c.breakAfter ? '把下一个片段并回本任务' : '从这一行之后切成新任务'}">⊟</button>`
    : '<button type="button" disabled title="最后一段无需分割">⊟</button>';
  row.innerHTML = `<span class="c-ord">${i + 1}</span>`
    + `<span class="c-name"><span class="fname" title="${esc(c.path)}">${esc(c.name)}</span>`
    + `<span class="frel" title="${esc(c.rel)}">${esc(c.rel)}</span></span>`
    + `<span class="c-size">${dur}${size ? ' · ' + size : ''}</span>`
    + `<span class="c-status"><span class="mrow-meta" title="${esc(spec)}">${esc(spec)}</span></span>`
    + `<span class="c-detail">${mActionTag(c)}</span>`
    + `<span class="c-ops">`
    + `<button type="button" data-act="up" title="上移"${i === 0 ? ' disabled' : ''}>↑</button>`
    + `<button type="button" data-act="down" title="下移"${i === mstate.clips.length - 1 ? ' disabled' : ''}>↓</button>`
    + split
    + `<button type="button" data-act="rm" class="rm" title="移除">✕</button>`
    + `</span>`;
  row.querySelector('.c-ops').onclick = (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    if (act === 'up') mMove(i, i - 1);
    else if (act === 'down') mMove(i, i + 1);
    else if (act === 'split') {
      c.breakAfter = !c.breakAfter;
      mRender();
      mSchedulePlan();
    } else if (act === 'rm') {
      mstate.clips.splice(i, 1);
      mRender();
      mSchedulePlan();
    }
  };
  list.appendChild(row);
}

// One badge summarising how a whole task will be merged, shown on its card.
function mTaskPlanTag(gi) {
  const p = mstate.plans?.[gi];
  if (!p) return '<span class="mtag none">分析中…</span>';
  if (!p.ok) return '<span class="mtag skip">规格不一致</span>';
  const label = { copy: '无损拼接', remux: '重封装', encode: p.copyVideo ? '仅修音频' : '重编码' }[p.strategy] || p.strategy;
  const cls = (p.strategy === 'encode' && p.copyVideo) ? 'audio' : p.strategy;
  return `<span class="mtag ${esc(cls)}">${esc(label)}</span>`;
}

function mRender() {
  const list = $('mList');
  list.innerHTML = '';
  $('mEmpty').hidden = mstate.clips.length > 0;
  const tasks = mSplitTasks();
  const multi = tasks.length > 1;
  $('mGroupHint').hidden = mstate.clips.length < 2;
  // Drop metadata for tasks that no longer exist after a split/join/removal.
  const liveKeys = new Set(tasks.map(mTaskKey));
  for (const k of Object.keys(mstate.taskNames)) if (!liveKeys.has(k)) delete mstate.taskNames[k];
  for (const k of mstate.mExpanded) if (!liveKeys.has(k)) mstate.mExpanded.delete(k);
  let idx = 0;
  tasks.forEach((group, gi) => {
    if (!multi) {
      group.forEach((c) => mRenderRow(c, idx++, list, idx < mstate.clips.length));
      return;
    }

    // The card head stays visible; only its body (the clip rows) is collapsible.
    // Identity is the sorted member-path set, so both expansion and the custom
    // product name survive row reordering and plan refreshes. New tasks start collapsed.
    const key = mTaskKey(group);
    const open = mstate.mExpanded.has(key);
    const card = document.createElement('div');
    card.className = 'mtask-card' + (open ? ' open' : '');
    card.dataset.task = String(gi);

    const head = document.createElement('div');
    head.className = 'mtask-head';
    head.draggable = true;
    const dur = group.reduce((s, c) => s + (c.dur || 0), 0);
    const bytes = group.reduce((s, c) => s + (c.size || 0), 0);
    const auto = mstate.suggestedList?.[gi];
    const custom = mTaskName(group);
    const outPlaceholder = auto ? `默认 ${mBaseOf(auto)}` : '自动命名';
    const first = group[0];
    const firstLabel = first.name + (group.length > 1 ? ` 等 ${group.length} 段` : '');
    head.innerHTML = `<span class="mtask-grip" title="拖动整张卡调整任务顺序">⠿</span>`
      + `<button type="button" class="mtask-toggle" title="${open ? '收起' : '展开'}该任务的片段">${open ? '▾' : '▸'}</button>`
      + `<span class="mtask-no">任务 ${gi + 1}</span>`
      + `<span class="mtask-summary"><span class="mtask-first" title="${esc(first.path)}">${esc(firstLabel)}</span>`
      + `<span class="mtask-sub">${group.length} 段${dur ? ` · ${fmtDur(dur)}` : ''}${bytes ? ` · ${fmtSize(bytes)}` : ''}</span></span>`
      + `<span class="mtask-plan">${mTaskPlanTag(gi)}</span>`
      + `<input type="text" class="mtask-out${custom ? ' custom' : ''}" spellcheck="false" `
      + `value="${esc(custom)}" placeholder="${esc(outPlaceholder)}" `
      + `title="产物文件名：可填名称或路径，留空用默认。默认存到首个片段所在文件夹">`
      + (gi > 0 ? '<button type="button" class="mtask-join" title="把本任务并回上一个任务">并回上一任务</button>' : '');

    // Clicking the head (outside its controls) toggles the card.
    const toggle = () => {
      if (mstate.mExpanded.has(key)) mstate.mExpanded.delete(key);
      else mstate.mExpanded.add(key);
      mRender();
    };
    head.querySelector('.mtask-toggle').onclick = (e) => { e.stopPropagation(); toggle(); };
    head.onclick = (e) => { if (!e.target.closest('input, button')) toggle(); };

    // Editable output name. `change` fires on blur / Enter; never re-render on
    // each keystroke. Keep the field's clicks from toggling the card.
    const outEl = head.querySelector('.mtask-out');
    outEl.onclick = (e) => e.stopPropagation();
    outEl.onchange = () => {
      const v = outEl.value.trim();
      if (!v) mstate.taskNames[key] = '';
      else if (v.includes('/') || v.includes('\\')) mstate.taskNames[key] = v;
      else mstate.taskNames[key] = mNormOutName(v, mstate.plans?.[gi]?.outExt || 'mp4');
      outEl.value = mstate.taskNames[key];
      outEl.classList.toggle('custom', !!mstate.taskNames[key]);
      outEl.placeholder = mstate.taskNames[key] ? outPlaceholder : (auto ? `默认 ${mBaseOf(auto)}` : '自动命名');
    };
    outEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); outEl.blur(); } };

    const join = head.querySelector('.mtask-join');
    if (join) {
      // Capture now: `idx` keeps changing as later groups render.
      const boundary = idx - 1;
      join.onclick = (e) => {
        e.stopPropagation();
        if (mstate.clips[boundary]) mstate.clips[boundary].breakAfter = false;
        mRender();
        mSchedulePlan();
      };
    }

    const body = document.createElement('div');
    body.className = 'mtask-body';
    body.hidden = !open;
    group.forEach((c) => mRenderRow(c, idx++, body, idx < mstate.clips.length));
    card.append(head, body);
    list.appendChild(card);
  });
  mUpdateMergeMeta();
}

// Move a whole task (all its clips stay together), then rebuild breakAfter so
// the grouping stays coherent. Down lands after the target, up lands before it.
function mMoveTask(from, to) {
  const tasks = mSplitTasks();
  if (from < 0 || to < 0 || from >= tasks.length || to >= tasks.length || from === to) return;
  const [moved] = tasks.splice(from, 1);
  tasks.splice(to, 0, moved);
  const flat = [];
  tasks.forEach((g, i) => g.forEach((c, j) => {
    c.breakAfter = (j === g.length - 1 && i < tasks.length - 1);
    flat.push(c);
  }));
  mstate.clips = flat;
  mRender();
  mSchedulePlan();
}

function mMove(from, to) {
  if (to < 0 || to >= mstate.clips.length || from === to) return;
  const [it] = mstate.clips.splice(from, 1);
  mstate.clips.splice(to, 0, it);
  mRender();
  mSchedulePlan();
}

function mUpdateMergeMeta() {
  const n = mstate.clips.length;
  const tasks = mSplitTasks();
  const multi = tasks.length > 1;
  const total = mstate.clips.reduce((s, c) => s + (c.dur || 0), 0);
  const bytes = mstate.clips.reduce((s, c) => s + (c.size || 0), 0);
  const parts = [`<span>共 <b>${n}</b> 段</span>`];
  if (multi) parts.push(`<span>分 <b>${tasks.length}</b> 个任务</span>`);
  if (total) parts.push(`<span>总时长 <b>${fmtDur(total)}</b></span>`);
  if (bytes) parts.push(`<span>总大小 <b>${fmtSize(bytes)}</b></span>`);

  const plans = mstate.plans || [];
  if (plans.length === 1 && plans[0]?.ok) {
    const p = plans[0];
    const label = { copy: '无损拼接', remux: '重封装拼接', encode: p.copyVideo ? '仅重编码音频' : '需要重编码' }[p.strategy];
    parts.push(`<span class="${p.strategy === 'copy' ? 'ok' : 'warn'}"><b>${label}</b></span>`);
  } else if (plans.length === 1 && plans[0] && !plans[0].ok) {
    parts.push('<span class="bad"><b>规格不一致</b></span>');
  } else if (multi && plans.length === tasks.length) {
    const copy = plans.filter((p) => p?.strategy === 'copy').length;
    const bad = plans.filter((p) => p && !p.ok).length;
    parts.push(`<span class="${copy === plans.length ? 'ok' : 'warn'}"><b>${copy}/${plans.length}</b> 任务可无损</span>`);
    if (bad) parts.push(`<span class="bad"><b>${bad} 个任务无法合并</b></span>`);
  }

  const badGroups = tasks.filter((t) => t.length < 2).length;
  if (badGroups) parts.push(`<span class="bad"><b>${badGroups} 个任务只有 1 段</b></span>`);
  if ($('mDeleteSources').checked && n >= 2) parts.push('<span class="bad"><b>成功后移入废纸篓</b></span>');

  $('mCounts').innerHTML = parts.join('');
  $('mStart').disabled = n < 2 || mstate.running || badGroups > 0;
  $('mClear').disabled = !n || mstate.running;
  $('mStart').textContent = !n ? '开始合并'
    : multi ? `开始合并 ${tasks.length} 个任务`
      : `开始合并 ${n} 个片段`;
  // A single output path cannot describe several products, so multi-task runs
  // always auto-name beside each task's first clip.
  $('mOutput').disabled = multi || mstate.running;
  $('mOutput').title = multi ? '多任务时在每个任务头里单独填写产物名，留空用默认' : '留空自动命名，可填名称或完整路径';
  $('mPickOutput').disabled = multi || mstate.running;
  $('mClearOutput').disabled = multi || mstate.running;
}

// Probing N clips is cheap but not free; debounce so drag-reordering a long
// list does not fire one analysis per move.
function mSchedulePlan() {
  clearTimeout(mstate.planTimer);
  mstate.plans = [];
  mstate.plan = null;
  mstate.planTimer = setTimeout(mRefreshPlan, 450);
}

// Each task is planned independently: a group of 4K clips and a group of 720p
// clips should not be forced onto a shared target just because they share a
// list. Requests run sequentially so a 50-task list does not flood ffprobe.
async function mRefreshPlan() {
  if (mstate.running) return;
  const tasks = mSplitTasks();
  if (!tasks.length) { mstate.plans = []; mstate.plan = null; mRender(); return; }
  const seq = ++mstate.planSeq;
  for (const c of mstate.clips) c.action = undefined;
  mRender();
  const plans = [];
  const suggestions = [];
  try {
    for (let gi = 0; gi < tasks.length; gi++) {
      const task = tasks[gi];
      if (seq !== mstate.planSeq) return;
      const r = await fetch('/api/merge-plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: task.map((c) => c.path),
          mode: $('mMode').value, size: $('mSize').value, quality: $('mQuality').value,
          index: gi, total: tasks.length,
        }),
      });
      const d = await r.json();
      if (seq !== mstate.planSeq) return;
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const byPath = new Map((d.clips || []).map((c) => [c.file, c]));
      for (const c of task) {
        const info = byPath.get(c.path);
        if (!info) continue;
        c.error = info.ok ? null : (info.error || '无法解析');
        c.dur = info.duration || 0;
        c.info = info.ok ? info : null;
        if (info.size) c.size = info.size;
        c.action = clipActionOf(info, d.plan);
      }
      plans.push(d.plan);
      suggestions[gi] = d.suggestedOutput || '';
      if (tasks.length === 1) {
        mstate.suggested = d.suggestedOutput || '';
        if (!$('mOutput').value) {
          $('mOutput').placeholder = d.suggestedOutput
            ? `自动：${mBaseOf(d.suggestedOutput)}`
            : '自动：首个片段所在文件夹';
        }
      }
    }
    mstate.plans = plans;
    mstate.suggestedList = suggestions;
    mstate.plan = plans.length === 1 ? plans[0] : null;
  } catch (e) {
    if (seq === mstate.planSeq) toast(`分析片段失败：${e}`, 'bad');
  }
  mRender();
}

async function mLoadPaths(paths) {
  let added = 0, results = [];
  const all = [];
  try {
    const r = await fetch('/api/scan-many', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    for (let i = 0; i < paths.length; i++) {
      const rr = d.results?.[i];
      if (rr?.ok) {
        for (const f of (rr.files || [])) all.push(f);
        results.push({ ok: true, count: rr.count });
      } else {
        results.push({ ok: false, error: rr?.error || '无扫描结果' });
      }
    }
    added = mAppendFiles(all);
    if (added) { mRender(); mSchedulePlan(); }
  } catch (e) {
    toast(`载入失败：${e}`, 'bad');
  }
  return { added, results };
}

async function mIntakeDataTransfer(dt) {
  const files = [...dt.files].filter((f) => VIDEO_RE.test(f.name));
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const hasDir = entries.some((e) => e.isDirectory);
  if (!files.length && !hasDir) { toast('没有识别到视频文件', 'bad'); return; }
  toast('正在打开原生选择器以获取真实路径…', '');
  if (hasDir) {
    const d = await fetch('/api/pick-folder', { method: 'POST' }).then((r) => r.json()).catch(() => null);
    if (d?.ok) {
      const { added } = await mLoadPaths([d.path]);
      toast(added ? `已加入 ${added} 个片段` : '没有新增片段', added ? 'ok' : '');
    } else if (d && !d.cancelled) toast(d.error || '选择失败', 'bad');
  } else {
    const d = await fetch('/api/pick-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ multiple: true }),
    }).then((r) => r.json()).catch(() => null);
    if (d?.ok) {
      if (!d.paths.length) toast('所选文件中没有视频', 'bad');
      else {
        const { added } = await mLoadPaths(d.paths);
        toast(added ? `已加入 ${added} 个片段` : '没有新增片段', added ? 'ok' : '');
      }
    } else if (d && !d.cancelled) toast(d.error || '选择失败', 'bad');
  }
}

function mSetRunning(on) {
  mstate.running = on;
  $('mStop').hidden = !on;
  $('mMode').disabled = on; $('mSize').disabled = on; $('mQuality').disabled = on;
  $('mDeleteSources').disabled = on;
  // Intake stays live while running: clips added mid-run become the next batch.
  $('mPathGo').disabled = !parsePaths($('mPathInput').value).length;
  mUpdateMergeMeta();
  mRender();
}

// One result row per task. "需复核" means the merge itself produced a file but
// the product failed verification, so the sources were deliberately kept.
function showQueueResult(sum) {
  const box = $('mResult');
  const tasks = sum.tasks || [];
  const hasFail = sum.failed > 0 || sum.notRun > 0;
  const hasIssue = hasFail || sum.partial > 0 || sum.trashErrorCount > 0;
  box.hidden = false;
  box.classList.toggle('bad', hasFail);
  box.classList.toggle('warn', hasIssue && !hasFail);
  $('mResultIcon').textContent = hasFail ? '✕' : hasIssue ? '!' : '✓';
  $('mResultTitle').textContent = hasFail ? '队列未完成，有任务失败' : hasIssue ? '队列完成，部分需复核' : '全部任务完成';

  const bits = [`${sum.total} 个任务`];
  if (sum.succeeded) bits.push(`${sum.succeeded} 成功`);
  if (sum.partial) bits.push(`${sum.partial} 需复核`);
  if (sum.failed) bits.push(`${sum.failed} 失败`);
  if (sum.notRun) bits.push(`${sum.notRun} 未执行`);
  if (sum.deletedCount) bits.push(`已移入废纸篓 ${sum.deletedCount} 个源文件`);
  if (sum.keptCount) bits.push(`保留 ${sum.keptCount} 个源文件`);
  if (sum.trashErrorCount) bits.push(`删除失败 ${sum.trashErrorCount} 个`);
  $('mResultSub').textContent = bits.join(' · ');

  const firstOut = tasks.find((t) => t.output);
  $('mResultPath').textContent = tasks.length === 1 && firstOut ? firstOut.output : '';
  $('mResultPath').hidden = !(tasks.length === 1 && firstOut);

  const tl = $('mTaskList');
  tl.hidden = !tasks.length;
  tl.innerHTML = tasks.map((t) => {
    const state = t.trashErrors?.length ? 'part'
      : t.ok && (t.verified || !sum.deleteSources) ? 'ok' : (t.ok ? 'part' : 'bad');
    const icon = state === 'ok' ? '✓' : state === 'part' ? '!' : '✕';
    const label = state === 'ok' ? '成功' : state === 'part' ? '需复核' : '失败';
    const det = [];
    if (t.output) {
      if (t.duration) det.push(fmtDur(t.duration));
      if (t.size) det.push(fmtSize(t.size));
    }
    if (t.deleted?.length) det.push(`已移入废纸篓 ${t.deleted.length} 个`);
    if (t.kept?.length) det.push(`保留 ${t.kept.length} 个源文件`);
    if (t.trashErrors?.length) det.push(`删除失败 ${t.trashErrors.length} 个：${t.trashErrors[0].reason}`);
    const why = t.verifiedReason || (t.reasons || [])[0];
    if (why && state !== 'ok') det.push(why);
    return `<div class="mt-row ${state}">`
      + `<span class="mt-icon">${icon}</span>`
      + `<span class="mt-no">任务 ${t.index + 1}</span>`
      + `<span class="mt-label">${label}</span>`
      + `<span class="mt-detail" title="${esc(det.join(' · '))}">${esc(det.join(' · ') || '—')}</span>`
      + '</div>';
  }).join('');

  const trashErrs = tasks.flatMap((t) => (t.trashErrors || []).map((e) => ({ ...e, task: t.index + 1 })));
  const failedPaths = new Set(trashErrs.map((e) => e.file));
  const kept = (tasks.flatMap((t) => (t.kept || []))).filter((p) => !failedPaths.has(p));
  const w = $('mResultWarn');
  const partialStream = !!sum.partialStream;
  w.hidden = !trashErrs.length && !kept.length && !partialStream;
  if (!w.hidden) {
    const parts = [];
    if (partialStream) parts.push('<div>连接在队列结束前中断：以上仅列出已收到结果的任务，其余未执行状态未知，请核对产物后决定是否重跑。</div>');
    if (trashErrs.length) {
      parts.push(`<div>以下 ${trashErrs.length} 个源文件移入废纸篓失败，已原样保留：</div>`);
      for (const e of trashErrs.slice(0, 40)) {
        parts.push(`<div class="mw-path">任务 ${e.task} · ${esc(e.file)}<span class="mw-why">${esc(e.reason)}</span></div>`);
      }
      if (trashErrs.length > 40) parts.push(`<div>… 另有 ${trashErrs.length - 40} 个</div>`);
    }
    if (kept.length) {
      parts.push(`<div>以下 ${kept.length} 个源文件因所在任务未通过校验而保留，未做任何改动：</div>`);
      parts.push(...kept.slice(0, 40).map((p) => `<div class="mw-path">${esc(p)}</div>`));
      if (kept.length > 40) parts.push(`<div>… 另有 ${kept.length - 40} 个</div>`);
    }
    w.innerHTML = parts.join('');
  }

  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Validate a task list before sending it. `checkPlan` is only used for the
// first batch; mid-run additions may still be waiting for their analysis.
function mValidateTasks(tasks, checkPlan = false) {
  if (!tasks.length) return { ok: false, error: '没有任务' };
  const badIdx = tasks.findIndex((t) => t.length < 2);
  if (badIdx >= 0) return { ok: false, error: `任务 ${badIdx + 1} 只有 1 段，请先并回相邻任务或补充片段` };
  const usable = tasks.map((t) => t.filter((c) => !c.error));
  if (usable.some((t) => t.length < 2)) return { ok: false, error: '有任务的可用片段不足 2 个，请先移除无法解析的文件' };
  if (checkPlan) {
    const badPlan = (mstate.plans || []).find((p) => p && !p.ok);
    if (badPlan) return { ok: false, error: badPlan.reasons?.[0] || '有任务在当前设置下无法合并' };
  }
  return { ok: true };
}

// Combine all batch summaries into one result card with global task numbering.
function mSummarizeSummaries(list) {
  const out = {
    total: 0, succeeded: 0, partial: 0, failed: 0, notRun: 0,
    deletedCount: 0, keptCount: 0, trashErrorCount: 0, tasks: [], deleteSources: false,
  };
  for (const s of list) {
    for (const k of ['total', 'succeeded', 'partial', 'failed', 'notRun', 'deletedCount', 'keptCount', 'trashErrorCount']) out[k] += s[k] || 0;
    out.deleteSources = out.deleteSources || !!s.deleteSources;
    out.partialStream = out.partialStream || !!s.partialStream;
    for (const t of (s.tasks || [])) out.tasks.push({ ...t, index: out.tasks.length });
  }
  if (!list.length) out.deleteSources = !!$('mDeleteSources')?.checked;
  return out;
}

async function mStart() {
  if (mstate.running) return;
  const tasks = mSplitTasks();
  const v = mValidateTasks(tasks, true);
  if (!v.ok) { toast(v.error, 'bad'); return; }

  const single = tasks.length === 1;
  const doDelete = $('mDeleteSources').checked;
  // The manual save path used to be shown in this dialog but never sent to the
  // server, so a hand-picked location was silently ignored. Send it now.
  const manual = single ? $('mOutput').value.trim() : '';
  const totalDur = mstate.clips.reduce((s, c) => s + (c.dur || 0), 0);
  const skipCount = mstate.clips.filter((c) => c.error).length;

  const p = mstate.plans?.[0];
  const strat = p?.ok
    ? { copy: '无损拼接', remux: '重封装无损', encode: p.copyVideo ? '仅重编码音频' : '统一规格重编码' }[p.strategy]
    : '自动选择';
  const stats = single
    ? [
        { label: '片段', value: String(mstate.clips.length) },
        { label: '预计时长', value: fmtDur(totalDur) || '—' },
        { label: '方式', value: strat, small: true },
      ]
    : [
        { label: '任务', value: String(tasks.length) },
        { label: '片段', value: String(mstate.clips.length) },
        { label: '预计时长', value: fmtDur(totalDur) || '—' },
      ];
  const manualShown = manual
    ? (manual.includes('/') || manual.includes('\\') ? manual : mNormOutName(manual, p?.outExt || 'mp4'))
    : '';
  const rows = single
    ? [{ label: '输出文件', value: manualShown || mstate.suggested || '首个片段所在文件夹（自动命名）' }]
    : [{ label: '输出文件', value: '各自存到该任务首个片段所在文件夹，命名如 <首段名>_merged_t01.mp4' }];
  const warn = doDelete
    ? (skipCount
        ? `合并成功后将把源文件移入废纸篓（可还原）。仅零告警且校验通过的任务会删，否则整组保留。<br>注意：有 <b>${skipCount}</b> 个片段无法解析，所在任务会整组保留源文件。`
        : '合并成功后将把源文件移入废纸篓（可还原）。仅零告警且校验通过的任务会删，否则整组保留。')
    : '';
  const ok = await askConfirm({
    title: single ? '确认合并' : `确认合并 ${tasks.length} 个任务`,
    subtitle: single
      ? `${mstate.clips.length} 个片段将按顺序拼接为 1 个文件`
      : `${mstate.clips.length} 个片段分成 ${tasks.length} 组，各组独立合并成一个文件`,
    icon: 'merge', tone: 'info',
    stats, rows, warn,
    lines: doDelete ? [] : ['源文件不会被删除。'],
    confirmText: single ? '开始合并' : `开始合并 ${tasks.length} 个任务`,
  });
  if (!ok) return;

  // A session can span several batches: clips added while one batch is running
  // are picked up as a new batch when it finishes. Settings are snapshotted so
  // a mid-run batch uses exactly the same options as the first one.
  mstate.session = {
    opts: { mode: $('mMode').value, size: $('mSize').value, quality: $('mQuality').value, doDelete },
    manual,
    summaries: [],
    donePaths: new Set(),
    batchNo: 0,
    t0: Date.now(),
  };
  mstate.stopFlag = false;
  mstate.logs = [];
  mstate.summary = null;
  $('mResult').hidden = true;
  $('mTaskList').hidden = true;
  mSetRunning(true);
  await mRunBatch(tasks);
}

// Run one batch over SSE. On completion, any clips added mid-run (paths not yet
// submitted) become the next batch automatically. Stops never spawn a new batch.
async function mRunBatch(tasks) {
  const s = mstate.session;
  s.batchNo += 1;
  const batchNo = s.batchNo;
  const single = tasks.length === 1;
  const doDelete = s.opts.doDelete;
  for (const t of tasks) for (const c of t) s.donePaths.add(c.path);

  const panel = $('mStatusPanel');
  panel.hidden = false;
  panel.classList.remove('done', 'warn', 'bad');
  const tag = s.summaries.length ? `第 ${batchNo} 批 · ` : '';
  $('mStatusTitle').textContent = single ? `正在合并${tag}` : `正在合并${tag}任务 1 / ${tasks.length}`;
  $('mStatusCounts').textContent = single ? `${tasks[0].length} 个片段` : `0 / ${tasks.length} 个任务`;
  $('mCurClip').textContent = '准备中…';
  $('mCurIndex').textContent = '';
  $('mCurStage').textContent = '分析片段…';
  $('mCurMetrics').textContent = '';
  $('mBar').classList.add('indeterminate');
  $('mBar').style.width = '';
  $('mBarTotal').style.width = '0%';
  $('mPercent').textContent = '0%';
  $('mElapsed').textContent = fmtClock(Date.now() - s.t0);
  clearInterval(mstate.timer);
  mstate.timer = setInterval(() => { $('mElapsed').textContent = fmtClock(Date.now() - s.t0); }, 500);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const ctrl = new AbortController();
  mstate.abort = ctrl;
  let summary = null;
  // Accumulate per-task records as they arrive. If the stream drops before
  // `queue-done` (server restart / network), we can still show exactly which
  // products were completed instead of a blank "队列异常中断".
  const seenTasks = [];
  let doneTasks = 0;
  try {
    const res = await fetch('/api/merge-queue', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: tasks.map((t, i) => {
          const output = (s.manual && batchNo === 1 && i === 0) ? s.manual : mTaskOutput(t);
          const files = t.map((c) => c.path);
          return output ? { files, output } : { files };
        }),
        mode: s.opts.mode, size: s.opts.size, quality: s.opts.quality,
        deleteSources: doDelete,
      }),
    });
    if (!res.ok) throw new Error(`服务端错误 ${res.status}`);
    await readSSE(res, (ev, d) => {
      if (ev === 'queue-start') {
        $('mCurStage').textContent = `共 ${d.total} 个任务，准备中…`;
      } else if (ev === 'task-start') {
        $('mStatusTitle').textContent = `${tag}正在合并任务 ${d.index + 1} / ${d.total}`;
        $('mStatusCounts').textContent = `${doneTasks} / ${d.total} 个任务已完成`;
        $('mCurClip').textContent = d.names?.[0] || '—';
        $('mCurIndex').textContent = `1 / ${d.names?.length || 0}`;
        $('mCurStage').textContent = '分析片段…';
        $('mCurMetrics').textContent = '';
        $('mBar').classList.add('indeterminate');
        $('mBar').style.width = '';
      } else if (ev === 'clips') {
        const task = tasks[d.index];
        if (task) {
          const byPath = new Map((d.clips || []).map((c) => [c.file, c]));
          for (const c of task) {
            const info = byPath.get(c.path);
            if (!info) continue;
            c.error = info.ok ? null : (info.error || '无法解析');
            c.info = info.ok ? info : null;
            if (info.duration) c.dur = info.duration;
          }
          // Rebuilding the DOM mid-drag detaches the dragged node, leaving
          // mstate.drag/dragTask stuck ≥0 and later drags behaving erratically.
          if (mstate.drag < 0 && mstate.dragTask < 0) mRender();
        }
      } else if (ev === 'task-progress') {
        $('mCurStage').textContent = d.stage || '合并中…';
        if (d.clipName) $('mCurClip').textContent = d.clipName;
        const task = tasks[d.index];
        if (d.clipIndex != null && task) $('mCurIndex').textContent = `${d.clipIndex + 1} / ${task.length}`;
        if (d.percent != null) {
          const pct = Math.max(0, Math.min(100, d.percent));
          const overall = ((d.index + pct / 100) / tasks.length) * 100;
          $('mBar').classList.remove('indeterminate');
          $('mBar').style.width = `${pct}%`;
          $('mBarTotal').style.width = `${overall}%`;
          $('mPercent').textContent = `${overall.toFixed(0)}%`;
        }
        const bits = [];
        if (d.speed && d.speed !== 'N/A') bits.push(d.speed);
        if (d.outTime) bits.push(fmtDur(d.outTime));
        $('mCurMetrics').textContent = bits.join(' · ');
      } else if (ev === 'task-done') {
        seenTasks[d.index] = d;
        doneTasks = d.index + 1;
        $('mStatusCounts').textContent = `${doneTasks} / ${tasks.length} 个任务已完成`;
        $('mBarTotal').style.width = `${(doneTasks / tasks.length) * 100}%`;
        $('mPercent').textContent = `${((doneTasks / tasks.length) * 100).toFixed(0)}%`;
      } else if (ev === 'log') {
        mstate.logs.push(d.message);
      } else if (ev === 'queue-done') {
        summary = d;
      }
    });
  } catch (e) {
    if (e.name !== 'AbortError') toast(`合并出错：${e}`, 'bad');
  }

  // Per-batch teardown. Keep the session alive; only the whole session sets
  // running=false (in mFinishRun).
  clearInterval(mstate.timer);
  mstate.timer = null;
  mstate.abort = null;
  $('mBar').classList.remove('indeterminate');
  $('mElapsed').textContent = fmtClock(Date.now() - s.t0);

  // Build a partial summary from task-done records if the stream ended early.
  if (!summary && seenTasks.length) {
    const records = seenTasks.filter(Boolean);
    summary = {
      total: tasks.length,
      succeeded: records.filter((t) => t.ok && (!doDelete || t.verified)).length,
      partial: records.filter((t) => t.ok && doDelete && !t.verified).length,
      failed: records.filter((t) => !t.ok).length,
      notRun: tasks.length - records.length,
      deletedCount: records.reduce((n, t) => n + (t.deleted?.length || 0), 0),
      keptCount: records.reduce((n, t) => n + (t.kept?.length || 0), 0),
      trashErrorCount: records.reduce((n, t) => n + (t.trashErrors?.length || 0), 0),
      deleteSources: doDelete,
      tasks: records,
      partialStream: true,
    };
  }
  if (summary) {
    s.summaries.push(summary);
    // Sources moved to the trash have dead paths: drop them from the work list.
    const gone = new Set(summary.tasks.flatMap((t) => t.deleted || []));
    if (gone.size) mstate.clips = mstate.clips.filter((c) => !gone.has(c.path));
  }

  if (mstate.stopFlag) { mFinishRun(true); return; }

  // Clips added mid-run: any path not yet submitted and still parseable.
  const pending = mstate.clips.filter((c) => !s.donePaths.has(c.path) && !c.error);
  if (pending.length >= 2) {
    const nextTasks = mSplitTasks(pending);
    if (mValidateTasks(nextTasks).ok) {
      toast(`发现 ${pending.length} 个新片段，自动开始第 ${batchNo + 1} 批`, 'ok');
      mRender();
      await mRunBatch(nextTasks);
      return;
    }
  }
  mFinishRun(false, pending.length);
}

// Finalise the whole session: combine every batch into one result card.
function mFinishRun(stopped, leftover = 0) {
  const s = mstate.session;
  mSetRunning(false);
  const panel = $('mStatusPanel');
  const combined = mSummarizeSummaries(s.summaries);

  if (combined.tasks.length) {
    mstate.summary = combined;
    const clean = !stopped && combined.failed === 0 && combined.partial === 0 && combined.notRun === 0;
    $('mBar').style.width = '100%';
    $('mBarTotal').style.width = '100%';
    $('mPercent').textContent = '100%';
    panel.classList.add(stopped ? 'warn' : clean ? 'done' : 'warn');
    $('mStatusTitle').textContent = stopped ? '已停止' : clean ? '队列完成' : '队列完成（部分需处理）';
    $('mCurStage').textContent = stopped
      ? '已停止，当前批次未完成的任务不会留下半成品'
      : (s.summaries.length > 1 ? `共 ${s.summaries.length} 批全部跑完` : '全部任务已跑完');
    $('mCurMetrics').textContent = '';
    const firstOut = combined.tasks.find((t) => t.output);
    if (firstOut) mstate.lastOutput = firstOut.output;
    showQueueResult(combined);
    const tail = combined.deletedCount ? ` · 已移入废纸篓 ${combined.deletedCount} 个源文件` : '';
    toast(`${combined.succeeded} 成功${combined.failed ? ` / ${combined.failed} 失败` : ''}${tail}`, clean ? 'ok' : 'bad');
  } else {
    panel.classList.add(stopped ? 'warn' : 'bad');
    $('mStatusTitle').textContent = stopped ? '已停止' : '队列异常中断';
    $('mCurStage').textContent = stopped ? '已停止，未完成的任务不会留下半成品' : '未拿到队列结果，请查看日志';
    toast(stopped ? '已停止' : '队列异常中断', 'bad');
  }
  if (!stopped && leftover === 1) toast('有 1 个新增片段不足 2 个，未自动合并', '');
  mstate.session = null;
  mRender();
}


// ---------- merge intake wiring ----------
const mDrop = $('mDrop');
['dragenter', 'dragover'].forEach((ev) => mDrop.addEventListener(ev, (e) => { e.preventDefault(); mDrop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => mDrop.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'dragleave' && mDrop.contains(e.relatedTarget)) return;
  mDrop.classList.remove('over');
}));
mDrop.addEventListener('drop', async (e) => { e.preventDefault(); await mIntakeDataTransfer(e.dataTransfer); });
mDrop.addEventListener('click', (e) => {
  if (e.target === mDrop || (e.target.closest('.drop-inner') && !e.target.closest('button,input,textarea,.paste-box'))) mPickFiles();
});
mDrop.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea,button,select')) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mPickFiles(); }
});

async function mPickFiles() {
  const d = await fetch('/api/pick-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ multiple: true }),
  }).then((r) => r.json()).catch(() => null);
  if (d?.ok) {
    if (!d.paths.length) toast('所选文件中没有视频', 'bad');
    else {
      const { added } = await mLoadPaths(d.paths);
      toast(added ? `已加入 ${added} 个片段` : '没有新增片段', added ? 'ok' : '');
    }
  } else if (d && !d.cancelled) toast(d.error || '选择失败', 'bad');
}

$('mPickFiles').onclick = (e) => { e.stopPropagation(); mPickFiles(); };
$('mPickFolder').onclick = async (e) => {
  e.stopPropagation();
  const d = await fetch('/api/pick-folder', { method: 'POST' }).then((r) => r.json()).catch(() => null);
  if (d?.ok) {
    const { added } = await mLoadPaths([d.path]);
    toast(added ? `已按文件名顺序加入 ${added} 个片段` : '该文件夹没有新的视频', added ? 'ok' : '');
  } else if (d && !d.cancelled) toast(d.error || '选择失败', 'bad');
};
$('mPathGo').onclick = async (e) => {
  e.stopPropagation();
  const paths = parsePaths($('mPathInput').value);
  if (!paths.length) { toast('请先粘贴至少一个路径', ''); return; }
  const go = $('mPathGo');
  go.disabled = true; go.textContent = '载入中…';
  $('mPasteBox').classList.add('loading');
  const { added } = await mLoadPaths(paths);
  $('mPasteBox').classList.remove('loading');
  go.textContent = '载入';
  if (added) toast(`已加入 ${added} 个片段`, 'ok');
  else toast('没有新增片段', 'bad');
  mUpdateMergePaste();
};
$('mPathInput').onclick = (e) => e.stopPropagation();
$('mPathInput').oninput = () => mUpdateMergePaste();
$('mPathInput').onkeydown = (e) => {
  e.stopPropagation();
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('mPathGo').click(); }
};
$('mPasteClear').onclick = (e) => { e.stopPropagation(); $('mPathInput').value = ''; mUpdateMergePaste(); };

function mUpdateMergePaste() {
  const n = parsePaths($('mPathInput').value).length;
  const c = $('mPasteCount');
  c.textContent = n ? `${n} 个路径` : '';
  c.classList.toggle('on', n > 0);
  $('mPathGo').disabled = !n || mstate.running;
  $('mPathGo').textContent = n > 1 ? `载入 ${n} 个` : '载入';
  const ta = $('mPathInput');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 46), 176)}px`;
}

$('mPickOutput').onclick = async (e) => {
  e.stopPropagation();
  const first = mstate.clips.find((c) => !c.error);
  const base = first ? first.name.replace(/\.[^.]+$/, '') : 'merged';
  const ext = mstate.plan?.outExt || mstate.plans?.[0]?.outExt || 'mp4';
  const d = await fetch('/api/pick-save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultName: `${base}_merged.${ext}` }),
  }).then((r) => r.json()).catch(() => null);
  if (d?.ok && d.path) { $('mOutput').value = d.path; toast('输出位置已设置', 'ok'); }
  else if (d && !d.cancelled) toast(d.error || '选择失败', 'bad');
};
$('mClearOutput').onclick = (e) => { e.stopPropagation(); $('mOutput').value = ''; };
$('mStart').onclick = mStart;
$('mClear').onclick = () => {
  if (mstate.running) return;
  mstate.clips = []; mstate.plan = null; mstate.plans = []; mstate.suggested = '';
  mstate.suggestedList = []; mstate.summary = null;
  $('mResult').hidden = true;
  $('mTaskList').hidden = true;
  $('mStatusPanel').hidden = true;
  mRender();
};
$('mStop').onclick = () => { mstate.stopFlag = true; mstate.abort?.abort(); toast('正在停止…', ''); };
$('mReveal').onclick = async () => {
  if (!mstate.lastOutput) return;
  const r = await fetch('/api/reveal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: mstate.lastOutput }),
  }).then((x) => x.json()).catch(() => null);
  if (!r?.ok) toast('无法在 Finder 中显示（可能只支持 macOS）', 'bad');
};

for (const id of ['mMode', 'mSize', 'mQuality']) $(id).onchange = () => mSchedulePlan();
$('mDeleteSources').onchange = () => {
  mUpdateMergeMeta();
  if ($('mDeleteSources').checked) {
    toast('已开启：仅在零告警且时长校验通过时，把源文件移入废纸篓', '');
  }
};

// Two drag scopes: a collapsed/expanded card head reorders whole tasks; a clip
// row reorders within the flat list. Only one is active at a time.
$('mList').addEventListener('dragstart', (e) => {
  // Controls inside a head (input/buttons) are not drag handles.
  if (e.target.closest('input, button')) { e.preventDefault(); return; }
  const head = e.target.closest('.mtask-head');
  if (head) {
    mstate.dragTask = Number(head.parentElement.dataset.task);
    head.parentElement.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', `task:${mstate.dragTask}`); } catch { /* Safari */ }
    return;
  }
  const row = e.target.closest('.mrow');
  if (!row) return;
  mstate.drag = Number(row.dataset.i);
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', row.dataset.i); } catch { /* Safari */ }
});
$('mList').addEventListener('dragend', () => {
  mstate.drag = -1;
  mstate.dragTask = -1;
  for (const r of document.querySelectorAll('.mrow, .mtask-card')) r.classList.remove('dragging', 'drop-before', 'drop-after');
});
$('mList').addEventListener('dragover', (e) => {
  if (mstate.dragTask >= 0) {
    e.preventDefault();
    const card = e.target.closest('.mtask-card');
    if (!card) return;
    for (const c of document.querySelectorAll('.mtask-card')) c.classList.remove('drop-before', 'drop-after');
    card.classList.add(Number(card.dataset.task) < mstate.dragTask ? 'drop-before' : 'drop-after');
    return;
  }
  if (mstate.drag < 0) return;
  e.preventDefault();
  const row = e.target.closest('.mrow');
  if (!row) return;
  for (const r of document.querySelectorAll('.mrow')) r.classList.remove('drop-before', 'drop-after');
  row.classList.add(Number(row.dataset.i) < mstate.drag ? 'drop-before' : 'drop-after');
});
$('mList').addEventListener('drop', (e) => {
  if (mstate.dragTask >= 0) {
    e.preventDefault();
    const card = e.target.closest('.mtask-card');
    const from = mstate.dragTask;
    const to = card ? Number(card.dataset.task) : -1;
    mstate.dragTask = -1;
    for (const c of document.querySelectorAll('.mtask-card')) c.classList.remove('dragging', 'drop-before', 'drop-after');
    if (to >= 0) mMoveTask(from, to);
    return;
  }
  if (mstate.drag < 0) return;
  e.preventDefault();
  const row = e.target.closest('.mrow');
  const from = mstate.drag;
  mstate.drag = -1;
  for (const r of document.querySelectorAll('.mrow')) r.classList.remove('dragging', 'drop-before', 'drop-after');
  if (!row) return;
  mMove(from, Number(row.dataset.i));
});

mUpdateMergePaste();
mRender();
if (location.hash === '#merge') switchView('merge', { hash: false });
