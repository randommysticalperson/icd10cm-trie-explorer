/**
 * ICD-10-CM Trie Explorer — app.js
 * jQuery-powered trie browser, search, code detail, addenda, and chapter stats.
 *
 * Data files:
 *   trie.json         — hierarchical trie (code -> node with children)
 *   flat.json         — flat array [{c,s,l,b,o}] for fast full-text search
 *   stats.json        — aggregate statistics
 *   addenda.json      — FY2026 adds/deletes/revisions
 *   chapter_stats.json — per-chapter code counts
 */

$(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════════════ */
  const State = {
    trie: null,
    flat: null,
    stats: null,
    addenda: null,
    chapterStats: null,
    newCodes: new Set(),      // codes added in FY2026
    deletedCodes: new Set(),  // codes deleted in FY2026
    searchMode: 'prefix',
    query: '',
    results: [],
    page: 0,
    pageSize: 50,
    selectedCode: null,
    activeChapter: null,
    searchDebounce: null,
    addendaFilter: 'all',
    addendaQuery: '',
    currentView: 'search',
  };

  /* ═══════════════════════════════════════════════════════════════════
     ICD-10-CM CHAPTER DEFINITIONS
  ═══════════════════════════════════════════════════════════════════ */
  const CHAPTERS = [
    { id: 'I',    label: 'I',    range: ['A00','B99'], title: 'Certain infectious and parasitic diseases' },
    { id: 'II',   label: 'II',   range: ['C00','D49'], title: 'Neoplasms' },
    { id: 'III',  label: 'III',  range: ['D50','D89'], title: 'Diseases of the blood and blood-forming organs' },
    { id: 'IV',   label: 'IV',   range: ['E00','E89'], title: 'Endocrine, nutritional and metabolic diseases' },
    { id: 'V',    label: 'V',    range: ['F01','F99'], title: 'Mental, Behavioral and Neurodevelopmental disorders' },
    { id: 'VI',   label: 'VI',   range: ['G00','G99'], title: 'Diseases of the nervous system' },
    { id: 'VII',  label: 'VII',  range: ['H00','H59'], title: 'Diseases of the eye and adnexa' },
    { id: 'VIII', label: 'VIII', range: ['H60','H95'], title: 'Diseases of the ear and mastoid process' },
    { id: 'IX',   label: 'IX',   range: ['I00','I99'], title: 'Diseases of the circulatory system' },
    { id: 'X',    label: 'X',    range: ['J00','J99'], title: 'Diseases of the respiratory system' },
    { id: 'XI',   label: 'XI',   range: ['K00','K95'], title: 'Diseases of the digestive system' },
    { id: 'XII',  label: 'XII',  range: ['L00','L99'], title: 'Diseases of the skin and subcutaneous tissue' },
    { id: 'XIII', label: 'XIII', range: ['M00','M99'], title: 'Diseases of the musculoskeletal system' },
    { id: 'XIV',  label: 'XIV',  range: ['N00','N99'], title: 'Diseases of the genitourinary system' },
    { id: 'XV',   label: 'XV',   range: ['O00','O9A'], title: 'Pregnancy, childbirth and the puerperium' },
    { id: 'XVI',  label: 'XVI',  range: ['P00','P96'], title: 'Certain conditions originating in the perinatal period' },
    { id: 'XVII', label: 'XVII', range: ['Q00','Q99'], title: 'Congenital malformations' },
    { id: 'XVIII',label: 'XVIII',range: ['R00','R99'], title: 'Symptoms, signs and abnormal clinical findings' },
    { id: 'XIX',  label: 'XIX',  range: ['S00','T88'], title: 'Injury, poisoning and certain other consequences' },
    { id: 'XX',   label: 'XX',   range: ['V00','Y99'], title: 'External causes of morbidity' },
    { id: 'XXI',  label: 'XXI',  range: ['Z00','Z99'], title: 'Factors influencing health status' },
    { id: 'XXII', label: 'XXII', range: ['U00','U85'], title: 'Codes for special purposes' },
  ];

  function getChapterForCode(code) {
    const cat = code.slice(0, 3).toUpperCase();
    for (const ch of CHAPTERS) {
      if (cat >= ch.range[0] && cat <= ch.range[1]) return ch;
    }
    return null;
  }

  /* ═══════════════════════════════════════════════════════════════════
     TRIE NAVIGATION HELPERS
  ═══════════════════════════════════════════════════════════════════ */
  function trieFind(code) {
    if (!State.trie) return null;
    code = code.toUpperCase();
    const cat = code.slice(0, 3);
    if (!State.trie[cat]) return null;

    const ancestors = [];
    let node = State.trie[cat];
    ancestors.push({ code: cat, short: node.short });

    if (code === cat) return { node, ancestors };

    for (let len = 4; len <= code.length; len++) {
      const prefix = code.slice(0, len);
      if (!node.children[prefix]) return null;
      node = node.children[prefix];
      ancestors.push({ code: prefix, short: node.short });
      if (prefix === code) return { node, ancestors };
    }
    return null;
  }

  function getChildren(node) {
    return Object.values(node.children || {}).sort((a, b) => a.order - b.order);
  }

  /* ═══════════════════════════════════════════════════════════════════
     SEARCH ENGINE
  ═══════════════════════════════════════════════════════════════════ */
  function searchPrefix(query) {
    if (!State.trie || !query) return [];
    query = query.toUpperCase().replace(/\./g, '');
    const results = [];

    function walk(nodeDict) {
      for (const [code, node] of Object.entries(nodeDict)) {
        if (code.startsWith(query)) {
          collectAll(node, results);
        } else if (query.startsWith(code)) {
          walk(node.children || {});
        }
      }
    }

    function collectAll(node, out) {
      out.push(node);
      for (const child of Object.values(node.children || {})) {
        collectAll(child, out);
      }
    }

    walk(State.trie);
    results.sort((a, b) => a.order - b.order);
    return results;
  }

  function searchFullText(query) {
    if (!State.flat || !query) return [];
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];

    const results = [];
    for (const rec of State.flat) {
      const haystack = (rec.c + ' ' + rec.s + ' ' + rec.l).toLowerCase();
      if (terms.every(t => haystack.includes(t))) {
        results.push({
          code: rec.c,
          short: rec.s,
          long: rec.l,
          billable: rec.b,
          order: rec.o,
          children: {},
        });
      }
    }
    return results;
  }

  function searchExact(query) {
    if (!query) return [];
    const found = trieFind(query.trim());
    return found ? [found.node] : [];
  }

  function runSearch(query) {
    const t0 = performance.now();
    let results = [];
    const q = query.trim();

    if (q.length === 0) {
      results = [];
    } else if (State.searchMode === 'prefix') {
      results = searchPrefix(q);
    } else if (State.searchMode === 'fulltext') {
      results = searchFullText(q);
    } else if (State.searchMode === 'exact') {
      results = searchExact(q);
    }

    const elapsed = (performance.now() - t0).toFixed(1);
    State.results = results;
    State.page = 0;
    renderResults(results, q, elapsed);
  }

  /* ═══════════════════════════════════════════════════════════════════
     HIGHLIGHT HELPER
  ═══════════════════════════════════════════════════════════════════ */
  function highlight(text, query) {
    if (!query || !text) return escHtml(text || '');
    const escaped = escHtml(text);
    const terms = query.trim().split(/\s+/).filter(Boolean);
    let result = escaped;
    for (const term of terms) {
      const re = new RegExp('(' + escRegex(escHtml(term)) + ')', 'gi');
      result = result.replace(re, '<mark>$1</mark>');
    }
    return result;
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ═══════════════════════════════════════════════════════════════════
     RENDER: RESULTS LIST
  ═══════════════════════════════════════════════════════════════════ */
  function renderResults(results, query, elapsed) {
    const $list = $('#resultsList');
    const $empty = $('#resultsEmpty');
    const $placeholder = $('#resultsPlaceholder');
    const $pagination = $('#pagination');
    const $meta = $('#searchResultCount');
    const $timing = $('#searchTiming');

    $list.empty();
    $placeholder.hide();

    if (!query) {
      $empty.hide();
      $placeholder.show();
      $pagination.hide();
      $meta.text('');
      $timing.text('');
      return;
    }

    if (results.length === 0) {
      $empty.show();
      $pagination.hide();
      $meta.text('No results');
      $timing.text(`${elapsed}ms`);
      return;
    }

    $empty.hide();

    const totalPages = Math.ceil(results.length / State.pageSize);
    const start = State.page * State.pageSize;
    const end = Math.min(start + State.pageSize, results.length);
    const pageItems = results.slice(start, end);

    $meta.text(`${results.length.toLocaleString()} result${results.length !== 1 ? 's' : ''}`);
    $timing.text(`${elapsed}ms`);

    const displayQuery = State.searchMode === 'prefix'
      ? query.toUpperCase().replace(/\./g, '')
      : query;

    pageItems.forEach(rec => {
      const isNew = State.newCodes.has(rec.code);
      const badgeClass = rec.billable ? 'badge-billable' : 'badge-header';
      const badgeText  = rec.billable ? 'Billable' : 'Header';
      const codeHl = State.searchMode === 'prefix'
        ? highlight(rec.code, displayQuery)
        : escHtml(rec.code);
      const descHl = State.searchMode !== 'prefix'
        ? highlight(rec.short, displayQuery)
        : escHtml(rec.short);

      const chapter = getChapterForCode(rec.code);
      const chapterLabel = chapter ? `Ch. ${escHtml(chapter.label)} &mdash; ${escHtml(chapter.title)}` : '&mdash;';
      const categoryCode = escHtml(rec.code.slice(0, 3));
      const codeLen = rec.code.length;

      const $item = $(`
        <li class="result-item result-flip-card" data-code="${escHtml(rec.code)}">
          <div class="result-flip-inner">
            <!-- FRONT: explore view -->
            <div class="result-face result-face-front">
              <span class="result-code">${codeHl}</span>
              <div class="result-desc-wrap">
                <div class="result-short">${descHl}</div>
                ${rec.long && rec.long !== rec.short
                  ? `<div class="result-long">${escHtml(rec.long)}</div>`
                  : ''}
              </div>
              <div class="result-badges">
                <span class="result-badge ${badgeClass}">${badgeText}</span>
                ${isNew ? '<span class="result-badge badge-new">NEW</span>' : ''}
              </div>
            </div>
            <!-- BACK: code view -->
            <div class="result-face result-face-back">
              <div class="result-back-code">${escHtml(rec.code)}</div>
              <div class="result-back-grid">
                <span class="result-back-label">Chapter</span>
                <span class="result-back-value">${chapterLabel}</span>
                <span class="result-back-label">Category</span>
                <span class="result-back-value mono">${categoryCode}</span>
                <span class="result-back-label">Type</span>
                <span class="result-back-value">${badgeText}${isNew ? ' &bull; <span class="badge-new-inline">NEW FY26</span>' : ''}</span>
                <span class="result-back-label">Length</span>
                <span class="result-back-value mono">${codeLen} char${codeLen !== 1 ? 's' : ''}</span>
              </div>
              <div class="result-back-trie">${escHtml(rec.code).split('').map((ch, i, arr) =>
                `<span class="tpn ${i === arr.length - 1 ? 'tpn-last' : ''}">${ch}</span>${i < arr.length - 1 ? '<span class="tpa">&rarr;</span>' : ''}`
              ).join('')}</div>
            </div>
          </div>
        </li>
      `);

      $item.on('mouseenter', function () {
        $(this).addClass('flipped');
      }).on('mouseleave', function () {
        $(this).removeClass('flipped');
      });

      $item.on('click', function () {
        const code = $(this).data('code');
        $('.result-item').removeClass('active');
        $(this).addClass('active');
        showCodeDetail(code);
      });

      $list.append($item);
    });

    if (totalPages > 1) {
      $pagination.show();
      $('#pageInfo').text(`Page ${State.page + 1} of ${totalPages}`);
      $('#btnPrevPage').prop('disabled', State.page === 0);
      $('#btnNextPage').prop('disabled', State.page >= totalPages - 1);
    } else {
      $pagination.hide();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     RENDER: CODE DETAIL
  ═══════════════════════════════════════════════════════════════════ */
  function showCodeDetail(code) {
    State.selectedCode = code;
    const found = trieFind(code);
    if (!found) {
      const rec = State.flat && State.flat.find(r => r.c === code.toUpperCase());
      if (!rec) return;
      renderDetailFromFlat(rec);
      return;
    }
    const { node, ancestors } = found;
    renderDetail(node, ancestors);
    highlightTrieNode(code);
  }

  function renderDetailFromFlat(rec) {
    const node = { code: rec.c, short: rec.s, long: rec.l, billable: rec.b, order: rec.o, children: {} };
    const ancestors = buildAncestors(rec.c);
    renderDetail(node, ancestors);
    highlightTrieNode(rec.c);
  }

  function buildAncestors(code) {
    const ancestors = [];
    for (let len = 3; len <= code.length; len++) {
      const prefix = code.slice(0, len);
      const found = trieFind(prefix);
      if (found) ancestors.push({ code: prefix, short: found.node.short });
    }
    return ancestors;
  }

  function renderDetail(node, ancestors) {
    const $placeholder = $('#detailPlaceholder');
    const $card = $('#detailCard');
    const $copyBtn = $('#btnCopyCode');

    $placeholder.hide();
    $card.show();
    $copyBtn.show();

    // ── FRONT FACE ────────────────────────────────────────────────────
    $('#detailCode').text(node.code);

    const $bill = $('#detailBillable');
    if (node.billable) {
      $bill.text('Billable').removeClass('badge-header').addClass('badge-billable');
    } else {
      $bill.text('Header / Non-billable').removeClass('badge-billable').addClass('badge-header');
    }

    // FY2026 new code indicator
    const $newBadge = $('#detailNewBadge');
    const isNew = State.newCodes.has(node.code);
    if (isNew) {
      $newBadge.removeClass('hidden');
    } else {
      $newBadge.addClass('hidden');
    }

    $('#detailLong').text(node.long || node.short || '');
    $('#detailShort').text(
      node.short !== node.long && node.short
        ? `Short: ${node.short}`
        : ''
    );

    $('#detailOrder').text(node.order ? `#${node.order.toLocaleString()}` : '—');
    $('#detailLen').text(`${node.code.length} character${node.code.length !== 1 ? 's' : ''}`);

    const chapter = getChapterForCode(node.code);
    $('#detailChapter').text(chapter ? `Ch. ${chapter.label}` : '—');
    $('#detailCategory').text(node.code.slice(0, 3));

    // ── BACK FACE ─────────────────────────────────────────────────────
    $('#detailBackCode').text(node.code);
    const $backBill = $('#detailBackBillable');
    if (node.billable) {
      $backBill.text('Billable').removeClass('badge-header').addClass('badge-billable');
    } else {
      $backBill.text('Header').removeClass('badge-billable').addClass('badge-header');
    }
    $('#detailBackDesc').text(node.long || node.short || '');
    $('#detailBackChapter').text(chapter ? `Ch. ${chapter.label} — ${chapter.title}` : '—');
    $('#detailBackCategory').text(node.code.slice(0, 3));
    $('#detailBackType').text(node.billable ? 'Billable' : 'Header / Non-billable');
    $('#detailBackOrder').text(node.order ? `#${node.order.toLocaleString()}` : '—');
    $('#detailBackLen').text(`${node.code.length} char${node.code.length !== 1 ? 's' : ''}`);
    $('#detailBackBillableRaw').text(node.billable ? 'true' : 'false');
    $('#detailBackNew').text(isNew ? 'true' : 'false');

    // Trie path mini-viz on back face
    const $backTrie = $('#detailBackTrie').empty();
    node.code.split('').forEach((ch, i, arr) => {
      $backTrie.append(`<span class="dtpn ${i === arr.length - 1 ? 'dtpn-last' : ''}">${escHtml(ch)}</span>`);
      if (i < arr.length - 1) $backTrie.append('<span class="dtpa">&rarr;</span>');
    });

    // Breadcrumb
    const $bc = $('#detailBreadcrumb').empty();
    ancestors.forEach((anc, i) => {
      const $li = $(`
        <li class="breadcrumb-item" data-code="${escHtml(anc.code)}">
          <span class="bc-depth">${i + 1}</span>
          <span class="bc-code">${escHtml(anc.code)}</span>
          <span class="bc-desc">${escHtml(anc.short)}</span>
        </li>
      `);
      $li.on('click', function () { showCodeDetail($(this).data('code')); });
      $bc.append($li);
    });

    // Children
    const children = getChildren(node);
    const $childSection = $('#detailChildrenSection');
    const $childList = $('#detailChildren').empty();
    const $childTitle = $('#detailChildrenTitle');

    if (children.length > 0) {
      $childSection.show();
      $childTitle.text(`Subcodes (${children.length})`);
      children.slice(0, 30).forEach(child => {
        const isNew = State.newCodes.has(child.code);
        const $li = $(`
          <li class="subcode-item" data-code="${escHtml(child.code)}">
            <span class="sc-dot ${child.billable ? 'billable' : 'header'}"></span>
            <span class="sc-code">${escHtml(child.code)}</span>
            <span class="sc-desc">${escHtml(child.short)}</span>
            ${isNew ? '<span class="result-badge badge-new" style="font-size:.6rem;padding:1px 5px">NEW</span>' : ''}
          </li>
        `);
        $li.on('click', function () { showCodeDetail($(this).data('code')); });
        $childList.append($li);
      });
      if (children.length > 30) {
        $childList.append(`<li class="subcode-item" style="color:var(--text3);cursor:default">
          … and ${children.length - 30} more subcodes</li>`);
      }
    } else {
      $childSection.hide();
    }

    renderTriePath(node.code);
  }

  function renderTriePath(code) {
    const $viz = $('#triePathViz').empty();
    const chars = code.split('');
    chars.forEach((ch, i) => {
      const $node = $('<div class="trie-path-node"></div>');
      const $char = $(`<div class="trie-path-char ${i === chars.length - 1 ? 'active' : ''}">${escHtml(ch)}</div>`);
      $node.append($char);
      if (i < chars.length - 1) {
        $node.append('<span class="trie-path-arrow">&#8594;</span>');
      }
      $viz.append($node);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     RENDER: TRIE TREE
  ═══════════════════════════════════════════════════════════════════ */
  function renderTrieRoot(filterChapter) {
    const $root = $('#trieRoot').empty();

    let entries = Object.values(State.trie).sort((a, b) => a.order - b.order);

    if (filterChapter) {
      const ch = CHAPTERS.find(c => c.id === filterChapter);
      if (ch) {
        entries = entries.filter(node => {
          const cat = node.code.slice(0, 3).toUpperCase();
          return cat >= ch.range[0] && cat <= ch.range[1];
        });
      }
    }

    entries.forEach(node => {
      $root.append(buildTrieNodeEl(node, 0));
    });
  }

  function buildTrieNodeEl(node, depth) {
    const hasChildren = Object.keys(node.children || {}).length > 0;
    const isNew = State.newCodes.has(node.code);
    const $li = $('<li class="trie-node"></li>');
    const $row = $(`
      <div class="trie-node-row" data-code="${escHtml(node.code)}">
        <span class="trie-toggle ${hasChildren ? '' : 'leaf'}">&#9654;</span>
        <span class="trie-code">${escHtml(node.code)}</span>
        <span class="trie-desc">${escHtml(node.short)}</span>
        ${isNew ? '<span class="trie-new-dot" title="New in FY2026"></span>' : ''}
        ${node.billable ? '<span class="trie-billable-dot"></span>' : ''}
      </div>
    `);

    const $children = $('<ul class="trie-children"></ul>');
    let childrenLoaded = false;

    // Shared helper: load & open children without triggering showCodeDetail
    function openChildren() {
      if (!hasChildren) return;
      const $toggle = $row.find('.trie-toggle');
      if (!childrenLoaded) {
        const childNodes = Object.values(node.children).sort((a, b) => a.order - b.order);
        childNodes.forEach(child => {
          $children.append(buildTrieNodeEl(child, depth + 1));
        });
        childrenLoaded = true;
      }
      $children.addClass('open');
      $toggle.addClass('open');
    }

    // Expose on the DOM element so highlightTrieNode can call it
    $row[0]._openChildren = openChildren;

    $row.on('click', function (e) {
      e.stopPropagation();
      const code = $(this).data('code');

      showCodeDetail(code);
      $('.trie-node-row').removeClass('selected');
      $(this).addClass('selected');

      if (hasChildren) {
        const $toggle = $(this).find('.trie-toggle');
        const isOpen = $children.hasClass('open');
        if (!isOpen) {
          openChildren();
        } else {
          $children.removeClass('open');
          $toggle.removeClass('open');
        }
      }
    });

    $li.append($row);
    if (hasChildren) $li.append($children);
    return $li;
  }

  function highlightTrieNode(code) {
    code = code.toUpperCase();

    // 1. Ensure the correct chapter is active so the root category node exists
    const chapter = getChapterForCode(code);
    if (chapter && State.activeChapter !== chapter.id) {
      State.activeChapter = chapter.id;
      $('.chapter-pill').removeClass('active');
      $(`.chapter-pill[data-chapter="${chapter.id}"]`).addClass('active');
      renderTrieRoot(chapter.id);
    }

    // 2. Build the full ancestor prefix chain: ["A00", "A000", ...]
    const prefixes = [];
    for (let len = 3; len <= code.length; len++) {
      prefixes.push(code.slice(0, len));
    }

    // 3. Walk each prefix level and open children using the exposed helper
    //    (does NOT trigger showCodeDetail — avoids recursive re-render)
    prefixes.forEach((prefix, idx) => {
      const rowEl = document.querySelector(`.trie-node-row[data-code="${CSS.escape(prefix)}"]`);
      if (!rowEl) return;
      // For all but the last prefix, open children to reveal the next level
      if (idx < prefixes.length - 1 && typeof rowEl._openChildren === 'function') {
        rowEl._openChildren();
      }
    });

    // 4. Select and scroll to the target row
    const targetEl = document.querySelector(`.trie-node-row[data-code="${CSS.escape(code)}"]`);
    if (targetEl) {
      document.querySelectorAll('.trie-node-row.selected').forEach(el => el.classList.remove('selected'));
      targetEl.classList.add('selected');
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     RENDER: CHAPTER PILLS
  ═══════════════════════════════════════════════════════════════════ */
  function renderChapterPills() {
    const $pills = $('#chapterPills');
    const $all = $('<span class="chapter-pill active" data-chapter="">All</span>');
    $all.on('click', function () {
      State.activeChapter = null;
      $('.chapter-pill').removeClass('active');
      $(this).addClass('active');
      renderTrieRoot(null);
    });
    $pills.append($all);

    CHAPTERS.forEach(ch => {
      const $pill = $(`<span class="chapter-pill" data-chapter="${ch.id}" title="${escHtml(ch.title)}">${ch.label}</span>`);
      $pill.on('click', function () {
        State.activeChapter = ch.id;
        $('.chapter-pill').removeClass('active');
        $(this).addClass('active');
        renderTrieRoot(ch.id);
      });
      $pills.append($pill);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     RENDER: ADDENDA VIEW
  ═══════════════════════════════════════════════════════════════════ */
  function renderAddenda() {
    if (!State.addenda) return;
    const { adds, deletes, revisions, summary } = State.addenda;

    // Summary pills
    const $sum = $('#addendaSummary').empty();
    $sum.append(`
      <div class="addenda-stat adds">
        <span class="addenda-stat-num">${summary.total_adds}</span>
        <span>New codes added</span>
      </div>
      <div class="addenda-stat deletes">
        <span class="addenda-stat-num">${summary.total_deletes}</span>
        <span>Codes deleted</span>
      </div>
      <div class="addenda-stat revisions">
        <span class="addenda-stat-num">${summary.total_revisions}</span>
        <span>Revisions</span>
      </div>
    `);

    renderAddendaList();
  }

  function renderAddendaList() {
    if (!State.addenda) return;
    const { adds, deletes, revisions } = State.addenda;

    let items = [];
    if (State.addendaFilter === 'all') {
      items = [...adds, ...deletes, ...revisions];
    } else if (State.addendaFilter === 'Add') {
      items = adds;
    } else if (State.addendaFilter === 'Delete') {
      items = deletes;
    } else if (State.addendaFilter === 'Revise from') {
      items = revisions;
    }

    // Filter by search query
    const q = State.addendaQuery.toLowerCase().trim();
    if (q) {
      items = items.filter(item =>
        item.code.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q)
      );
    }

    // Sort by code
    items = items.slice().sort((a, b) => a.code.localeCompare(b.code));

    const $list = $('#addendaList').empty();

    if (items.length === 0) {
      $list.append('<li style="padding:24px;text-align:center;color:var(--text3)">No matching addenda entries.</li>');
      return;
    }

    items.forEach(item => {
      const actionClass = item.action === 'Add' ? 'action-add'
        : item.action === 'Delete' ? 'action-delete'
        : 'action-revise';
      const actionLabel = item.action === 'Revise from' ? 'Revise'
        : item.action === 'Revise to' ? 'Revise→'
        : item.action;

      const $li = $(`
        <li class="addenda-item" data-code="${escHtml(item.code)}">
          <span class="addenda-action-badge ${actionClass}">${escHtml(actionLabel)}</span>
          <span class="addenda-code">${escHtml(item.code)}</span>
          <span class="addenda-desc">${q ? highlight(item.desc, q) : escHtml(item.desc)}</span>
          <span class="addenda-chapter">Ch. ${escHtml(item.chapter)}</span>
        </li>
      `);

      $li.on('click', function () {
        const code = $(this).data('code');
        // Switch to search and look up code
        switchView('search');
        $('#searchInput').val(code);
        State.searchMode = 'exact';
        $('#searchModeTabs .tab-btn').removeClass('active');
        $('[data-mode="exact"]').addClass('active');
        runSearch(code);
        showCodeDetail(code);
      });

      $list.append($li);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     RENDER: CHAPTER STATS VIEW
  ═══════════════════════════════════════════════════════════════════ */
  function renderChapterStats() {
    if (!State.chapterStats) return;
    const $wrap = $('#statsWrap').empty();

    const maxTotal = Math.max(...State.chapterStats.map(c => c.total));

    State.chapterStats.forEach(ch => {
      const pct = Math.round((ch.billable / ch.total) * 100);
      const barWidth = Math.round((ch.total / maxTotal) * 100);

      const $row = $(`
        <div class="chapter-stat-row" data-chapter="${escHtml(ch.id)}">
          <span class="ch-num">Ch. ${escHtml(ch.id)}</span>
          <span class="ch-range">${escHtml(ch.range)}</span>
          <span class="ch-title" title="${escHtml(ch.title)}">${escHtml(ch.title)}</span>
          <div class="ch-bar-wrap">
            <div class="ch-bar-track">
              <div class="ch-bar-fill" style="width:${barWidth}%"></div>
            </div>
            <div class="ch-bar-nums">
              <span>${ch.billable.toLocaleString()} billable</span>
              <span>${pct}%</span>
            </div>
          </div>
          <span class="ch-total">${ch.total.toLocaleString()}</span>
        </div>
      `);

      $row.on('click', function () {
        const chId = $(this).data('chapter');
        // Switch to trie browser and filter by chapter
        State.activeChapter = chId;
        $('.chapter-pill').removeClass('active');
        $(`.chapter-pill[data-chapter="${chId}"]`).addClass('active');
        renderTrieRoot(chId);
        showToast(`Filtered to Chapter ${chId}`);
      });

      $wrap.append($row);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     VIEW SWITCHING
  ═══════════════════════════════════════════════════════════════════ */
  function switchView(view) {
    State.currentView = view;
    $('.main-tab').removeClass('active');
    $(`.main-tab[data-view="${view}"]`).addClass('active');
    $('.view-pane').addClass('hidden');
    $(`#view${view.charAt(0).toUpperCase() + view.slice(1)}`).removeClass('hidden');

    if (view === 'addenda') renderAddenda();
    if (view === 'stats') renderChapterStats();
  }

  /* ═══════════════════════════════════════════════════════════════════
     EVENT BINDINGS
  ═══════════════════════════════════════════════════════════════════ */
  function bindEvents() {
    // Main view tabs
    $('#mainTabs .main-tab').on('click', function () {
      switchView($(this).data('view'));
    });

    // Search input
    $('#searchInput').on('input', function () {
      const q = $(this).val().trim();
      State.query = q;
      clearTimeout(State.searchDebounce);
      State.searchDebounce = setTimeout(() => runSearch(q), 180);
    });

    // Clear search
    $('#btnClearSearch').on('click', function () {
      $('#searchInput').val('').trigger('input').focus();
    });

    // Search mode tabs
    $('#searchModeTabs .tab-btn').on('click', function () {
      $('#searchModeTabs .tab-btn').removeClass('active');
      $(this).addClass('active');
      State.searchMode = $(this).data('mode');
      const q = $('#searchInput').val().trim();
      if (q) runSearch(q);

      const hints = {
        prefix:   'Type a code prefix (e.g. A00, J45, M79…)',
        fulltext: 'Type keywords (e.g. diabetes, fracture femur…)',
        exact:    'Type an exact code (e.g. A000, J45.909…)',
      };
      $('#searchInput').attr('placeholder', hints[State.searchMode] || 'Search…');
    });

    // Pagination
    $('#btnPrevPage').on('click', function () {
      if (State.page > 0) {
        State.page--;
        renderResults(State.results, State.query, '—');
      }
    });

    $('#btnNextPage').on('click', function () {
      const totalPages = Math.ceil(State.results.length / State.pageSize);
      if (State.page < totalPages - 1) {
        State.page++;
        renderResults(State.results, State.query, '—');
      }
    });

    // Trie controls
    $('#btnCollapseAll').on('click', function () {
      $('.trie-children').removeClass('open');
      $('.trie-toggle').removeClass('open');
    });

    $('#btnExpandTop').on('click', function () {
      // Expand only the first visible top-level nodes (up to 10 to avoid overwhelming)
      let count = 0;
      $('#trieRoot > .trie-node > .trie-node-row').each(function () {
        if (count >= 10) return false;
        const $children = $(this).siblings('.trie-children');
        if ($children.length && !$children.hasClass('open')) {
          $(this).trigger('click');
          count++;
        }
      });
    });

    // Copy code
    $('#btnCopyCode').on('click', function () {
      if (State.selectedCode) {
        navigator.clipboard.writeText(State.selectedCode).then(() => {
          showToast(`Copied: ${State.selectedCode}`);
        }).catch(() => {
          showToast(`Code: ${State.selectedCode}`);
        });
      }
    });

    // Addenda type filter
    $('#addendaTypeTabs .tab-btn').on('click', function () {
      $('#addendaTypeTabs .tab-btn').removeClass('active');
      $(this).addClass('active');
      State.addendaFilter = $(this).data('atype');
      renderAddendaList();
    });

    // Addenda search
    let addendaDebounce;
    $('#addendaSearch').on('input', function () {
      clearTimeout(addendaDebounce);
      State.addendaQuery = $(this).val();
      addendaDebounce = setTimeout(renderAddendaList, 200);
    });

    // Keyboard shortcut: / to focus search
    $(document).on('keydown', function (e) {
      if (e.key === '/' && !$(e.target).is('input, textarea')) {
        e.preventDefault();
        switchView('search');
        $('#searchInput').focus();
      }
      if (e.key === 'Escape') {
        $('#searchInput').blur();
        $('#addendaSearch').blur();
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     TOAST
  ═══════════════════════════════════════════════════════════════════ */
  function showToast(msg, duration = 2200) {
    const $toast = $('#toast');
    $toast.text(msg).addClass('show');
    setTimeout(() => $toast.removeClass('show'), duration);
  }

  /* ═══════════════════════════════════════════════════════════════════
     LOADING PROGRESS
  ═══════════════════════════════════════════════════════════════════ */
  function setLoadingProgress(pct, text) {
    $('#loadingBar').css('width', pct + '%');
    if (text) $('#loadingText').text(text);
  }

  /* ═══════════════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════════════ */
  function init() {
    setLoadingProgress(5, 'Loading statistics…');

    // Load all data in parallel using jQuery Deferred
    const deferStats = $.getJSON('stats.json').done(data => {
      State.stats = data;
      setLoadingProgress(15, 'Loading trie structure…');
    });

    const deferAddenda = $.getJSON('addenda.json').done(data => {
      State.addenda = data;
      // Build new codes set
      data.adds.forEach(a => State.newCodes.add(a.code));
      data.deletes.forEach(a => State.deletedCodes.add(a.code));
    });

    const deferChStats = $.getJSON('chapter_stats.json').done(data => {
      State.chapterStats = data;
    });

    const deferTrie = $.ajax({ url: 'trie.json', dataType: 'json' }).done(data => {
      State.trie = data;
      setLoadingProgress(60, 'Loading search index…');
    });

    const deferFlat = $.ajax({ url: 'flat.json', dataType: 'json' }).done(data => {
      State.flat = data;
      setLoadingProgress(90, 'Rendering…');
    });

    // Wait for trie + flat (required), others are optional
    $.when(deferTrie, deferFlat).done(function () {
      // Also wait a tick for addenda/stats to finish if they can
      setTimeout(function () {
        setLoadingProgress(100, 'Ready!');
        setTimeout(function () {
          $('#loadingOverlay').fadeOut(300);
          onDataReady();
        }, 300);
      }, 200);
    }).fail(function () {
      setLoadingProgress(100, 'Error loading data. Please refresh.');
    });
  }

  function onDataReady() {
    renderChapterPills();
    renderTrieRoot(null);
    bindEvents();

    // Update header stats
    if (State.stats) {
      $('#statTotal').text(Number(State.stats.total_records).toLocaleString());
      $('#statBillable').text(Number(State.stats.billable).toLocaleString());
      $('#statCategories').text(Number(State.stats.top_level_categories).toLocaleString());
    }
    if (State.addenda) {
      $('#statAdds').text(State.addenda.summary.total_adds.toLocaleString());
    }

    $('#searchInput').focus();
    showToast('ICD-10-CM FY2026 loaded — Press / to search');
  }

  /* ── Start ── */
  init();
});
