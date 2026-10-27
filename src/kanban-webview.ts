// The kanban board's page: styles and script, inline because the page is
// drawn from data the extension posts (see kanban-view.ts) and has nothing
// else to load. The script is plain browser JavaScript in a String.raw, so it
// avoids backticks and dollar-brace.

const CSS = String.raw`
:root { color-scheme: light dark; }
body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); background: var(--vscode-editor-background); height: 100vh; display: flex; flex-direction: column; }
header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
select, input, button { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 3px 6px; }
button { cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
input:focus, select:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#filter { min-width: 180px; flex: 0 1 260px; }
#status { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-left: auto; }
#message { padding: 6px 12px; background: var(--vscode-inputValidation-warningBackground); border-bottom: 1px solid var(--vscode-inputValidation-warningBorder); display: none; }
#message.show { display: block; }
#board { flex: 1; display: flex; gap: 10px; padding: 10px 12px; overflow-x: auto; overflow-y: hidden; align-items: stretch; }
.col { flex: 0 0 272px; display: flex; flex-direction: column; background: var(--vscode-sideBar-background, rgba(127,127,127,0.06));
  border: 1px solid var(--vscode-panel-border); border-radius: 6px; min-height: 0; }
.col.folded { flex: 0 0 34px; cursor: pointer; }
.col.folded .cards, .col.folded .count-limit { display: none; }
.col.folded .colhead { writing-mode: vertical-rl; height: 100%; padding: 8px 6px; }
.colhead { display: flex; align-items: center; gap: 6px; padding: 8px 10px; font-weight: 600; border-top: 3px solid var(--colc); border-radius: 6px 6px 0 0; }
.colhead .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.colhead .count { font-weight: 400; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.colhead .count.over { color: var(--vscode-errorForeground); font-weight: 600; }
.colhead .fold { background: none; padding: 0 4px; color: var(--vscode-descriptionForeground); }
.cards { flex: 1; overflow-y: auto; padding: 6px 8px 12px; display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
.col.dropping .cards { background: var(--vscode-list-dropBackground, rgba(127,127,127,0.12)); }
.col.refused.dropping .cards { background: none; outline: 1px dashed var(--vscode-errorForeground); }
.drop-line { height: 3px; background: var(--vscode-focusBorder); border-radius: 2px; margin: -5px 0; }
.card { position: relative; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px;
  overflow: hidden; cursor: grab; user-select: none; }
.card:hover { border-color: var(--vscode-focusBorder); }
.card:focus { outline: 1px solid var(--vscode-focusBorder); }
.card.dragging { opacity: 0.4; }
.card.hidden { display: none; }
.card .bar { height: 4px; }
.card .stripe { position: absolute; left: 0; top: 4px; bottom: 0; width: 4px; }
.card .inner { padding: 8px 10px 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.labels { display: flex; gap: 4px; flex-wrap: wrap; }
.labels span { height: 6px; min-width: 30px; flex: 0 1 44px; border-radius: 3px; }
.headline { display: flex; gap: 6px; align-items: flex-start; line-height: 1.35; }
.headline .text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pri { flex-shrink: 0; margin-top: 2px; padding: 0 4px; border-radius: 3px; font-size: 10px; font-weight: 700; line-height: 16px; color: #fff; }
.chips { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; font-size: 10.5px; }
.chip { padding: 0 5px; border-radius: 3px; line-height: 16px; border: 1px solid var(--vscode-panel-border); }
.chip.tag { border: none; color: var(--vscode-descriptionForeground); }
.chip.check.done { color: #30a46c; border-color: #30a46c; }
.foot { display: flex; gap: 8px; align-items: center; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.foot .late { color: var(--vscode-errorForeground); font-weight: 600; }
.foot .file { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; }
.empty { color: var(--vscode-descriptionForeground); padding: 24px; }
`;

const SCRIPT = String.raw`
(function () {
  const vscode = acquireVsCodeApi();
  const $ = function (id) { return document.getElementById(id); };
  let state = null;
  let drag = null;      // { hash, from }
  let stale = false;    // a board arrived mid-drag and is drawn when it ends
  let filterText = (vscode.getState() || {}).filter || '';
  $('filter').value = filterText;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function terms() { return filterText.toLowerCase().split(/\s+/).filter(function (t) { return t !== ''; }); }

  function matches(card, ts) {
    for (let i = 0; i < ts.length; i++) if (card.hay.indexOf(ts[i]) < 0) return false;
    return true;
  }

  function checkChip(c) {
    const chip = el('span', 'chip check' + (c.done === c.total ? ' done' : ''), '☑ ' + c.done + '/' + c.total);
    chip.title = c.done + ' of ' + c.total + ' checklist items done';
    return chip;
  }

  function cardEl(card, col) {
    const d = el('div', 'card');
    d.tabIndex = 0;
    d.draggable = true;
    d.dataset.hash = card.hash;
    d.title = card.headline + '\n' + card.path + '\nDouble-click to open';
    const bar = el('div', 'bar'); bar.style.background = card.header; d.appendChild(bar);
    if (card.stripe) { const s = el('div', 'stripe'); s.style.background = card.stripe; d.appendChild(s); }
    const inner = el('div', 'inner');
    if (card.labels.length) {
      const ls = el('div', 'labels');
      card.labels.forEach(function (l) { const s = el('span'); s.style.background = l.color; s.title = l.v; ls.appendChild(s); });
      inner.appendChild(ls);
    }
    const h = el('div', 'headline');
    if (card.priority) { const p = el('span', 'pri', card.priority); p.style.background = card.priorityColor; h.appendChild(p); }
    h.appendChild(el('span', 'text', card.headline));
    inner.appendChild(h);
    const chips = el('div', 'chips');
    chips.dataset.chips = '1';
    if (card.check) chips.appendChild(checkChip({ done: card.check[0], total: card.check[1] }));
    if (card.status) chips.appendChild(el('span', 'chip', card.status));
    if (card.assignee) { const a = el('span', 'chip', '@' + card.assignee); a.title = 'Assigned to ' + card.assignee; chips.appendChild(a); }
    card.badges.forEach(function (b) { const c = el('span', 'chip', b.v); c.title = b.n + ': ' + b.v; chips.appendChild(c); });
    card.tags.forEach(function (t) { const c = el('span', 'chip tag', t.t); c.style.background = t.color + '2e'; chips.appendChild(c); });
    if (chips.childNodes.length) inner.appendChild(chips);
    const foot = el('div', 'foot');
    if (card.deadline) { const f = el('span', card.overdue ? 'late' : '', '⚑ ' + card.deadline); f.title = 'Deadline ' + card.deadlineFull; foot.appendChild(f); }
    if (card.scheduled) { const f = el('span', '', '◷ ' + card.scheduled); f.title = 'Scheduled ' + card.scheduledFull; foot.appendChild(f); }
    foot.appendChild(el('span', 'file', card.file));
    inner.appendChild(foot);
    d.appendChild(inner);

    d.addEventListener('dblclick', function () { vscode.postMessage({ command: 'open', hash: card.hash }); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Enter') vscode.postMessage({ command: 'open', hash: card.hash }); });
    d.addEventListener('dragstart', function (e) {
      drag = { hash: card.hash, from: col.value };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.headline);
      setTimeout(function () { d.classList.add('dragging'); }, 0);
    });
    d.addEventListener('dragend', clearDrag);
    return d;
  }

  function clearDrag() {
    drag = null;
    if (stale) { stale = false; render(); return; }
    document.querySelectorAll('.dragging').forEach(function (n) { n.classList.remove('dragging'); });
    document.querySelectorAll('.dropping').forEach(function (n) { n.classList.remove('dropping'); });
    document.querySelectorAll('.drop-line').forEach(function (n) { n.remove(); });
  }

  // Where among the column's shown cards the pointer is: the index in the
  // column's own order, counting the cards a filter is hiding.
  function dropIndex(list, y) {
    const all = Array.prototype.slice.call(list.querySelectorAll('.card'));
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      if (c.classList.contains('hidden') || (drag && c.dataset.hash === drag.hash)) continue;
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { index: i, before: c };
    }
    return { index: all.length, before: null };
  }

  function colEl(col) {
    const c = el('div', 'col' + (col.collapsed ? ' folded' : '') + (col.refused ? ' refused' : ''));
    c.style.setProperty('--colc', col.color);
    const head = el('div', 'colhead');
    head.appendChild(el('span', 'title', col.title || '(none)'));
    const over = col.limit > 0 && col.cards.length > col.limit;
    const count = el('span', 'count' + (over ? ' over' : ''), col.limit > 0 ? col.cards.length + '/' + col.limit : String(col.cards.length));
    head.appendChild(count);
    const fold = el('button', 'fold', col.collapsed ? '▸' : '◂');
    fold.title = col.collapsed ? 'Unfold' : 'Fold';
    fold.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ command: 'fold', value: col.value }); });
    head.appendChild(fold);
    c.appendChild(head);
    if (col.collapsed) c.addEventListener('click', function () { vscode.postMessage({ command: 'fold', value: col.value }); });
    const list = el('div', 'cards');
    col.cards.forEach(function (card) { list.appendChild(cardEl(card, col)); });
    c.appendChild(list);

    c.addEventListener('dragover', function (e) {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = col.refused ? 'none' : 'move';
      document.querySelectorAll('.dropping').forEach(function (n) { if (n !== c) n.classList.remove('dropping'); });
      c.classList.add('dropping');
      if (col.refused || col.collapsed) return;
      document.querySelectorAll('.drop-line').forEach(function (n) { n.remove(); });
      if (!state.manual && drag.from === col.value) return;
      const at = dropIndex(list, e.clientY);
      const line = el('div', 'drop-line');
      if (at.before) list.insertBefore(line, at.before); else list.appendChild(line);
    });
    c.addEventListener('dragleave', function (e) {
      if (!c.contains(e.relatedTarget)) { c.classList.remove('dropping'); c.querySelectorAll('.drop-line').forEach(function (n) { n.remove(); }); }
    });
    c.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!drag) return;
      const d = drag;
      const at = col.collapsed ? { index: col.cards.length } : dropIndex(list, e.clientY);
      // The index skips the dragged card, as the order arithmetic expects.
      let index = at.index;
      if (d.from === col.value) {
        const pos = col.cards.findIndex(function (k) { return k.hash === d.hash; });
        if (pos >= 0 && pos < index) index--;
      }
      clearDrag();
      vscode.postMessage({ command: 'move', hash: d.hash, from: d.from, to: col.value, index: index });
    });
    return c;
  }

  function applyFilter() {
    if (!state) return;
    const ts = terms();
    let shown = 0;
    const byHash = {};
    state.columns.forEach(function (col) { col.cards.forEach(function (k) { byHash[k.hash] = k; }); });
    document.querySelectorAll('.card').forEach(function (n) {
      const k = byHash[n.dataset.hash];
      const ok = !k || matches(k, ts);
      n.classList.toggle('hidden', !ok);
      if (ok) shown++;
    });
    let s = state.loading ? 'Loading… ' : '';
    s += ts.length ? shown + ' of ' + state.total + ' cards' : state.total + ' cards';
    if (state.homeless > 0) s += ' · ' + state.homeless + ' in no column';
    $('status').textContent = s;
  }

  function render() {
    const sel = $('pick');
    sel.innerHTML = '';
    state.boards.forEach(function (n) {
      const o = el('option', '', n); o.value = n; if (n === state.active) o.selected = true; sel.appendChild(o);
    });
    sel.title = state.saved ? 'The boards saved on the server' : 'No boards saved yet: showing every open todo';
    const m = $('message');
    m.textContent = state.message || '';
    m.classList.toggle('show', !!state.message);
    const board = $('board');
    const scroll = board.scrollLeft;
    const tops = {};
    board.querySelectorAll('.col').forEach(function (c, i) { const l = c.querySelector('.cards'); if (l) tops[i] = l.scrollTop; });
    board.innerHTML = '';
    if (state.columns.length === 0 && !state.loading) board.appendChild(el('div', 'empty', state.message ? '' : 'Nothing on this board.'));
    state.columns.forEach(function (col, i) {
      const c = colEl(col);
      board.appendChild(c);
      const l = c.querySelector('.cards');
      if (l && tops[i]) l.scrollTop = tops[i];
    });
    board.scrollLeft = scroll;
    applyFilter();
  }

  window.addEventListener('message', function (ev) {
    const m = ev.data;
    if (m.command === 'board') { state = m; if (drag) stale = true; else render(); }
    else if (m.command === 'check' && state) {
      state.columns.forEach(function (col) { col.cards.forEach(function (k) { if (k.hash === m.hash) k.check = [m.done, m.total]; }); });
      const n = document.querySelector('.card[data-hash="' + CSS.escape(m.hash) + '"]');
      if (!n) return;
      let chips = n.querySelector('[data-chips]');
      if (!chips) {
        chips = el('div', 'chips'); chips.dataset.chips = '1';
        n.querySelector('.inner').insertBefore(chips, n.querySelector('.foot'));
      }
      const old = chips.querySelector('.check');
      const fresh = checkChip(m);
      if (old) chips.replaceChild(fresh, old); else chips.insertBefore(fresh, chips.firstChild);
    }
  });

  $('pick').addEventListener('change', function (e) { vscode.postMessage({ command: 'pick', name: e.target.value }); });
  $('refresh').addEventListener('click', function () { vscode.postMessage({ command: 'refresh' }); });
  $('new').addEventListener('click', function () { vscode.postMessage({ command: 'newBoard' }); });
  $('filter').addEventListener('input', function (e) {
    filterText = e.target.value;
    vscode.setState({ filter: filterText });
    applyFilter();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== $('filter')) { e.preventDefault(); $('filter').focus(); }
    else if (e.key === 'Escape' && document.activeElement === $('filter')) { $('filter').value = ''; filterText = ''; vscode.setState({ filter: '' }); applyFilter(); }
  });
  vscode.postMessage({ command: 'ready' });
})();
`;

export function kanbanHtml(cspSource: string, nonce: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${CSS}</style></head>
<body><header>
<select id="pick" aria-label="Board"></select>
<button id="new" title="Make a new board on the server">New board</button>
<input id="filter" type="search" placeholder="Filter cards (/)" aria-label="Filter cards">
<button id="refresh" title="Run the board's query again">Refresh</button>
<span id="status"></span>
</header>
<div id="message" role="status"></div>
<main id="board"></main>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
