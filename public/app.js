// Birds of Twin Peaks - public page. Reads /api/window and /api/species.
// Three views (collage, stats, atlas) over one chosen time window.
(function () {
  'use strict';

  var SOURCE_URL = 'https://github.com/iloveburritos/twin-peaks-birdnet';
  // General area only: the east slope of Twin Peaks, between the summit
  // and Market St. Deliberately loose, not the station's exact location.
  var AREA = { lat: 37.7532, lon: -122.4452, radius: 350 };
  var TZ = 'America/Los_Angeles';
  var REFRESH_MS = 2 * 60 * 1000;

  var WINDOWS = {
    '1h': { long: 'the last hour', short: 'past hour' },
    '12h': { long: 'the last 12 hours', short: 'past 12h' },
    '24h': { long: 'the last 24 hours', short: 'past 24h' },
    '7d': { long: 'the last 7 days', short: 'past 7 days' },
    all: { long: 'all time', short: 'all time' },
  };
  var VIEWS = ['collage', 'stats', 'atlas'];

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable: fine, nothing is remembered */ }
    return null;
  }

  var state = {
    win: WINDOWS[new URLSearchParams(location.search).get('w')] ? new URLSearchParams(location.search).get('w')
      : WINDOWS[store('tpb:win')] ? store('tpb:win') : '24h',
    view: 'collage',
    sort: ['life', 'family', 'alpha', 'count'].indexOf(store('tpb:sort')) >= 0 ? store('tpb:sort') : 'life',
    data: null,
  };
  var cache = {};
  var map = null;

  // ------------------------------------------------------------ audio

  var player = new Audio();
  var playing = null; // { node, reset }
  player.addEventListener('ended', stop);
  player.addEventListener('error', stop);

  function stop() {
    if (playing) playing.reset();
    playing = null;
  }
  function toggle(node, src, onStart, onReset) {
    if (playing && playing.node === node) { player.pause(); stop(); return; }
    player.pause();
    stop();
    player.src = src;
    player.play().catch(stop);
    playing = { node: node, reset: onReset };
    onStart();
  }

  // --------------------------------------------------------- formatting

  function fmtWhen(d) {
    var date = new Date(d.date + 'T' + d.time);
    var day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    var time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return day + ' · ' + time;
  }
  function fmtDate(iso) {
    return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function fmtClock(ts) {
    return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  }
  function hourLabel(h) {
    return (h % 12 || 12) + (h < 12 ? 'am' : 'pm');
  }
  function plural(n, word) {
    return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's');
  }
  // YYYY-MM-DD in Pacific time, matching the dates the Pi records.
  function pacificDate(ms) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(ms));
  }
  function nextDate(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  function birdImage(slug, alt, fallbackLetter) {
    var img = el('img');
    img.alt = alt || '';
    img.loading = 'lazy';
    img.src = '/birds/' + slug + '.webp';
    img.addEventListener('error', function () {
      img.replaceWith(el('div', 'ph', fallbackLetter || '?'));
    });
    return img;
  }

  // ---------------------------------------------------------- shared bits

  function detectionRow(d, showName) {
    var li = el('li');
    var row = el('button', 'row' + (d.clip ? '' : ' noclip'));
    row.type = 'button';
    row.append(el('span', 'play', d.clip ? '▶' : '–'));
    row.append(el('span', 'name', showName ? d.com : fmtWhen(d)));
    var conf = d.conf != null ? Math.round(d.conf * 100) + '%' : '';
    row.append(el('span', 'when mono', showName ? fmtWhen(d) : conf + ' match'));
    if (d.clip) {
      row.setAttribute('aria-label', 'Play recording of ' + d.com + ', ' + fmtWhen(d));
      row.addEventListener('click', function () {
        toggle(row, d.clip,
          function () { row.classList.add('playing'); },
          function () { row.classList.remove('playing'); });
      });
    } else {
      row.disabled = true;
    }
    li.append(row);
    return li;
  }

  // Detail card, laid out after Avian Visitors' species modal: the
  // illustration (perched or in flight), the bird's stamp, a Wikipedia
  // field-guide description, taxonomy, rarity and its recordings.
  var aboutCache = {};
  var sheetFor = null;

  function rarityLabel(s) {
    if (!s.n_all) return '–';
    var days = Math.max(1, Math.ceil((Date.now() / 1000 - s.first_ts) / 86400));
    var perDay = s.n_all / days;
    return perDay >= 5 ? 'common' : perDay >= 1 ? 'regular' : perDay >= 0.2 ? 'occasional' : 'rare';
  }
  function ago(ts) {
    var d = Math.floor((Date.now() / 1000 - ts) / 86400);
    return d < 1 ? 'today' : d === 1 ? '1d ago' : d < 60 ? d + 'd ago' : Math.round(d / 30) + 'mo ago';
  }

  function setPose(slug, pose) {
    var img = $('sheet-img');
    img.src = '/birds/' + slug + (pose === 2 ? '-2' : '') + '.webp';
    [].forEach.call($('sheet-pose').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', +b.dataset.pose === pose ? 'true' : 'false');
    });
  }

  function renderAbout(s, info) {
    var about = $('sheet-about');
    var paras = info && info.paragraphs && info.paragraphs.length ? info.paragraphs : null;
    about.replaceChildren.apply(about, paras
      ? paras.map(function (p) { return el('p', null, p); })
      : [el('p', 'soft', info ? 'No description available for this bird yet.' : 'Loading…')]);
    var marks = $('sheet-marks');
    marks.hidden = !(info && info.distinctive);
    marks.textContent = info && info.distinctive ? info.distinctive : '';
    var credit = $('sheet-credit');
    credit.hidden = !(info && info.source);
    if (info && info.source) {
      var a = el('a', null, 'Wikipedia');
      a.href = info.source.url; a.target = '_blank'; a.rel = 'noopener';
      var lic = el('a', null, info.source.license);
      lic.href = 'https://creativecommons.org/licenses/by-sa/4.0/'; lic.target = '_blank'; lic.rel = 'noopener';
      credit.replaceChildren(document.createTextNode('Text from '), a, document.createTextNode(', '), lic);
    }
    var eb = $('sheet-ebird');
    eb.hidden = !(info && info.ebird);
    if (info && info.ebird) eb.href = 'https://ebird.org/species/' + info.ebird;
  }

  function openSheet(s) {
    sheetFor = s.sci;
    var all = state.data ? state.data.species : [s];
    var acc = accessionOf(all);
    var parts = s.sci.split(' ');
    $('sheet-name').textContent = s.com;
    $('sheet-sci').textContent = s.sci;
    $('sheet-meta').replaceChildren(
      el('b', null, s.n_all.toLocaleString()), document.createTextNode(' heard  '),
      el('b', null, ago(s.first_ts)), document.createTextNode(' first heard'));

    // Illustration with an optional in-flight pose.
    var img = $('sheet-img');
    img.alt = 'Illustration of ' + s.com;
    img.onerror = null;
    setPose(s.slug, 1);
    $('pose-1').src = '/birds/' + s.slug + '.webp';
    var pose2 = $('pose-2');
    $('sheet-pose').hidden = true;
    pose2.onload = function () { if (sheetFor === s.sci) $('sheet-pose').hidden = false; };
    pose2.onerror = function () { $('sheet-pose').hidden = true; };
    pose2.src = '/birds/' + s.slug + '-2.webp';
    $('sheet-pose').onclick = function (e) {
      var b = e.target.closest('button[data-pose]');
      if (b) setPose(s.slug, +b.dataset.pose);
    };

    var stamp = $('sheet-stamp');
    stamp.innerHTML = window.STAMPS
      ? window.STAMPS.markup({ sci: s.sci, com: s.com, index: acc[s.sci] || 0, count: s.n_all }, '/birds/' + s.slug + '.webp')
      : '';

    var family = window.STAMPS ? window.STAMPS.latinOf(s.sci) : '';
    var facts = [['Family', family], ['Genus', parts[0]], ['Species', parts.slice(1).join(' ')], ['Rarity', rarityLabel(s)]];
    $('sheet-facts').replaceChildren.apply($('sheet-facts'), facts.filter(function (f) { return f[1]; }).map(function (f) {
      var d = el('div');
      d.append(el('dt', null, f[0]), el('dd', null, f[1]));
      return d;
    }));

    var wiki = $('sheet-wiki');
    wiki.href = 'https://en.wikipedia.org/wiki/Special:Search?go=Go&search=' + encodeURIComponent(s.sci);
    renderAbout(s, aboutCache[s.sci] || null);
    if (!aboutCache[s.sci]) {
      fetch('/api/about?sci=' + encodeURIComponent(s.sci))
        .then(function (r) { return r.json(); })
        .then(function (info) {
          aboutCache[s.sci] = info;
          if (sheetFor === s.sci) {
            renderAbout(s, info);
            if (info.source) wiki.href = info.source.url;
          }
        })
        .catch(function () { if (sheetFor === s.sci) renderAbout(s, { paragraphs: [] }); });
    } else if (aboutCache[s.sci].source) {
      wiki.href = aboutCache[s.sci].source.url;
    }

    var list = $('sheet-list');
    $('sheet-count').textContent = '';
    list.replaceChildren(el('li', 'soft small mono', 'Loading…'));
    if (!$('sheet').open) $('sheet').showModal();
    $('sheet').scrollTop = 0;
    fetch('/api/species?sci=' + encodeURIComponent(s.sci))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (sheetFor !== s.sci) return;
        var withClip = data.detections.filter(function (d) { return d.clip; }).length;
        $('sheet-count').textContent = plural(withClip, 'recording');
        list.replaceChildren.apply(list, data.detections.map(function (d) {
          d.com = s.com;
          return detectionRow(d, false);
        }));
      })
      .catch(function () { list.replaceChildren(el('li', 'soft', 'Could not load recordings.')); });
  }

  function renderBars(target, values, labels) {
    var max = Math.max.apply(null, values.concat([1]));
    $(target).replaceChildren.apply($(target), values.map(function (v, i) {
      var bar = el('div');
      bar.style.height = Math.max(2, Math.round((v / max) * 100)) + '%';
      bar.title = labels[i] + ': ' + plural(v, 'detection');
      return bar;
    }));
  }

  function inWindow(data) {
    return data.species.filter(function (s) { return s.n > 0; })
      .sort(function (a, b) { return b.n - a.n || b.last_ts - a.last_ts; });
  }

  // ------------------------------------------------------------- collage

  // Packed collage: each bird's outline is traced from its illustration's
  // transparency, then birds are placed largest-first, spiralling out from
  // the centre until the outline (and its handwritten name) fits without
  // touching anything already placed. Approach adapted from Avian Visitors.
  var STRIDE = 6;           // occupancy grid cell, in CSS pixels
  var MASK = 72;            // traced outline resolution
  var maskCache = {};
  var collageRun = 0;
  var collageData = null;

  function traceMask(slug) {
    if (maskCache[slug]) return maskCache[slug];
    maskCache[slug] = new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var k = MASK / Math.max(w, h);
        var mw = Math.max(1, Math.round(w * k)), mh = Math.max(1, Math.round(h * k));
        var c = document.createElement('canvas');
        c.width = mw; c.height = mh;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, mw, mh);
        var px = ctx.getImageData(0, 0, mw, mh).data;
        var alpha = new Uint8Array(mw * mh);
        for (var i = 0; i < mw * mh; i++) alpha[i] = px[i * 4 + 3] > 40 ? 1 : 0;
        resolve({ ok: true, aspect: w / h, mw: mw, mh: mh, alpha: alpha });
      };
      img.onerror = function () { resolve({ ok: false, aspect: 1, mw: 1, mh: 1, alpha: new Uint8Array([1]) }); };
      img.src = '/birds/' + slug + '.webp';
    });
    return maskCache[slug];
  }

  var measureCtx = document.createElement('canvas').getContext('2d');
  function labelFont(px) { return px + 'px Caveat, "Bradley Hand", "Segoe Print", cursive'; }

  // Grid cells (relative to the tile's top-left) covered by the bird and its label.
  function buildTile(s, mask, size, labelPx, i) {
    var w = mask.aspect >= 1 ? size : size * mask.aspect;
    var h = mask.aspect >= 1 ? size / mask.aspect : size;
    var gw = Math.ceil(w / STRIDE), gh = Math.ceil(h / STRIDE);
    var cells = [], top = gh, topXs = [];
    for (var gy = 0; gy < gh; gy++) {
      for (var gx = 0; gx < gw; gx++) {
        var x0 = Math.floor(gx * STRIDE / w * mask.mw), x1 = Math.ceil((gx + 1) * STRIDE / w * mask.mw);
        var y0 = Math.floor(gy * STRIDE / h * mask.mh), y1 = Math.ceil((gy + 1) * STRIDE / h * mask.mh);
        var hit = false;
        for (var my = y0; my < Math.min(y1, mask.mh) && !hit; my++) {
          for (var mx = x0; mx < Math.min(x1, mask.mw); mx++) {
            if (mask.alpha[my * mask.mw + mx]) { hit = true; break; }
          }
        }
        if (hit) {
          cells.push(gx, gy);
          if (gy < top) { top = gy; topXs = []; }
          if (gy === top) topXs.push(gx);
        }
      }
    }
    // Name sits just above the top of the bird (usually its head), tilted a little.
    measureCtx.font = labelFont(labelPx);
    var lw = Math.ceil(measureCtx.measureText(s.com).width) + 4, lh = Math.ceil(labelPx * 1.1);
    var headX = topXs.length ? (topXs[0] + topXs[topXs.length - 1] + 1) / 2 * STRIDE : w / 2;
    var lx = Math.max(-lw * 0.25, Math.min(w - lw * 0.75, headX - lw / 2));
    var ly = top * STRIDE - lh - 2;
    var rot = ((i * 47) % 11) - 5;
    var labelCells = [];
    var lgx0 = Math.floor(lx / STRIDE), lgx1 = Math.ceil((lx + lw) / STRIDE);
    var lgy0 = Math.floor((ly - 4) / STRIDE), lgy1 = Math.ceil((ly + lh + 4) / STRIDE);
    for (var ay = lgy0; ay < lgy1; ay++) for (var ax = lgx0; ax < lgx1; ax++) labelCells.push(ax, ay);
    return {
      s: s, ok: mask.ok, w: w, h: h, cells: cells, labelCells: labelCells,
      label: { x: lx, y: ly, w: lw, h: lh, px: labelPx, rot: rot },
      minGX: Math.min(0, lgx0), minGY: Math.min(0, lgy0),
      maxGX: Math.max(Math.ceil(w / STRIDE), lgx1), maxGY: Math.max(Math.ceil(h / STRIDE), lgy1),
    };
  }

  function pack(tiles, W, H, xBias, yBias) {
    var GW = Math.ceil(W / STRIDE), GH = Math.ceil(H / STRIDE);
    var grid = new Uint8Array(GW * GH);
    function fits(t, gx, gy) {
      if (gx + t.minGX < 0 || gy + t.minGY < 0 || gx + t.maxGX > GW || gy + t.maxGY > GH) return false;
      var lists = [t.cells, t.labelCells];
      for (var L = 0; L < 2; L++) {
        var c = lists[L];
        for (var i = 0; i < c.length; i += 2) if (grid[(gy + c[i + 1]) * GW + gx + c[i]]) return false;
      }
      return true;
    }
    function stamp(t, gx, gy) {
      var mark = function (x, y) { if (x >= 0 && y >= 0 && x < GW && y < GH) grid[y * GW + x] = 1; };
      for (var i = 0; i < t.cells.length; i += 2) {
        // One cell of breathing room around each silhouette.
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) mark(gx + t.cells[i] + dx, gy + t.cells[i + 1] + dy);
      }
      for (var j = 0; j < t.labelCells.length; j += 2) mark(gx + t.labelCells[j], gy + t.labelCells[j + 1]);
    }
    var cgx = GW / 2, cgy = GH / 2;
    var seed = 0x2545F491;
    var rand = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    var placed = [], comX = 0, comY = 0, comW = 0;
    for (var n = 0; n < tiles.length; n++) {
      var t = tiles[n];
      var hw = t.w / STRIDE / 2, hh = t.h / STRIDE / 2;
      var best = null, bestCost = Infinity, foundR = -1;
      var phase = rand() * Math.PI * 2;
      for (var r = 0; r < Math.max(GW, GH); r += 1) {
        if (foundR >= 0 && r > foundR + 2) break;
        var samples = r === 0 ? 1 : Math.max(24, Math.round(r * 4));
        for (var k = 0; k < samples; k++) {
          var th = phase + (k / samples) * Math.PI * 2;
          var gx = Math.round(cgx + r * xBias * Math.cos(th) - hw);
          var gy = Math.round(cgy + r * yBias * Math.sin(th) - hh);
          if (!fits(t, gx, gy)) continue;
          var cost = n === 0 ? 0 : Math.hypot((gx + hw - comX) / xBias, (gy + hh - comY) / yBias) + rand() * 0.8;
          if (cost < bestCost) { bestCost = cost; best = [gx, gy]; }
        }
        if (best && foundR < 0) foundR = r;
      }
      if (!best) return null; // does not fit at this scale
      stamp(t, best[0], best[1]);
      t.x = best[0] * STRIDE; t.y = best[1] * STRIDE;
      var a = t.w * t.h;
      comX = (comX * comW + (best[0] + hw) * a) / (comW + a);
      comY = (comY * comW + (best[1] + hh) * a) / (comW + a);
      comW += a;
      placed.push(t);
    }
    return placed;
  }

  function renderCollage(data) {
    collageData = data;
    var run = ++collageRun;
    var heard = inWindow(data);
    var pool = heard.slice(0, 24);
    var empty = $('empty');
    // The Pi has stopped checking in: show the empty nest instead.
    var offline = data.online === false;
    $('offline').hidden = !offline;
    empty.hidden = offline || pool.length > 0;
    if (offline || !pool.length) {
      empty.textContent = data.totals.all_species
        ? 'No birds heard in ' + WINDOWS[data.window].long + '. Detections appear about 15 minutes after they are heard.'
        : 'No birds published yet. Check back soon.';
      $('collage').replaceChildren();
      $('collage').style.height = '';
      return;
    }
    var fontReady = document.fonts && document.fonts.load ? document.fonts.load(labelFont(20)).catch(function () {}) : Promise.resolve();
    Promise.all([fontReady].concat(pool.map(function (s) { return traceMask(s.slug); }))).then(function (res) {
      if (run !== collageRun) return; // a newer render started
      var masks = res.slice(1);
      var box = $('collage');
      var W = Math.max(300, box.clientWidth || window.innerWidth - 40);
      var portrait = W < 700;
      var H = Math.round(portrait ? W * 2.2 : Math.max(560, W * 0.75));
      var max = pool[0].n;
      var big = portrait ? W * 0.55 : Math.min(450, W * 0.32);
      var small = portrait ? W * 0.2 : Math.min(135, W * 0.1);
      var placed = null;
      for (var scale = 1; scale > 0.3 && !placed; scale *= 0.9) {
        var tiles = pool.map(function (s, i) {
          var share = Math.sqrt(s.n / max);
          var size = (small + (big - small) * share) * scale;
          var labelPx = Math.round(Math.max(13, Math.min(26, 11 + size * 0.06)));
          return buildTile(s, masks[i], size, labelPx, i);
        });
        tiles.sort(function (a, b) { return b.w * b.h - a.w * a.h; });
        placed = pack(tiles, W, H, portrait ? 0.75 : 1.8, portrait ? 1.4 : 1);
      }
      if (!placed) return;
      // Trim the canvas to the cluster and centre it.
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      placed.forEach(function (t) {
        minX = Math.min(minX, t.x + Math.min(0, t.label.x)); maxX = Math.max(maxX, t.x + Math.max(t.w, t.label.x + t.label.w));
        minY = Math.min(minY, t.y + Math.min(0, t.label.y)); maxY = Math.max(maxY, t.y + t.h);
      });
      var offX = (W - (maxX - minX)) / 2 - minX, offY = 12 - minY;
      box.style.height = Math.ceil(maxY - minY + 24) + 'px';
      var motion = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      box.replaceChildren.apply(box, placed.map(function (t, i) {
        var s = t.s;
        var b = el('button', 'cbird');
        b.type = 'button';
        b.style.left = Math.round(t.x + offX) + 'px';
        b.style.top = Math.round(t.y + offY) + 'px';
        b.style.width = Math.round(t.w) + 'px';
        b.style.height = Math.round(t.h) + 'px';
        if (motion) b.style.animationDelay = (i * 45) + 'ms';
        b.setAttribute('aria-label', s.com + ', heard ' + plural(s.n, 'time') + ' in ' + WINDOWS[data.window].long);
        if (t.ok) {
          var img = el('img');
          img.alt = '';
          img.src = '/birds/' + s.slug + '.webp';
          b.append(img);
        } else {
          b.append(el('div', 'ph', s.com.charAt(0)));
        }
        var lab = el('span', 'clabel', s.com);
        lab.setAttribute('aria-hidden', 'true');
        lab.style.left = Math.round(t.label.x) + 'px';
        lab.style.top = Math.round(t.label.y) + 'px';
        lab.style.fontSize = t.label.px + 'px';
        lab.style.transform = 'rotate(' + t.label.rot + 'deg)';
        b.append(lab);
        b.addEventListener('click', function () { openSheet(s); });
        return b;
      }));
    });
  }

  var resizeTimer = null, lastWidth = window.innerWidth;
  window.addEventListener('resize', function () {
    if (window.innerWidth === lastWidth) return; // ignore mobile toolbar height changes
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (collageData) renderCollage(collageData); }, 200);
  });

  // --------------------------------------------------------------- stats

  // Fills in empty buckets so the timeline has an even time axis.
  function timelineSeries(data) {
    var byKey = {};
    data.timeline.forEach(function (t) { byKey[t.b] = t.n; });
    var values = [], labels = [];
    if (data.bucket === 'day') {
      var end = pacificDate(data.cutoff * 1000);
      var day = data.window === 'all'
        ? (data.totals.first_date || end)
        : pacificDate((data.start + 86400) * 1000);
      for (var guard = 0; day <= end && guard < 1000; guard++, day = nextDate(day)) {
        values.push(byKey[day] || 0);
        labels.push(fmtDate(day));
      }
    } else {
      var count = Math.ceil((data.cutoff - data.start) / data.bucket);
      for (var i = 0; i < count; i++) {
        values.push(byKey[i] || 0);
        labels.push(fmtClock(data.start + i * data.bucket));
      }
    }
    return { values: values, labels: labels };
  }

  function rankItem(s, right, share) {
    var li = el('li');
    var b = el('button', 'rank-row');
    b.type = 'button';
    b.append(birdImage(s.slug, '', s.com.charAt(0)));
    var mid = el('span', 'rank-mid');
    mid.append(el('span', 'name', s.com));
    if (share != null) {
      var track = el('span', 'rank-bar');
      var fill = el('i');
      fill.style.width = Math.max(3, Math.round(share * 100)) + '%';
      track.append(fill);
      mid.append(track);
    }
    b.append(mid, el('span', 'when mono', right));
    b.addEventListener('click', function () { openSheet(s); });
    li.append(b);
    return li;
  }

  function renderStats(data) {
    var heard = inWindow(data);
    var t = data.totals;
    var peak = data.hourly.indexOf(Math.max.apply(null, data.hourly));
    var top = heard[0];
    var tiles = [
      ['Detections', t.detections.toLocaleString(), WINDOWS[data.window].short],
      ['Species', String(t.species), 'of ' + t.all_species + ' ever heard'],
      ['Most heard', top ? top.com : '–', top ? plural(top.n, 'time') : ''],
      ['Busiest hour', t.detections ? hourLabel(peak) : '–', 'Pacific time'],
    ];
    $('tiles').replaceChildren.apply($('tiles'), tiles.map(function (x) {
      var tile = el('div', 'tile');
      tile.append(el('div', 'label mono', x[0]), el('div', 'value', x[1]), el('div', 'sub mono', x[2]));
      return tile;
    }));

    var series = timelineSeries(data);
    $('timeline-label').textContent = data.bucket === 'day' ? 'Detections per day'
      : data.bucket === 300 ? 'Detections per 5 minutes' : 'Detections per hour';
    renderBars('timeline', series.values, series.labels);
    var n = series.labels.length;
    var ticks = n ? [series.labels[0], series.labels[Math.floor((n - 1) / 2)], series.labels[n - 1]] : [];
    $('timeline-axis').replaceChildren.apply($('timeline-axis'), ticks.map(function (x) { return el('span', null, x); }));

    renderBars('hourly', data.hourly, data.hourly.map(function (_, h) { return hourLabel(h); }));

    var max = top ? top.n : 1;
    $('top').replaceChildren.apply($('top'), heard.length
      ? heard.slice(0, 8).map(function (s) { return rankItem(s, '×' + s.n, s.n / max); })
      : [el('li', 'soft small mono', 'Nothing heard in ' + WINDOWS[data.window].long + '.')]);

    var firsts = data.species.slice().sort(function (a, b) { return b.first_ts - a.first_ts; }).slice(0, 8);
    $('firsts').replaceChildren.apply($('firsts'), firsts.map(function (s) {
      return rankItem(s, fmtDate(s.first_date), null);
    }));

    $('latest').replaceChildren.apply($('latest'), data.recent.length
      ? data.recent.map(function (d) { return detectionRow(d, true); })
      : [el('li', 'soft small mono', 'Nothing heard in ' + WINDOWS[data.window].long + '.')]);
  }

  function ensureMap() {
    if (map || !window.L) { if (map) map.invalidateSize(); return; }
    map = L.map('map', { scrollWheelZoom: false, zoomControl: true, attributionControl: true })
      .setView([AREA.lat, AREA.lon], 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 16,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    L.circle([AREA.lat, AREA.lon], {
      radius: AREA.radius, color: '#4a3f31', weight: 1.5, fillColor: '#4a3f31', fillOpacity: 0.14,
    }).addTo(map).bindTooltip('Twin Peaks', { permanent: true, direction: 'top', className: 'mono' });
  }

  // --------------------------------------------------------------- atlas

  // Each species is printed as a postage stamp whose design is set by its
  // family. Stamp designs, effects and styles are Avian Visitors' own
  // (stamps.js, stamp-batch-*.js and their CSS, copied unchanged); this file
  // only chooses which birds to show and packs the stamps onto the page.
  var SORTS = ['life', 'family', 'alpha', 'count'];
  var atlasRun = 0;

  function accessionOf(species) {
    var acc = {};
    species.slice().sort(function (a, b) { return a.first_ts - b.first_ts || a.sci.localeCompare(b.sci); })
      .forEach(function (s, i) { acc[s.sci] = i + 1; });
    return acc;
  }

  function stampCard(s, acc) {
    var card = el('article', 'bird-card stamp-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', s.com + ', stamp number ' + acc[s.sci] + ', heard ' + plural(s.n_all, 'time'));
    card.innerHTML = window.STAMPS.markup(
      { sci: s.sci, com: s.com, index: acc[s.sci], count: s.n_all },
      '/birds/' + s.slug + '.webp');
    card.addEventListener('click', function () { openSheet(s); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(s); }
    });
    return card;
  }

  // Skyline packing: each stamp drops into the column position where it can
  // sit highest, so differently shaped issues interlock like an album page.
  function packStamps(grid) {
    var cards = [].slice.call(grid.children).filter(function (c) { return c.classList.contains('stamp-card'); });
    var width = grid.clientWidth;
    if (!cards.length || !width) return;
    var mobile = window.innerWidth <= 700;
    var scale = mobile ? 0.8 : Math.max(0.8, Math.min(1, 0.8 + (window.innerWidth - 700) / 1500));
    var gap = mobile ? 5 : 6, unit = 4;
    var items = cards.map(function (card) {
      var fit = card.querySelector('.stamp-fit');
      var w = Math.ceil(parseFloat(fit.style.width) * scale), h = Math.ceil(parseFloat(fit.style.height) * scale);
      fit.style.setProperty('--fit-scale', scale);
      card.style.setProperty('--slot-w', w + 'px');
      card.style.setProperty('--slot-h', h + 'px');
      return { card: card, w: w, h: h };
    });
    var maxW = Math.max.apply(null, items.map(function (i) { return i.w; }));
    // Use a sheet width that is a whole number of the widest issue, centred.
    var sheet = Math.max(maxW, Math.min(width, Math.floor((width + gap) / (maxW + gap)) * (maxW + gap) + maxW));
    sheet = Math.min(sheet, width);
    function layout(look) {
      var placed = [];
      function spot(it) {
        var best = null;
        for (var x = 0; x <= sheet - it.w; x += unit) {
          var blockers = placed.filter(function (p) { return x < p.x + p.w + gap && x + it.w + gap > p.x; })
            .sort(function (a, b) { return a.y - b.y; });
          var y = 0;
          for (var j = 0; j < blockers.length; j++) {
            if (y + it.h + gap <= blockers[j].y) break; // fits in the hole above this one
            y = Math.max(y, blockers[j].y + blockers[j].h + gap);
          }
          if (!best || y < best.y - 0.5) best = { x: x, y: y };
        }
        return best || { x: 0, y: placed.reduce(function (m, p) { return Math.max(m, p.y + p.h + gap); }, 0) };
      }
      // Look a few stamps ahead and place whichever can sit highest, so holes
      // get filled while the reading order stays close to the chosen sort.
      var queue = items.slice();
      while (queue.length) {
        var pick = 0, at = null;
        for (var k = 0; k < Math.min(look, queue.length); k++) {
          var cand = spot(queue[k]);
          if (!at || cand.y < at.y - 8) { at = cand; pick = k; }
        }
        var it = queue.splice(pick, 1)[0];
        placed.push({ card: it.card, x: at.x, y: at.y, w: it.w, h: it.h });
      }
      return placed;
    }
    function bottomOf(list) { return list.reduce(function (m, p) { return Math.max(m, p.y + p.h); }, 0); }
    // Several look-ahead depths; keep the most compact sheet.
    var placed = null;
    [1, 2, 3, 4, 6].forEach(function (look) {
      var tryIt = layout(look);
      if (!placed || bottomOf(tryIt) < bottomOf(placed) - 4) placed = tryIt;
    });
    var right = placed.reduce(function (m, p) { return Math.max(m, p.x + p.w); }, 0);
    var offset = Math.max(0, Math.floor((width - right) / 2));
    var bottom = 0;
    placed.forEach(function (p) {
      p.card.style.left = (p.x + offset) + 'px';
      p.card.style.top = p.y + 'px';
      bottom = Math.max(bottom, p.y + p.h);
    });
    grid.classList.add('is-packed');
    grid.style.height = bottom + 'px';
  }

  function packAtlas() {
    var root = $('atlas');
    if ($('view-atlas').hidden) return;
    var grids = root.classList.contains('atlas-grid') && root.dataset.mode !== 'family'
      ? [root] : [].slice.call(root.querySelectorAll('.atlas-fam-grid'));
    grids.forEach(packStamps);
  }

  function renderAtlas(data) {
    var run = ++atlasRun;
    var root = $('atlas');
    var all = data.species;
    var acc = accessionOf(all);
    var list = data.window === 'all' ? all.slice() : all.filter(function (s) { return s.n > 0; });
    var famOf = function (s) { return window.STAMPS ? window.STAMPS.familyOf(s.sci) : 'Other'; };
    var sorters = {
      life: function (a, b) { return acc[b.sci] - acc[a.sci]; },
      family: function (a, b) { return famOf(a).localeCompare(famOf(b)) || b.n_all - a.n_all; },
      alpha: function (a, b) { return a.com.localeCompare(b.com); },
      count: function (a, b) { return (data.window === 'all' ? b.n_all - a.n_all : b.n - a.n) || b.n_all - a.n_all; },
    };
    list.sort(sorters[state.sort]);
    [].forEach.call($('atlas-sort').querySelectorAll('button'), function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.sort === state.sort ? 'true' : 'false');
    });
    $('atlas-note').textContent = all.length
      ? (data.window === 'all'
        ? all.length + ' species heard since ' + fmtDate(data.totals.first_date)
        : list.length + ' of ' + all.length + ' species heard in ' + WINDOWS[data.window].long)
      : '';
    root.style.height = '';
    root.classList.remove('is-packed');
    root.dataset.mode = state.sort === 'family' ? 'family' : '';
    if (!list.length || !window.STAMPS) {
      root.replaceChildren(el('p', 'empty', !all.length ? 'No birds published yet. Check back soon.'
        : !window.STAMPS ? 'The stamp album could not be loaded.'
        : 'No birds heard in ' + WINDOWS[data.window].long + '. Try a longer window.'));
      return;
    }
    if (state.sort === 'family') {
      var blocks = [], cur = null, grid = null;
      list.forEach(function (s) {
        var f = famOf(s);
        if (f !== cur) {
          cur = f;
          var block = el('section', 'fam-block');
          var head = el('h2', 'atlas-fam');
          head.append(el('span', null, f), el('i'), el('em', null, ''));
          grid = el('div', 'atlas-fam-grid');
          block.append(head, grid);
          blocks.push({ block: block, head: head, grid: grid });
        }
        blocks[blocks.length - 1].grid.append(stampCard(s, acc));
      });
      blocks.forEach(function (b) { b.head.querySelector('em').textContent = b.grid.children.length + ' species'; });
      root.replaceChildren.apply(root, blocks.map(function (b) { return b.block; }));
    } else {
      root.replaceChildren.apply(root, list.map(function (s) { return stampCard(s, acc); }));
    }
    // Stamp fonts change text metrics; pack once they are ready, then again
    // after the canvas treatments paint.
    requestAnimationFrame(function () { if (run === atlasRun) packAtlas(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (run === atlasRun) packAtlas(); });
  }

  var atlasResize = null;
  window.addEventListener('resize', function () {
    clearTimeout(atlasResize);
    atlasResize = setTimeout(packAtlas, 160);
  });

  // ------------------------------------------------------- state + loading

  function renderAll() {
    var data = state.data;
    if (!data) return;
    var t = data.totals;
    $('window-note').textContent = t.all_species
      ? plural(t.detections, 'detection') + ' of ' + (t.species === 1 ? '1 species' : t.species + ' species') +
        ' in ' + WINDOWS[data.window].long
      : '';
    renderCollage(data);
    renderStats(data);
    renderAtlas(data);
  }

  function load(force) {
    var w = state.win;
    var hit = cache[w];
    if (hit && !force && Date.now() - hit.at < 60000) {
      state.data = hit.data;
      renderAll();
      return;
    }
    document.body.classList.add('loading');
    fetch('/api/window?w=' + w)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        cache[w] = { at: Date.now(), data: data };
        if (state.win !== w) return; // the visitor switched windows meanwhile
        state.data = data;
        renderAll();
        openLinkedBird(data);
      })
      .catch(function () {
        if (state.data) return; // keep showing what we have
        $('empty').hidden = false;
        $('empty').textContent = 'The bird log could not be loaded just now. Please try again in a minute.';
      })
      .then(function () { document.body.classList.remove('loading'); });
  }

  // ?bird=<slug> opens that bird's card once, so a bird can be linked to.
  var linkedBird = new URLSearchParams(location.search).get('bird');
  function openLinkedBird(data) {
    if (!linkedBird) return;
    var s = data.species.filter(function (x) { return x.slug === linkedBird; })[0];
    linkedBird = null;
    if (s) openSheet(s);
  }

  function setWindow(w) {
    state.win = w;
    store('tpb:win', w);
    [].forEach.call($('windows').querySelectorAll('button'), function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.w === w ? 'true' : 'false');
    });
    load(false);
  }

  function setView(v, push) {
    if (VIEWS.indexOf(v) < 0) v = 'collage';
    state.view = v;
    VIEWS.forEach(function (name) { $('view-' + name).hidden = name !== v; });
    [].forEach.call($('views-pick').querySelectorAll('button'), function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.view === v ? 'true' : 'false');
    });
    if (push) history.replaceState(null, '', v === 'collage' ? location.pathname : '#' + v);
    if (v === 'atlas') requestAnimationFrame(packAtlas);
    if (v === 'collage' && collageData) renderCollage(collageData);
  }

  $('windows').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-w]');
    if (btn) setWindow(btn.dataset.w);
  });
  $('views-pick').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-view]');
    if (btn) { setView(btn.dataset.view, true); window.scrollTo({ top: 0 }); }
  });
  $('atlas-sort').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    state.sort = btn.dataset.sort;
    store('tpb:sort', state.sort);
    if (state.data) renderAtlas(state.data);
  });
  window.addEventListener('hashchange', function () { setView(location.hash.slice(1), false); });

  $('source-link').href = SOURCE_URL;
  $('sheet-close').addEventListener('click', function () { $('sheet').close(); });
  $('sheet').addEventListener('close', function () { player.pause(); stop(); });
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) $('sheet').close(); });

  // New detections arrive every few minutes; keep an open page current.
  setInterval(function () { if (!document.hidden) load(true); }, REFRESH_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(false); });

  ensureMap();
  setView(location.hash.slice(1), false);
  setWindow(state.win);
})();
