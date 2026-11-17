// Twin Peaks BirdNET - public page. Reads /api/summary; nothing else.
(function () {
  'use strict';

  // Change this to your GitHub repository once it exists.
  var SOURCE_URL = 'https://github.com/iloveburritos/twin-peaks-birdnet';
  // General Twin Peaks area only - deliberately not the station's location.
  var AREA = { lat: 37.7544, lon: -122.4477, radius: 750 };

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  var player = new Audio();
  var playingRow = null;
  player.addEventListener('ended', stop);
  player.addEventListener('error', stop);

  function stop() {
    if (playingRow) playingRow.classList.remove('playing');
    playingRow = null;
  }

  function fmtWhen(d) {
    var date = new Date(d.date + 'T' + d.time);
    var day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    var time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return day + ' · ' + time;
  }

  function hourLabel(h) {
    return (h % 12 || 12) + (h < 12 ? 'am' : 'pm');
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

  function detectionRow(d, showName) {
    var li = el('li');
    var row = el('button', 'row' + (d.clip ? '' : ' noclip'));
    row.type = 'button';
    row.append(el('span', 'play', d.clip ? '▶' : '–'));
    var name = el('span', 'name', showName ? d.com : fmtWhen(d));
    row.append(name);
    var conf = d.conf != null ? Math.round(d.conf * 100) + '%' : '';
    row.append(el('span', 'when mono', showName ? fmtWhen(d) : conf + ' match'));
    if (d.clip) {
      row.setAttribute('aria-label', 'Play recording of ' + d.com + ', ' + fmtWhen(d));
      row.addEventListener('click', function () {
        if (playingRow === row) { player.pause(); stop(); return; }
        stop();
        player.src = d.clip;
        player.play().catch(stop);
        playingRow = row;
        row.classList.add('playing');
      });
    } else {
      row.disabled = true;
    }
    li.append(row);
    return li;
  }

  function openSheet(s) {
    $('sheet-name').textContent = s.com;
    $('sheet-sci').textContent = s.sci;
    $('sheet-meta').textContent = s.n + (s.n === 1 ? ' detection' : ' detections') +
      ' · first heard ' + s.first_date;
    var img = $('sheet-img');
    img.hidden = false;
    img.src = s.img;
    img.alt = 'Illustration of ' + s.com;
    img.onerror = function () { img.hidden = true; };
    var list = $('sheet-list');
    list.replaceChildren(el('li', 'soft small mono', 'Loading…'));
    $('sheet').showModal();
    fetch('/api/species?sci=' + encodeURIComponent(s.sci))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        list.replaceChildren.apply(list, data.detections.map(function (d) {
          d.com = s.com;
          return detectionRow(d, false);
        }));
      })
      .catch(function () { list.replaceChildren(el('li', 'soft', 'Could not load recordings.')); });
  }

  function renderCollage(species) {
    var week = species.filter(function (s) { return s.n_week > 0; });
    var pool = (week.length ? week : species).slice(0, 28);
    var max = Math.max.apply(null, pool.map(function (s) { return s.n_week || s.n; }).concat([1]));
    var mobile = window.innerWidth < 760;
    $('collage-note').textContent = week.length
      ? week.length + ' species in the last 7 days'
      : (species.length ? 'Nothing new this week, showing all-time visitors' : '');
    $('collage').replaceChildren.apply($('collage'), pool.map(function (s, i) {
      var share = Math.sqrt((s.n_week || s.n) / max);
      var base = mobile ? 92 : 120, span = mobile ? 70 : 130;
      var b = el('button', 'bird');
      b.type = 'button';
      b.style.setProperty('--w', Math.round(base + span * share) + 'px');
      b.style.setProperty('--r', (((i * 37) % 9) - 4) + 'deg');
      b.setAttribute('aria-label', s.com + ', heard ' + (s.n_week || s.n) + ' times');
      b.append(birdImage(s.slug, '', s.com.charAt(0)));
      b.append(el('span', null, s.com));
      b.addEventListener('click', function () { openSheet(s); });
      return b;
    }));
  }

  function renderTiles(data) {
    var t = data.totals || {};
    var peak = data.hourly.indexOf(Math.max.apply(null, data.hourly));
    var latest = data.recent[0];
    var tiles = [
      ['Detections', (t.detections || 0).toLocaleString(), t.first_date ? 'since ' + t.first_date : ''],
      ['Species', String(t.species || 0), 'identified by sound'],
      ['Most recent', latest ? latest.com : '–', latest ? fmtWhen(latest) : ''],
      ['Busiest hour', t.detections ? hourLabel(peak) : '–', 'Pacific time'],
    ];
    $('tiles').replaceChildren.apply($('tiles'), tiles.map(function (x) {
      var tile = el('div', 'tile');
      tile.append(el('div', 'label mono', x[0]), el('div', 'value', x[1]), el('div', 'sub mono', x[2]));
      return tile;
    }));
  }

  function renderBars(target, values, labels) {
    var max = Math.max.apply(null, values.concat([1]));
    $(target).replaceChildren.apply($(target), values.map(function (v, i) {
      var bar = el('div');
      bar.style.height = Math.max(2, Math.round((v / max) * 100)) + '%';
      bar.title = labels[i] + ': ' + v;
      return bar;
    }));
  }

  function renderSpecies(species) {
    $('species-note').textContent = species.length + ' species';
    $('species').replaceChildren.apply($('species'), species.map(function (s) {
      var b = el('button', 'sp');
      b.type = 'button';
      b.append(birdImage(s.slug, '', s.com.charAt(0)));
      var text = el('div');
      text.append(el('div', 'name', s.com), el('div', 'sci', s.sci));
      b.append(text, el('span', 'n mono', '×' + s.n));
      b.addEventListener('click', function () { openSheet(s); });
      return b;
    }));
  }

  function renderMap() {
    if (!window.L) return;
    var map = L.map('map', { scrollWheelZoom: false, zoomControl: true, attributionControl: true })
      .setView([AREA.lat, AREA.lon], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 16,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    L.circle([AREA.lat, AREA.lon], {
      radius: AREA.radius, color: '#4a3f31', weight: 1.5, fillColor: '#4a3f31', fillOpacity: 0.14,
    }).addTo(map).bindTooltip('Twin Peaks', { permanent: true, direction: 'top', className: 'mono' });
  }

  $('source-link').href = SOURCE_URL;
  $('sheet-close').addEventListener('click', function () { $('sheet').close(); });
  $('sheet').addEventListener('close', function () { player.pause(); stop(); });
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) $('sheet').close(); });
  renderMap();

  fetch('/api/summary')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var has = data.species.length > 0;
      $('empty').hidden = has;
      renderCollage(data.species);
      renderTiles(data);
      $('latest').replaceChildren.apply($('latest'), data.recent.map(function (d) { return detectionRow(d, true); }));
      renderBars('daily', data.daily.map(function (d) { return d.n; }),
        data.daily.map(function (d) { return d.date + ' (' + d.species + ' species)'; }));
      var hours = data.hourly.map(function (_, h) { return hourLabel(h); });
      renderBars('hourly', data.hourly, hours);
      renderSpecies(data.species);
    })
    .catch(function () {
      $('empty').hidden = false;
      $('empty').textContent = 'The bird log could not be loaded just now. Please try again in a minute.';
    });
})();
