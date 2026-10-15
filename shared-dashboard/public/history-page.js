// Shared by the Price history and Deviation history pages. <body data-mode="price|deviation">
// picks what each chart and table shows; everything else (range picker, loading, backfill
// polling, tooltips, CSV) is the same.
(() => {
    const $ = id => document.getElementById(id);
    const DAY_MS = 86400000;
    const ICT_OFFSET_MS = 7 * 3600000;
    const MAX_DAYS = 90;
    const RANGE_KEY = 'history_range_days';
    const MODE = document.body.dataset.mode === 'deviation' ? 'deviation' : 'price';

    function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }

    // --- formatting (Bangkok time) ---
    const fmt = (ms, opts) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour12: false, ...opts });
    const fmtFull = ms => fmt(ms, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' ICT';
    const fmtDay = ms => fmt(ms, { day: 'numeric', month: 'short' });
    const fmtDayTime = ms => fmt(ms, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const fmtBankDate = key => new Date(key + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
    const isNum = n => n !== null && n !== undefined && isFinite(n);
    const fmtPrice = n => !isNum(n) ? '–' : n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    const fmtPct = n => !isNum(n) ? '–' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
    const ictDateKey = ms => new Date(ms + ICT_OFFSET_MS).toISOString().slice(0, 10);
    const ictMidnight = key => Date.parse(key + 'T00:00:00Z') - ICT_OFFSET_MS;

    let thresholds = { yellow: 2, red: 4 };
    const classify = dev => !isNum(dev) ? 'none' : Math.abs(dev) > thresholds.red ? 'crit' : Math.abs(dev) > thresholds.yellow ? 'warn' : 'ok';
    const statusLabel = s => ({ crit: `Over ${thresholds.red}%`, warn: `Over ${thresholds.yellow}%`, ok: `Within ${thresholds.yellow}%`, none: 'No data' }[s]);

    // What each mode plots.
    const VIEW = {
        price: {
            value: p => p.price,
            fmt: fmtPrice,
            sub: () => 'THBT per 1 token',
            empty: hasPoints => hasPoints ? 'No trades in this range yet' : 'No captures in this range yet',
            label: 'price history',
        },
        deviation: {
            value: p => p.dev,
            fmt: fmtPct,
            sub: pair => `vs ${pair.currency} Bank Rate`,
            empty: hasPoints => hasPoints ? 'No Bank Rate for this range yet' : 'No captures in this range yet',
            label: 'deviation history',
        },
    }[MODE];

    // --- state ---
    let current = null;          // { days } or { from, to }
    let lastData = null;
    let pollTimer = null;
    let pollCount = 0;
    let requestSeq = 0;

    function showStatus(type, text) {
        const area = $('statusArea');
        area.textContent = '';
        if (!text) return;
        const div = document.createElement('div');
        div.className = `status-msg ${type}`;
        div.textContent = text;
        area.appendChild(div);
    }

    const rangeFor = (sel, now) => sel.days ? { from: now - sel.days * DAY_MS, to: now } : { from: sel.from, to: sel.to };

    // --- range controls ---
    function setPressed(value) {
        document.querySelectorAll('.range button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.days === value)));
        $('customForm').classList.toggle('open', value === 'custom');
    }

    function initCustomInputs() {
        const now = Date.now();
        const minKey = ictDateKey(now - MAX_DAYS * DAY_MS);
        const maxKey = ictDateKey(now);
        ['fromDate', 'toDate'].forEach(id => { $(id).min = minKey; $(id).max = maxKey; });
        if (!$('toDate').value) $('toDate').value = maxKey;
        if (!$('fromDate').value) $('fromDate').value = ictDateKey(now - 7 * DAY_MS);
    }

    document.querySelectorAll('.range button').forEach(b => b.addEventListener('click', () => {
        const v = b.dataset.days;
        setPressed(v);
        if (v === 'custom') { initCustomInputs(); $('fromDate').focus(); return; }
        $('rangeError').textContent = '';
        storageSet(RANGE_KEY, v);
        select({ days: Number(v) });
    }));

    $('customForm').addEventListener('submit', e => {
        e.preventDefault();
        const now = Date.now();
        const fromKey = $('fromDate').value, toKey = $('toDate').value;
        if (!fromKey || !toKey) { $('rangeError').textContent = 'Pick both dates.'; return; }
        const earliest = now - MAX_DAYS * DAY_MS;
        let from = ictMidnight(fromKey);
        const to = Math.min(ictMidnight(toKey) + DAY_MS - 1, now);
        if (ictMidnight(fromKey) + DAY_MS <= earliest) { $('rangeError').textContent = `History only goes back ${MAX_DAYS} days (to ${fmtDay(earliest)}).`; return; }
        if (from > to) { $('rangeError').textContent = 'The start date must be on or before the end date.'; return; }
        from = Math.max(from, earliest);
        if (to - from > MAX_DAYS * DAY_MS) { $('rangeError').textContent = `Pick a range of at most ${MAX_DAYS} days.`; return; }
        $('rangeError').textContent = '';
        select({ from, to });
    });

    // --- data ---
    class SessionExpired extends Error {}

    async function fetchHistory(from, to) {
        const qs = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
        let res;
        try {
            res = await fetch('/api/history?' + qs, { redirect: 'manual', cache: 'no-store', credentials: 'same-origin' });
        } catch (e) { throw new Error('Network error. Check your connection.'); }
        if (res.type === 'opaqueredirect') throw new SessionExpired('Your sign-in has expired. Reload the page to sign in again.');
        let body;
        try { body = await res.json(); } catch (e) { throw new SessionExpired('Your sign-in has expired. Reload the page to sign in again.'); }
        if (res.status === 401 || res.status === 403) {
            throw new SessionExpired(body.authMode === 'link'
                ? 'Your access link has been turned off. Ask the dashboard owner for a new link.'
                : 'Your sign-in has expired. Reload the page to sign in again.');
        }
        if (!res.ok) throw new Error(body.error || `Server returned HTTP ${res.status}`);
        return body;
    }

    async function select(sel) {
        current = sel;
        clearTimeout(pollTimer);
        pollCount = 0;
        await load();
    }

    async function load() {
        const seq = ++requestSeq;
        const { from, to } = rangeFor(current, Date.now());
        $('stage').classList.add('loading');
        try {
            const data = await fetchHistory(from, to);
            if (seq !== requestSeq) return;      // a newer range was picked meanwhile
            lastData = data;
            if (data.thresholds) thresholds = data.thresholds;
            $('viewer').textContent = data.viewer ? `Signed in as ${data.viewer}` : '';
            render(data);
            if (data.backfilling && pollCount < 30) {
                const what = data.missingMarks
                    ? `${data.missingMarks} of ${data.expectedMarks} captures still to load`
                    : 'loading Bank Rates';
                showStatus('info', `Filling in older history (${what}). This page updates by itself; it takes about a minute.`);
                pollCount++;
                pollTimer = setTimeout(load, 8000);
            } else if (data.missingMarks) {
                showStatus('info', `${data.missingMarks} capture${data.missingMarks === 1 ? ' is' : 's are'} still missing in this range. They'll be filled in at the next scheduled capture.`);
            } else {
                showStatus('', '');
            }
        } catch (err) {
            if (seq !== requestSeq) return;
            showStatus('error', err instanceof SessionExpired ? err.message : `Couldn't load ${VIEW.label}: ${err.message}`);
        } finally {
            if (seq === requestSeq) $('stage').classList.remove('loading');
        }
    }

    // --- rendering ---
    function render(data) {
        const total = Object.values(data.series).reduce((n, s) => Math.max(n, s.length), 0);
        $('rangeLabel').textContent = `${fmtDayTime(data.from)} – ${fmtDayTime(data.to)} ICT`;
        $('captureCount').textContent = `${total} per pair`;
        renderCharts(data);
        renderTable(data);
    }

    function niceTicks(min, max, count) {
        if (min === max) { const pad = Math.abs(min) * 0.002 || 0.01; min -= pad; max += pad; }
        const step0 = (max - min) / count;
        const mag = Math.pow(10, Math.floor(Math.log10(step0)));
        const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || 10 * mag;
        const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
        const ticks = [];
        for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
        return { lo, hi, ticks, step };
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const el = (name, attrs = {}, parent) => {
        const n = document.createElementNS(SVG_NS, name);
        Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
        if (parent) parent.appendChild(n);
        return n;
    };
    const div = (cls, text) => { const d = document.createElement('div'); if (cls) d.className = cls; if (text !== undefined) d.textContent = text; return d; };

    function cardSummary(pair, points) {
        const latest = div('latest');
        const valued = points.filter(pt => isNum(VIEW.value(pt)));
        const last = valued[valued.length - 1];
        if (MODE === 'price') {
            const first = valued[0];
            latest.appendChild(div('value', last ? fmtPrice(last.price) : '–'));
            let change = last ? `at ${fmtDayTime(last.t)}` : '';
            if (last && first && first !== last) {
                const pct = (last.price - first.price) / first.price * 100;
                change = `${pct > 0 ? '▲ +' : pct < 0 ? '▼ ' : ''}${pct.toFixed(2)}% over this range`;
            }
            latest.appendChild(div('change', change));
            return { latest, extra: null, last };
        }
        // deviation: latest value + status, then range and how often it went over each threshold
        latest.appendChild(div('value', last ? fmtPct(last.dev) : '–'));
        const row = div('status-row');
        if (last) {
            const pill = document.createElement('span');
            pill.className = `pill ${classify(last.dev)}`;
            pill.textContent = statusLabel(classify(last.dev));
            row.appendChild(pill);
        }
        latest.appendChild(row);
        let extra = null;
        if (valued.length) {
            const devs = valued.map(p => p.dev);
            const over2 = valued.filter(p => classify(p.dev) !== 'ok').length;
            const over4 = valued.filter(p => classify(p.dev) === 'crit').length;
            extra = div('meta-line',
                `Range ${fmtPct(Math.min(...devs))} to ${fmtPct(Math.max(...devs))} · over ${thresholds.yellow}%: ${over2} of ${valued.length} · over ${thresholds.red}%: ${over4}`);
        }
        return { latest, extra, last };
    }

    function renderCharts(data) {
        const host = $('charts');
        host.textContent = '';
        data.pairs.forEach(p => {
            const points = data.series[p.symbol] || [];
            const card = document.createElement('section');
            card.className = 'card';
            const head = div('card-head');
            const h2 = document.createElement('h2');
            h2.textContent = `THBT / ${p.symbol}`;
            const sub = document.createElement('span');
            sub.className = 'sub';
            sub.textContent = VIEW.sub(p);
            h2.appendChild(sub);
            const { latest, extra, last } = cardSummary(p, points);
            head.append(h2, latest);
            card.appendChild(head);
            if (extra) card.appendChild(extra);

            const chart = div('chart');
            chart.tabIndex = 0;
            chart.setAttribute('role', 'img');
            chart.setAttribute('aria-label', `THBT / ${p.symbol} ${VIEW.label}, ${points.length} captures${last ? `, latest ${VIEW.fmt(VIEW.value(last))}` : ''}. Use the left and right arrow keys to read values.`);
            card.appendChild(chart);
            host.appendChild(card);
            drawChart(chart, points);
        });
    }

    function drawChart(box, points) {
        box.textContent = '';
        const valued = points.filter(p => isNum(VIEW.value(p)));
        if (!valued.length) {
            box.appendChild(div('no-data', VIEW.empty(points.length > 0)));
            return;
        }
        const W = box.clientWidth || 460, H = box.clientHeight || 190;
        const m = { top: 10, right: MODE === 'deviation' ? 34 : 12, bottom: 26, left: 58 };
        const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
        const vals = valued.map(VIEW.value);
        let lo = Math.min(...vals), hi = Math.max(...vals);
        if (MODE === 'deviation') {
            // Always show zero and the yellow band so the thresholds give the line context.
            lo = Math.min(lo, -thresholds.yellow - 0.5);
            hi = Math.max(hi, thresholds.yellow + 0.5);
        }
        const yt = niceTicks(lo, hi, 4);
        const t0 = points[0].t, t1 = points[points.length - 1].t;
        const x = t => t1 === t0 ? m.left + iw / 2 : m.left + (t - t0) / (t1 - t0) * iw;
        const y = v => m.top + ih - (v - yt.lo) / (yt.hi - yt.lo) * ih;

        const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, box);
        const decimals = MODE === 'deviation'
            ? (yt.step >= 1 ? 0 : 1)
            : Math.max(2, Math.min(4, -Math.floor(Math.log10(yt.step)) + 1));
        yt.ticks.forEach(v => {
            el('line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
            const lbl = el('text', { x: m.left - 8, y: y(v), 'text-anchor': 'end', 'dominant-baseline': 'middle', fill: 'var(--axis-ink)', 'font-size': 11 }, svg);
            lbl.textContent = MODE === 'deviation' ? `${v > 0 ? '+' : ''}${v.toFixed(decimals)}%` : v.toFixed(decimals);
        });

        if (MODE === 'deviation') {
            // Zero line, then dashed threshold lines in the status colours, labelled at the right.
            el('line', { x1: m.left, x2: W - m.right, y1: y(0), y2: y(0), stroke: 'var(--axis-ink)', 'stroke-width': 1 }, svg);
            [[thresholds.yellow, 'var(--warn-dot)'], [thresholds.red, 'var(--crit-dot)']].forEach(([t, color]) => {
                [t, -t].forEach(v => {
                    if (v < yt.lo || v > yt.hi) return;
                    el('line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, svg);
                    if (yt.ticks.some(t => Math.abs(t - v) < 1e-9)) return;   // the axis already labels it
                    const lbl = el('text', { x: W - m.right + 4, y: y(v), 'dominant-baseline': 'middle', fill: 'var(--axis-ink)', 'font-size': 10 }, svg);
                    lbl.textContent = `${v > 0 ? '+' : '−'}${Math.abs(v)}%`;
                });
            });
        }

        // x labels: about 5, at capture times
        const spanDays = (t1 - t0) / DAY_MS;
        const nTicks = Math.min(points.length, iw < 360 ? 3 : 5);
        const seen = new Set();
        for (let i = 0; i < nTicks; i++) {
            const idx = nTicks === 1 ? 0 : Math.round(i * (points.length - 1) / (nTicks - 1));
            if (seen.has(idx)) continue;
            seen.add(idx);
            const t = points[idx].t;
            const anchor = i === 0 ? 'start' : i === nTicks - 1 ? 'end' : 'middle';
            const lbl = el('text', { x: x(t), y: H - 6, 'text-anchor': anchor, fill: 'var(--axis-ink)', 'font-size': 11 }, svg);
            lbl.textContent = spanDays > 3 ? fmtDay(t) : fmtDayTime(t);
        }

        // line, broken at gaps
        let d = '';
        let pen = false;
        points.forEach(p => {
            const v = VIEW.value(p);
            if (!isNum(v)) { pen = false; return; }
            d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
            pen = true;
        });
        el('path', { d, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
        if (valued.length <= 12) valued.forEach(p => el('circle', { cx: x(p.t), cy: y(VIEW.value(p)), r: 4, fill: 'var(--series-1)', stroke: '#fff', 'stroke-width': 2 }, svg));

        // crosshair + tooltip
        const cross = el('line', { y1: m.top, y2: m.top + ih, stroke: 'var(--axis-ink)', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' }, svg);
        const dot = el('circle', { r: 5, fill: 'var(--series-1)', stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }, svg);
        const tip = div('tooltip');
        box.appendChild(tip);
        let active = -1;

        function show(idx) {
            if (idx < 0 || idx >= points.length) return;
            active = idx;
            const p = points[idx];
            const v = VIEW.value(p);
            const px = x(p.t);
            cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
            if (isNum(v)) {
                dot.setAttribute('cx', px); dot.setAttribute('cy', y(v)); dot.setAttribute('visibility', 'visible');
            } else dot.setAttribute('visibility', 'hidden');
            tip.textContent = '';
            const tv = div('tv');
            const key = document.createElement('span'); key.className = 'key';
            const val = document.createElement('span');
            val.textContent = isNum(v) ? VIEW.fmt(v) : (p.price === null ? 'No trades yet' : 'No Bank Rate yet');
            tv.append(key, val);
            tip.append(tv, div('tt', fmtFull(p.t)));
            if (MODE === 'deviation') {
                if (isNum(p.price)) tip.appendChild(div('ta', `Uniswap ${fmtPrice(p.price)}`));
                if (isNum(p.bank)) tip.appendChild(div('ta', `Bank Rate ${fmtPrice(p.bank)} (${fmtBankDate(p.bankDate)})`));
                if (isNum(p.dev)) tip.appendChild(div('ta', statusLabel(classify(p.dev))));
            } else if (p.asOf) {
                tip.appendChild(div('ta', `Last trade ${fmtDayTime(p.asOf)}`));
            }
            tip.style.display = 'block';
            const tw = tip.offsetWidth;
            let left = px + 12;
            if (left + tw > W) left = px - tw - 12;
            tip.style.left = `${Math.max(0, left)}px`;
        }
        function hide() {
            active = -1;
            cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
            tip.style.display = 'none';
        }
        function nearest(clientX) {
            const r = svg.getBoundingClientRect();
            const px = (clientX - r.left) * (W / r.width);
            let best = 0, bestD = Infinity;
            points.forEach((p, i) => { const dd = Math.abs(x(p.t) - px); if (dd < bestD) { bestD = dd; best = i; } });
            return best;
        }
        box.addEventListener('pointermove', e => show(nearest(e.clientX)));
        box.addEventListener('pointerdown', e => show(nearest(e.clientX)));
        box.addEventListener('pointerleave', hide);
        box.addEventListener('blur', hide);
        box.addEventListener('focus', () => show(points.length - 1));
        box.addEventListener('keydown', e => {
            if (e.key === 'ArrowLeft') { show(Math.max(0, (active < 0 ? points.length : active) - 1)); e.preventDefault(); }
            if (e.key === 'ArrowRight') { show(Math.min(points.length - 1, active + 1)); e.preventDefault(); }
            if (e.key === 'Escape') hide();
        });
    }

    // Rows keyed by capture time: { t: { SYMBOL: point } }
    function byTime(data) {
        const map = new Map();
        data.pairs.forEach(p => (data.series[p.symbol] || []).forEach(pt => {
            if (!map.has(pt.t)) map.set(pt.t, {});
            map.get(pt.t)[p.symbol] = pt;
        }));
        return map;
    }

    function renderTable(data) {
        const head = $('tableHead'), body = $('tableBody');
        head.textContent = ''; body.textContent = '';
        const hr = document.createElement('tr');
        const th0 = document.createElement('th'); th0.textContent = 'Captured at (ICT)'; hr.appendChild(th0);
        data.pairs.forEach(p => { const th = document.createElement('th'); th.className = 'num'; th.textContent = `THBT / ${p.symbol}`; hr.appendChild(th); });
        head.appendChild(hr);

        const rows = byTime(data);
        const times = [...rows.keys()].sort((a, b) => b - a);
        if (!times.length) {
            const tr = document.createElement('tr');
            const td = document.createElement('td'); td.colSpan = data.pairs.length + 1; td.className = 'empty';
            td.textContent = 'No captures in this range yet.';
            tr.appendChild(td); body.appendChild(tr);
            $('csvBtn').disabled = true;
            return;
        }
        const frag = document.createDocumentFragment();
        times.forEach(t => {
            const tr = document.createElement('tr');
            const td0 = document.createElement('td'); td0.textContent = fmtDayTime(t); tr.appendChild(td0);
            data.pairs.forEach(p => {
                const pt = rows.get(t)[p.symbol];
                const v = pt ? VIEW.value(pt) : null;
                const td = document.createElement('td');
                td.className = 'num';
                if (!isNum(v)) td.classList.add('gap');
                else if (MODE === 'deviation' && classify(v) !== 'ok') td.classList.add(classify(v));
                td.textContent = isNum(v) ? VIEW.fmt(v) : '–';
                tr.appendChild(td);
            });
            frag.appendChild(tr);
        });
        body.appendChild(frag);
        $('csvBtn').disabled = false;
    }

    $('csvBtn').addEventListener('click', () => {
        if (!lastData) return;
        const d = lastData;
        const rows = byTime(d);
        const header = ['captured_at_utc', 'captured_at_ict'];
        d.pairs.forEach(p => {
            if (MODE === 'deviation') header.push(`${p.symbol}_deviation_pct`, `${p.symbol}_uniswap`, `${p.symbol}_bank_rate`, `${p.symbol}_bank_rate_date`);
            else header.push(`THBT_per_${p.symbol}`);
        });
        const out = [header];
        const cell = v => isNum(v) ? String(v) : (v || '');
        [...rows.keys()].sort((a, b) => a - b).forEach(t => {
            const line = [new Date(t).toISOString(), new Date(t + ICT_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')];
            d.pairs.forEach(p => {
                const pt = rows.get(t)[p.symbol] || {};
                if (MODE === 'deviation') line.push(isNum(pt.dev) ? pt.dev.toFixed(4) : '', cell(pt.price), cell(pt.bank), cell(pt.bankDate));
                else line.push(cell(pt.price));
            });
            out.push(line);
        });
        const blob = new Blob([out.map(r => r.join(',')).join('\n') + '\n'], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `thbt-${MODE}-history-${ictDateKey(d.from)}-to-${ictDateKey(d.to)}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    // Redraw charts at the new width (labels stay crisp; no stretched SVG).
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (lastData) renderCharts(lastData); }, 150);
    });

    // Start: last-used preset (shared by both history pages), default 7 days.
    const savedDays = storageGet(RANGE_KEY);
    const startDays = ['1', '2', '3', '7'].includes(savedDays) ? savedDays : '7';
    setPressed(startDays);
    select({ days: Number(startDays) });
})();
