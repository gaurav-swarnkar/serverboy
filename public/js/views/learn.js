// Learn → Tutorials: chapters about every part of Serverboy (content in ../tutorials.js).
//   #/learn            all chapters
//   #/learn/<chapter>  one chapter, with buttons that open the pages it talks about
import { esc } from '../ui.js';
import { icon } from '../icons.js';
import { CHAPTERS } from '../tutorials.js';

const DONE_KEY = 'sb-learn-done';
const done = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]'));
  } catch {
    return new Set();
  }
};
function setDone(id, on) {
  const d = done();
  if (on) d.add(id);
  else d.delete(id);
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...d]));
  } catch {
    /* private mode: progress is not remembered */
  }
}

// The server whose pages the buttons open: the one you used last, else the first.
function serverFor(servers) {
  let last = null;
  try {
    last = localStorage.getItem('sb-last-server');
  } catch {
    last = null;
  }
  return servers.find((s) => s.id === last) || servers[0] || null;
}

function hrefFor(target, server) {
  if (target.startsWith('learn:')) return `#/learn/${target.slice(6)}`;
  if (target === 'servers') return '#/servers';
  if (target.startsWith('admin-')) return `#/admin/${target.slice(6)}`;
  return server ? `#/s/${server.id}/${target}` : null;
}

function button(target, label, server, primary = false) {
  const href = hrefFor(target, server);
  if (!href) return `<span class="small muted">(${esc(label)}: add a server first)</span>`;
  return `<a class="btn btn-sm ${primary ? 'btn-primary' : ''}" href="${href}">${esc(label)} ${icon('arrow', 13)}</a>`;
}

// Chapter text is written by us (trusted HTML); [[page|Label]] becomes a button.
const rich = (html, server) => String(html).replace(/\[\[([a-z:-]+)\|([^\]]+)\]\]/g, (m, t, l) => button(t, l, server));

function section(s, server) {
  const parts = [];
  if (s.h) parts.push(`<h2>${esc(s.h)}</h2>`);
  if (s.p) parts.push(`<p>${rich(s.p, server)}</p>`);
  if (s.list) parts.push(`<ul class="learn-list">${s.list.map((x) => `<li>${rich(x, server)}</li>`).join('')}</ul>`);
  if (s.steps) parts.push(`<ol class="learn-steps">${s.steps.map((x, i) => `<li><span class="learn-n">${i + 1}</span><div>${rich(x, server)}</div></li>`).join('')}</ol>`);
  if (s.code) parts.push(`<pre class="log learn-code">${esc(s.code)}</pre>`);
  if (s.tip) parts.push(`<div class="notice learn-note">💡 ${rich(s.tip, server)}</div>`);
  if (s.warn) parts.push(`<div class="notice warn learn-note">⚠ ${rich(s.warn, server)}</div>`);
  if (s.faq) parts.push(`<div class="learn-faq">${s.faq.map(([q, a]) => `<details><summary>${q}</summary><p>${rich(a, server)}</p></details>`).join('')}</div>`);
  if (s.link) {
    const [t, l] = s.link.split('|');
    parts.push(`<div class="row learn-link">${button(t, l, server, true)}</div>`);
  }
  return `<section class="learn-section">${parts.join('')}</section>`;
}

const meta = (c) => `<span class="badge ${c.detailed ? 'ok' : ''}">${c.detailed ? 'Step by step' : 'Basics'}</span> <span class="small muted" style="white-space:nowrap">${c.minutes} min</span>`;

function renderIndex(el) {
  const d = done();
  const main = CHAPTERS.filter((c) => c.detailed);
  el.innerHTML = `
    <div class="page-head"><div><h1>Tutorials</h1><div class="sub">Learn Serverboy step by step, in plain words. No server experience needed.</div></div></div>
    <div class="card learn-path">
      <h3 style="margin-top:0">Start here</h3>
      <p class="small muted" style="margin-top:0">Put a website online, keep its data in a database, then let the website use that data through an API.</p>
      <div class="learn-path-steps">${main
        .map((c, i) => `${i ? `<span class="learn-arrow">→</span>` : ''}<a class="learn-path-step ${d.has(c.id) ? 'done' : ''}" href="#/learn/${c.id}"><span class="learn-n">${d.has(c.id) ? '✓' : i + 1}</span><span><b>${esc(c.title)}</b><small>${esc(c.summary)}</small></span></a>`)
        .join('')}</div>
    </div>
    <h3>All chapters <span class="small muted">${d.size} of ${CHAPTERS.length} done</span></h3>
    <div class="learn-grid">${CHAPTERS.map(
      (c, i) => `<a class="card learn-card ${d.has(c.id) ? 'done' : ''}" href="#/learn/${c.id}">
        <div class="row"><span class="learn-ico">${icon(c.icon, 20)}</span><span class="small muted">Chapter ${i + 1}</span><span class="grow"></span>${d.has(c.id) ? '<span class="badge ok">✓ done</span>' : ''}</div>
        <b>${esc(c.title)}</b><span class="small muted">${esc(c.summary)}</span><div>${meta(c)}</div></a>`,
    ).join('')}</div>`;
}

function renderChapter(el, c, servers) {
  const server = serverFor(servers);
  const i = CHAPTERS.indexOf(c);
  const prev = CHAPTERS[i - 1];
  const next = CHAPTERS[i + 1];
  const draw = () => {
    const d = done();
    el.innerHTML = `
      <div class="learn-layout">
        <nav class="learn-toc card">
          <a href="#/learn" class="small">← All tutorials</a>
          ${CHAPTERS.map((x, n) => `<a href="#/learn/${x.id}" class="${x === c ? 'on' : ''}"><span class="learn-toc-n">${d.has(x.id) ? '✓' : n + 1}</span>${esc(x.title)}</a>`).join('')}
        </nav>
        <article class="learn-article card">
          <label class="learn-jump"><span class="small muted">Chapter</span><select>${CHAPTERS.map((x, n) => `<option value="${x.id}" ${x === c ? 'selected' : ''}>${n + 1}. ${esc(x.title)}${d.has(x.id) ? ' ✓' : ''}</option>`).join('')}</select></label>
          <div class="small muted learn-of">Chapter ${i + 1} of ${CHAPTERS.length}</div>
          <h1 class="learn-title"><span class="learn-ico">${icon(c.icon, 22)}</span>${esc(c.title)}</h1>
          <p class="learn-summary">${esc(c.summary)} ${meta(c)}</p>
          ${server || !c.view ? '' : '<div class="notice warn">Add a server on Home first: the buttons in this chapter open its pages.</div>'}
          ${c.sections.map((s) => section(s, server)).join('')}
          <div class="learn-foot">
            <button class="${d.has(c.id) ? '' : 'btn-primary'}" data-done>${d.has(c.id) ? '✓ Done (click to undo)' : 'Mark this chapter as done'}</button>
            <span class="grow"></span>
            ${prev ? `<a class="btn" href="#/learn/${prev.id}">‹ ${esc(prev.title)}</a>` : ''}
            ${next ? `<a class="btn" href="#/learn/${next.id}">${esc(next.title)} ›</a>` : ''}
          </div>
        </article>
      </div>`;
    el.querySelector('.learn-jump select').addEventListener('change', (e) => {
      location.hash = `#/learn/${e.target.value}`;
    });
    el.querySelector('[data-done]').addEventListener('click', () => {
      setDone(c.id, !done().has(c.id));
      draw();
    });
  };
  draw();
  el.closest('.main')?.scrollTo?.(0, 0);
  window.scrollTo(0, 0);
}

export async function render(el, { rest = [], servers = [] }) {
  const c = CHAPTERS.find((x) => x.id === rest[0]);
  if (c) renderChapter(el, c, servers);
  else renderIndex(el);
}
