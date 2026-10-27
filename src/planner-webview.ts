// The day planner's page: styles and script, inline because the page draws
// only what planner-view.ts posts. The script is plain browser JavaScript in a
// String.raw, so it avoids backticks and dollar-brace. The little arithmetic
// a drag needs while the pointer moves (snap, clampBlock, clock) is said again
// here from planner-model.ts; everything that decides the day is the model's.

const CSS = String.raw`
:root { color-scheme: light dark; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
  background: var(--vscode-editor-background); height: 100vh; display: flex; flex-direction: column; }
header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
header h1 { font-size: 1.1em; margin: 0 6px; font-weight: 600; }
select, input, button { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 3px 6px; }
button { cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
input:focus, select:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.spacer { flex: 1; }
.loadbar { width: 140px; height: 8px; border-radius: 4px; background: rgba(127,127,127,0.25); overflow: hidden; position: relative; }
.loadbar div { position: absolute; left: 0; top: 0; bottom: 0; background: var(--vscode-progressBar-background, #3e63dd); }
.loadbar div.full { background: #f5a524; }
#loadtext { font-size: 0.9em; }
#loadtext .free { color: #30a46c; }
#loadtext .warn { color: var(--vscode-errorForeground); font-weight: 600; }
#loadtext .dim { color: var(--vscode-descriptionForeground); }
.msg { padding: 6px 12px; display: none; gap: 8px; align-items: center; }
.msg.show { display: flex; }
.msg span { flex: 1; }
#error { background: var(--vscode-inputValidation-errorBackground); border-bottom: 1px solid var(--vscode-inputValidation-errorBorder); }
#notice { background: var(--vscode-inputValidation-infoBackground); border-bottom: 1px solid var(--vscode-inputValidation-infoBorder); }
#armed { padding: 4px 12px; color: var(--vscode-textLink-foreground); font-size: 0.9em; display: none; }
#armed.show { display: block; }
#allday { display: flex; gap: 4px; flex-wrap: wrap; padding: 6px 12px 0; }
.allday { border-left: 3px solid #57b986; background: rgba(87,185,134,0.1); border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 0.9em; font-weight: 600; }
.allday.deadline { border-color: #d32f2f; background: rgba(211,47,47,0.1); }
.allday.done { opacity: 0.55; text-decoration: line-through; }
main { flex: 1; display: flex; gap: 12px; padding: 8px 12px 12px; min-height: 0; }
#scroll { flex: 1; overflow-y: auto; overflow-x: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 4px; position: relative; min-width: 0; }
#grid { display: flex; height: 1440px; position: relative; }
#times { width: 52px; flex-shrink: 0; border-right: 1px solid var(--vscode-panel-border); position: relative; }
#times span { position: absolute; right: 6px; font-size: 10px; color: var(--vscode-descriptionForeground); transform: translateY(-50%); }
#times span.work { font-weight: 600; color: var(--vscode-foreground); }
#content { flex: 1; position: relative; }
#content.armed { cursor: copy; }
.off { position: absolute; left: 0; right: 0; background: rgba(127,127,127,0.12); pointer-events: none; }
.rule { position: absolute; left: 0; right: 0; height: 0; border-top: 1px solid var(--vscode-panel-border); pointer-events: none; }
.rule.half { border-top-style: dotted; opacity: 0.5; }
.now { position: absolute; left: 0; right: 0; border-top: 2px solid #e53935; z-index: 6; pointer-events: none; }
.now::before { content: ''; position: absolute; left: -5px; top: -6px; width: 10px; height: 10px; border-radius: 50%; background: #e53935; }
.block { position: absolute; box-sizing: border-box; border-radius: 6px; padding: 2px 6px; overflow: hidden; z-index: 3; user-select: none;
  border: 1px solid transparent; border-left: 4px solid var(--vscode-focusBorder); background: rgba(62,99,221,0.18); cursor: grab; touch-action: none;
  transition: top 120ms, height 120ms; }
.block.fixed { border-left-color: rgba(127,127,127,0.6); background: rgba(127,127,127,0.14); cursor: pointer;
  background-image: repeating-linear-gradient(135deg, transparent 0 8px, rgba(127,127,127,0.07) 8px 16px); }
.block.clash { border-color: var(--vscode-errorForeground); border-left-color: var(--vscode-errorForeground); }
.block.pending { opacity: 0.75; }
.block.done { opacity: 0.5; }
.block.done .t { text-decoration: line-through; }
.block.dragging { z-index: 8; transition: none; box-shadow: 0 2px 8px rgba(0,0,0,0.35); cursor: grabbing; }
.block.leaving { opacity: 0.35; }
.block:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
.block .row { display: flex; gap: 4px; align-items: flex-start; }
.block .t { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; line-height: 1.25; overflow: hidden; }
.block.short .t { white-space: nowrap; text-overflow: ellipsis; }
.block .kw { font-size: 9.5px; font-weight: 700; margin-right: 4px; color: var(--vscode-descriptionForeground); }
.block .sub { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.block .x { opacity: 0; background: none; padding: 0 3px; line-height: 14px; }
.block:hover .x { opacity: 1; }
.block .grip { position: absolute; left: 0; right: 0; bottom: 0; height: 7px; cursor: ns-resize; }
.block .grip:hover { background: rgba(62,99,221,0.4); }
.deadline-line { position: absolute; left: 0; right: 0; border-top: 2px dashed var(--vscode-errorForeground); z-index: 4; cursor: pointer; }
.deadline-line span { position: absolute; right: 4px; top: -16px; font-size: 10px; font-weight: 600; color: var(--vscode-errorForeground);
  background: var(--vscode-editor-background); padding: 0 4px; border-radius: 4px; }
.ghost { position: absolute; left: 2px; right: 2px; border: 2px dashed var(--vscode-focusBorder); border-radius: 6px; background: rgba(62,99,221,0.12);
  z-index: 7; pointer-events: none; padding: 1px 6px; font-size: 11px; font-weight: 600; }
#list { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; border: 1px solid var(--vscode-panel-border); border-radius: 4px; min-height: 0; }
#list.dropping { outline: 2px dashed var(--vscode-focusBorder); background: rgba(62,99,221,0.08); }
#list .head { padding: 8px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
#list .head .count { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
#tasks { flex: 1; overflow-y: auto; }
.task { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); cursor: grab; display: flex; gap: 6px; align-items: flex-start; }
.task:hover { background: var(--vscode-list-hoverBackground); }
.task.armed { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.task .body { flex: 1; min-width: 0; }
.task .h { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.task .meta { font-size: 10.5px; color: var(--vscode-descriptionForeground); display: flex; gap: 6px; flex-wrap: wrap; }
.task .meta .late { color: var(--vscode-errorForeground); font-weight: 600; }
.task .go { padding: 0 6px; }
.empty { padding: 16px; color: var(--vscode-descriptionForeground); }
`;

const SCRIPT = String.raw`
(function () {
  const vscode = acquireVsCodeApi();
  const $ = function (id) { return document.getElementById(id); };
  const SNAP = 15, DAY = 1440;
  let s = null;            // the last day posted
  let armed = null;        // a task picked in the list, placed by a click on an hour
  let dragTask = null;     // a task being dragged in from the list
  let drag = null;         // a block being moved or resized
  let shownDate = '';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function clock(m) {
    const v = Math.max(0, Math.min(DAY, Math.round(m)));
    return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
  }
  function snap(m) { return Math.round(m / SNAP) * SNAP; }
  function clampBlock(start, len) {
    const l = Math.max(SNAP, len);
    let st = Math.max(0, start);
    if (st + l > DAY - 1) st = Math.max(0, DAY - 1 - l);
    return { start: st, end: Math.min(DAY - 1, st + l) };
  }
  function minuteAt(y) {
    const r = $('content').getBoundingClientRect();
    return Math.max(0, Math.min(DAY - 1, y - r.top));
  }
  function overList(x, y) {
    const r = $('list').getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  function edgeScroll(y) {
    const sc = $('scroll'), r = sc.getBoundingClientRect();
    if (y < r.top + 28) sc.scrollTop -= 12; else if (y > r.bottom - 28) sc.scrollTop += 12;
  }
  function taskOf(hash) { return s ? s.tasks.find(function (t) { return t.hash === hash; }) : null; }

  function showGhost(start, end, label) {
    let g = $('ghost');
    if (!g) { g = el('div', 'ghost'); g.id = 'ghost'; $('content').appendChild(g); }
    g.style.top = (start + 1) + 'px';
    g.style.height = (end - start - 2) + 'px';
    g.textContent = clock(start) + '–' + clock(end) + ' · ' + label;
  }
  function hideGhost() { const g = $('ghost'); if (g) g.remove(); }

  function setArmed(hash) {
    armed = hash;
    const t = taskOf(hash);
    $('armed').textContent = t ? 'Click an hour to put “' + t.headline + '” there · First free slot to let it find one · Esc to cancel' : '';
    $('armed').classList.toggle('show', !!t);
    $('content').classList.toggle('armed', !!t);
    document.querySelectorAll('.task').forEach(function (n) { n.classList.toggle('armed', n.dataset.hash === hash); });
    if (!t) hideGhost();
  }

  // ── Header ──
  function renderHeader() {
    $('title').textContent = s.title;
    $('today').disabled = s.isToday;
    const ls = $('ds'), le = $('de');
    if (!ls.options.length) {
      for (let h = 0; h < 24; h++) { const o = el('option', '', clock(h * 60)); o.value = h; ls.appendChild(o); }
      for (let h = 1; h <= 24; h++) { const o = el('option', '', clock(h * 60)); o.value = h; le.appendChild(o); }
    }
    ls.value = String(Math.floor(s.start / 60));
    le.value = String(Math.floor(s.end / 60));
    const bar = $('loadbar').firstChild, lt = $('loadtext');
    lt.innerHTML = '';
    if (s.load) {
      const pct = Math.min(100, s.load.PlannedMins / Math.max(1, s.load.WindowMins) * 100);
      bar.style.width = pct + '%';
      bar.className = pct >= 100 ? 'full' : '';
      $('loadbar').title = s.loadText.planned + ' planned of ' + s.loadText.window;
      lt.appendChild(el('b', '', s.loadText.planned + ' planned'));
      lt.appendChild(el('span', 'dim', ' of ' + s.loadText.window + ' · '));
      lt.appendChild(el('span', s.load.FreeMins > 0 ? 'free' : 'warn', s.loadText.free + ' free'));
      if (s.loadText.double) lt.appendChild(el('span', 'warn', ' · ⚠ ' + s.loadText.double + ' double-booked'));
      if (s.loadText.outside) lt.appendChild(el('span', 'dim', ' · ' + s.loadText.outside + ' outside hours'));
      if (s.loadText.backlog) {
        const over = s.load.PlannedMins + s.load.BacklogMins > s.load.WindowMins;
        lt.appendChild(el('span', over ? 'warn' : 'dim', ' · ' + s.loadText.backlog + ' waiting' + (over ? ' (more than is free)' : '')));
      }
    } else {
      bar.style.width = '0';
    }
    $('spin').textContent = s.loading ? 'Loading…' : '';
    $('errtext').textContent = s.error;
    $('error').classList.toggle('show', !!s.error);
    $('notetext').textContent = s.notice;
    $('notice').classList.toggle('show', !!s.notice);
    const ad = $('allday');
    ad.innerHTML = '';
    s.allDay.forEach(function (b) {
      const c = el('div', 'allday' + (b.kind === 'deadline' ? ' deadline' : '') + (b.done ? ' done' : ''), (b.kind === 'deadline' ? '⚑ ' : '') + b.headline + b.note);
      c.addEventListener('click', function () { vscode.postMessage({ command: 'open', hash: b.hash }); });
      ad.appendChild(c);
    });
  }

  // ── The grid ──
  function renderGrid() {
    const times = $('times'), content = $('content');
    if (!times.childNodes.length) {
      for (let h = 0; h < 24; h++) { const t = el('span', '', clock(h * 60)); t.style.top = (h * 60) + 'px'; if (h === 0) t.style.transform = 'none'; times.appendChild(t); }
    }
    times.childNodes.forEach(function (t, h) { t.classList.toggle('work', h * 60 >= s.start && h * 60 < s.end); });
    content.innerHTML = '';
    const before = el('div', 'off'); before.style.top = '0'; before.style.height = s.start + 'px'; content.appendChild(before);
    const after = el('div', 'off'); after.style.top = s.end + 'px'; after.style.bottom = '0'; content.appendChild(after);
    for (let i = 0; i < 48; i++) { const r = el('div', 'rule' + (i % 2 ? ' half' : '')); r.style.top = (i * 30) + 'px'; content.appendChild(r); }
    if (s.isToday) { const n = el('div', 'now'); n.style.top = s.nowMin + 'px'; content.appendChild(n); }
    s.blocks.forEach(function (b) { content.appendChild(b.kind === 'deadline' || b.end <= b.start ? deadlineEl(b) : blockEl(b)); });
    if (shownDate !== s.date) {
      shownDate = s.date;
      let top = s.start - 30;
      if (s.isToday) top = Math.max(top, s.nowMin - 120);
      $('scroll').scrollTop = Math.max(0, top);
    }
  }

  function deadlineEl(b) {
    const d = el('div', 'deadline-line');
    d.style.top = (b.start - 1) + 'px';
    d.title = 'Deadline ' + b.startText + ': ' + b.headline;
    d.appendChild(el('span', '', '⚑ ' + b.startText + ' ' + b.headline));
    d.addEventListener('click', function () { vscode.postMessage({ command: 'open', hash: b.hash }); });
    return d;
  }

  function place(b, top, end) {
    b.style.top = (top + 1) + 'px';
    b.style.height = Math.max(18, end - top - 2) + 'px';
  }

  function blockEl(b) {
    const short = b.mins < 40;
    const d = el('div', 'block' + (b.movable ? '' : ' fixed') + (b.clash ? ' clash' : '') + (b.pending ? ' pending' : '') + (b.done ? ' done' : '') + (short ? ' short' : ''));
    d.tabIndex = 0;
    d.dataset.hash = b.hash;
    const w = 100 / b.lanes;
    d.style.left = 'calc(' + (b.lane * w) + '% + 2px)';
    d.style.width = 'calc(' + w + '% - 4px)';
    place(d, b.start, b.end);
    d.title = b.headline + ', ' + b.startText + '–' + b.endText + (b.movable ? '\nDrag to move, drag the bottom edge to resize, drag onto the list to unplan.\nArrows move, shift+arrows resize, Delete unplans, Enter opens.' : '\nClick to open');
    const row = el('div', 'row');
    const t = el('div', 't');
    if (b.status) t.appendChild(el('span', 'kw', b.status));
    t.appendChild(document.createTextNode(b.headline));
    if (short) t.appendChild(el('span', 'sub', '  ' + b.startText));
    row.appendChild(t);
    if (b.clash) row.appendChild(el('span', '', '⚠'));
    if (b.repeater) { const r = el('span', 'sub', '↻'); r.title = 'Repeats ' + b.repeater; row.appendChild(r); }
    if (b.movable) {
      const x = el('button', 'x', '×');
      x.title = 'Take it off the day (Delete)';
      x.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      x.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ command: 'unplan', hash: b.hash }); });
      row.appendChild(x);
    }
    d.appendChild(row);
    if (!short) d.appendChild(el('div', 'sub', b.startText + '–' + b.endText + ' · ' + b.lengthText + (b.implied ? ' (no end written)' : '') + (b.kind === 'timestamp' ? ' · appointment' : '')));
    if (!b.movable) {
      d.addEventListener('click', function () { vscode.postMessage({ command: 'open', hash: b.hash }); });
      d.addEventListener('keydown', function (e) { if (e.key === 'Enter') vscode.postMessage({ command: 'open', hash: b.hash }); });
      return d;
    }
    const grip = el('div', 'grip');
    grip.title = 'Drag to change how long';
    d.appendChild(grip);
    const begin = function (e, kind) {
      if (e.button !== 0 || b.pending) return;
      e.stopPropagation();
      d.setPointerCapture(e.pointerId);
      drag = { kind: kind, b: b, el: d, id: e.pointerId, y: e.clientY, grab: minuteAt(e.clientY), start: b.start, end: b.end, moved: false, over: false };
    };
    d.addEventListener('pointerdown', function (e) { begin(e, 'move'); });
    grip.addEventListener('pointerdown', function (e) { begin(e, 'resize'); });
    d.addEventListener('pointermove', function (e) {
      if (!drag || drag.id !== e.pointerId) return;
      if (!drag.moved && Math.abs(e.clientY - drag.y) <= 4) return;
      if (!drag.moved) { drag.moved = true; d.classList.add('dragging'); vscode.postMessage({ command: 'dragging', on: true }); }
      edgeScroll(e.clientY);
      const delta = minuteAt(e.clientY) - drag.grab;
      if (drag.kind === 'move') {
        const c = clampBlock(snap(b.start + delta), b.end - b.start);
        drag.start = c.start; drag.end = c.end;
        drag.over = overList(e.clientX, e.clientY);
      } else {
        drag.end = Math.min(DAY - 1, Math.max(b.start + SNAP, snap(b.end + delta)));
      }
      place(d, drag.start, drag.end);
      d.classList.toggle('leaving', drag.over);
      $('list').classList.toggle('dropping', drag.over);
      const sub = d.querySelector('.sub');
      if (sub && !short) sub.textContent = clock(drag.start) + '–' + clock(drag.end);
    });
    const end = function (e, cancel) {
      if (!drag || drag.id !== e.pointerId) return;
      const g = drag;
      drag = null;
      $('list').classList.remove('dropping');
      vscode.postMessage({ command: 'dragging', on: false });
      if (cancel) { render(); return; }
      if (!g.moved) { vscode.postMessage({ command: 'open', hash: b.hash }); return; }
      if (g.over) vscode.postMessage({ command: 'unplan', hash: b.hash });
      else if (g.start !== b.start || g.end !== b.end) vscode.postMessage({ command: 'place', hash: b.hash, start: g.start, end: g.end });
      else render();
    };
    d.addEventListener('pointerup', function (e) { end(e, false); });
    d.addEventListener('pointercancel', function (e) { end(e, true); });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); vscode.postMessage({ command: 'open', hash: b.hash }); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = e.key === 'ArrowUp' ? -SNAP : SNAP;
        let st = b.start, en = b.end;
        if (e.shiftKey) en = Math.min(DAY - 1, Math.max(st + SNAP, en + step));
        else { const c = clampBlock(st + step, en - st); st = c.start; en = c.end; }
        refocus = b.hash;
        vscode.postMessage({ command: 'place', hash: b.hash, start: st, end: en });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        vscode.postMessage({ command: 'unplan', hash: b.hash });
      }
    });
    return d;
  }
  let refocus = null;

  // ── The list ──
  function renderList() {
    $('count').textContent = s.tasks.length === s.taskCount ? s.taskCount + ' to place' : s.tasks.length + ' of ' + s.taskCount + ' to place';
    const list = $('tasks');
    const top = list.scrollTop;
    list.innerHTML = '';
    if (s.tasks.length === 0) list.appendChild(el('div', 'empty', s.loading ? '' : 'Nothing left to place.'));
    s.tasks.forEach(function (t) {
      const r = el('div', 'task' + (armed === t.hash ? ' armed' : ''));
      r.draggable = true;
      r.dataset.hash = t.hash;
      r.title = t.headline + '\nDrag onto an hour, or click and then click an hour. Double-click to open.';
      const body = el('div', 'body');
      body.appendChild(el('div', 'h', (t.priority ? '[#' + t.priority + '] ' : '') + t.headline));
      const meta = el('div', 'meta');
      if (t.status) meta.appendChild(el('span', '', t.status));
      const est = el('span', '', t.effort || t.lenText + '?');
      est.title = t.effort ? 'EFFORT' : 'No EFFORT: placed as ' + t.lenText;
      meta.appendChild(est);
      if (t.note) meta.appendChild(el('span', t.late ? 'late' : '', t.note));
      meta.appendChild(el('span', '', t.file));
      if (t.tags.length) meta.appendChild(el('span', '', ':' + t.tags.join(':') + ':'));
      body.appendChild(meta);
      r.appendChild(body);
      const go = el('button', 'go', '⇥');
      go.title = 'Put it in the first free slot';
      go.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ command: 'next', hash: t.hash }); });
      r.appendChild(go);
      r.addEventListener('click', function () { setArmed(armed === t.hash ? null : t.hash); });
      r.addEventListener('dblclick', function () { vscode.postMessage({ command: 'open', hash: t.hash }); });
      r.addEventListener('dragstart', function (e) {
        dragTask = t;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-orgs-plan', t.hash);
        vscode.postMessage({ command: 'dragging', on: true });
      });
      r.addEventListener('dragend', function () {
        const was = dragTask;
        dragTask = null;
        hideGhost();
        vscode.postMessage({ command: 'dragging', on: false });
        if (was) render();
      });
      list.appendChild(r);
    });
    list.scrollTop = top;
  }

  function render() {
    if (!s) return;
    renderHeader();
    renderGrid();
    renderList();
    if (armed && !taskOf(armed)) setArmed(null);
    if (refocus) {
      const n = document.querySelector('.block[data-hash="' + CSS.escape(refocus) + '"]');
      refocus = null;
      if (n) n.focus();
    }
  }

  // ── Dropping on the grid ──
  const content = $('content');
  content.addEventListener('dragover', function (e) {
    if (!dragTask) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    edgeScroll(e.clientY);
    const c = clampBlock(Math.floor(minuteAt(e.clientY) / SNAP) * SNAP, dragTask.len);
    showGhost(c.start, c.end, dragTask.headline);
  });
  content.addEventListener('dragleave', function (e) { if (e.target === content) hideGhost(); });
  content.addEventListener('drop', function (e) {
    e.preventDefault();
    const t = dragTask;
    dragTask = null;
    hideGhost();
    if (!t) return;
    const c = clampBlock(Math.floor(minuteAt(e.clientY) / SNAP) * SNAP, t.len);
    vscode.postMessage({ command: 'place', hash: t.hash, start: c.start, end: c.end });
  });
  content.addEventListener('mousemove', function (e) {
    if (!armed || dragTask || drag) return;
    const t = taskOf(armed);
    if (!t) return;
    const c = clampBlock(Math.floor(minuteAt(e.clientY) / SNAP) * SNAP, t.len);
    showGhost(c.start, c.end, t.headline);
  });
  content.addEventListener('mouseleave', function () { if (!dragTask) hideGhost(); });
  content.addEventListener('click', function (e) {
    if (!armed || e.target.closest('.block, .deadline-line')) return;
    const t = taskOf(armed);
    if (!t) return;
    const c = clampBlock(Math.floor(minuteAt(e.clientY) / SNAP) * SNAP, t.len);
    vscode.postMessage({ command: 'place', hash: t.hash, start: c.start, end: c.end });
    setArmed(null);
  });

  window.addEventListener('message', function (ev) {
    if (ev.data.command !== 'day') return;
    s = ev.data;
    // Redrawing under a drag would pull the dragged element out from under
    // the pointer; the day is drawn when the drag ends.
    if (drag || dragTask) return;
    render();
  });
  $('prev').addEventListener('click', function () { vscode.postMessage({ command: 'day', delta: -1 }); });
  $('next').addEventListener('click', function () { vscode.postMessage({ command: 'day', delta: 1 }); });
  $('today').addEventListener('click', function () { vscode.postMessage({ command: 'day', delta: 0 }); });
  $('refresh').addEventListener('click', function () { vscode.postMessage({ command: 'refresh' }); });
  $('free').addEventListener('click', function () { vscode.postMessage({ command: 'next', hash: armed || undefined }); setArmed(null); });
  $('errx').addEventListener('click', function () { vscode.postMessage({ command: 'dismiss' }); });
  $('notex').addEventListener('click', function () { vscode.postMessage({ command: 'dismiss' }); });
  const win = function () {
    const a = +$('ds').value * 60, b = +$('de').value * 60;
    if (b > a) vscode.postMessage({ command: 'window', start: a, end: b });
    else if (s) { $('ds').value = String(Math.floor(s.start / 60)); $('de').value = String(Math.floor(s.end / 60)); }
  };
  $('ds').addEventListener('change', win);
  $('de').addEventListener('change', win);
  $('filter').addEventListener('input', function (e) { vscode.postMessage({ command: 'filter', text: e.target.value }); });
  window.addEventListener('keydown', function (e) {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (e.key === 'Escape') { setArmed(null); if (typing) e.target.blur(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); $('filter').focus(); }
    else if (e.key === 'Enter' && armed) { vscode.postMessage({ command: 'next', hash: armed }); setArmed(null); }
  });
  // Dropping a block on the list is done by the pointer handlers; this only
  // keeps the browser from treating a stray drop there as a navigation.
  $('list').addEventListener('dragover', function (e) { if (dragTask) e.preventDefault(); });
  vscode.postMessage({ command: 'ready' });
})();
`;

export function plannerHtml(nonce: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${CSS}</style></head>
<body><header>
<button id="prev" title="The day before">◀</button>
<button id="today">Today</button>
<button id="next" title="The day after">▶</button>
<h1 id="title"></h1>
<div class="loadbar" id="loadbar"><div></div></div>
<span id="loadtext"></span>
<span class="spacer"></span>
<span id="spin"></span>
<span title="The working day: what free and planned are counted in"><select id="ds" aria-label="Working day starts"></select> – <select id="de" aria-label="Working day ends"></select></span>
<button id="free" class="primary" title="Put the picked task (or the first on the list) in the first free slot long enough">First free slot</button>
<button id="refresh" title="Read the day again">Refresh</button>
</header>
<div id="error" class="msg" role="alert"><span id="errtext"></span><button id="errx" title="Dismiss">×</button></div>
<div id="notice" class="msg" role="status"><span id="notetext"></span><button id="notex" title="Dismiss">×</button></div>
<div id="armed"></div>
<div id="allday"></div>
<main>
<div id="scroll"><div id="grid"><div id="times"></div><div id="content"></div></div></div>
<aside id="list"><div class="head"><input id="filter" type="search" placeholder="Filter tasks (/)" aria-label="Filter tasks"><span class="count" id="count"></span></div>
<div id="tasks"></div></aside>
</main>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
