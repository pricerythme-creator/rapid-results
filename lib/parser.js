// Reads an Investor Snapshot OCR result (Tesseract words + text) into result data.
(function (root) {
  const MINUS = /^[-–—]/;

  function center(w) { return { x: (w.bbox.x0 + w.bbox.x1) / 2, y: (w.bbox.y0 + w.bbox.y1) / 2 }; }

  // Candidate numeric readings for one value cell. The ₹ glyph is always printed
  // before the number and OCR reads it as a symbol or as a stray leading digit.
  function valueCandidates(text) {
    const m = text.match(/(\d[\d,]*\.\d{2})(?!\d)/);
    if (!m) return null;
    const prefix = text.slice(0, m.index);
    const neg = MINUS.test(prefix) || MINUS.test(text);
    const digits = m[1];
    const hasSymbol = /[^\d\s\-–—,.]/.test(prefix);
    const list = [];
    const num = s => parseFloat(s.replace(/,/g, ''));
    const stripped = digits.replace(/^\d,?/, '');
    const canStrip = !hasSymbol && /^\d/.test(stripped) && /^\d+(,\d+)*\.\d{2}$/.test(stripped);
    // Preferred reading first
    if (canStrip) { list.push({ v: num(stripped), stripped: true }); list.push({ v: num(digits), stripped: false }); }
    else list.push({ v: num(digits), stripped: false });
    return { list, neg };
  }

  function parseGrowth(words) {
    const sorted = words.slice().sort((a, b) => center(a).y - center(b).y || center(a).x - center(b).x);
    const text = sorted.map(w => w.text).join(' ');
    const kw = [];
    sorted.forEach(w => {
      if (/oss|egat/i.test(w.text)) kw.push(-1);
      else if (/rofit|ositi/i.test(w.text)) kw.push(1);
    });
    if (kw.length >= 2) return { type: 'turn', from: kw[0], to: kw[kw.length - 1] };
    const p = text.match(/([+\-–—“"~]?)\s*(\d[\d,]*(?:\.\d)?)\s*%/);
    if (p) {
      const s = p[1] === '+' ? 1 : (p[1] && p[1] !== '“' && p[1] !== '"' && p[1] !== '~' ? -1 : 0);
      return { type: 'pct', abs: parseFloat(p[2].replace(/,/g, '')), sign: s };
    }
    if (kw.length === 1) return { type: 'half', sign: kw[0] };
    return null;
  }

  function checkGrowth(g, prev, cur) {
    if (!g) return 0;
    if (g.type === 'turn') return (Math.sign(prev) === g.from && Math.sign(cur) === g.to) ? 1 : -1;
    if (g.type === 'half') return Math.sign(cur) === g.sign ? 0.5 : -1;
    if (prev === 0) return -1;
    if (prev < 0 && cur >= 0 || prev >= 0 && cur < 0) return -1; // would have printed a turnaround
    // Values are rounded to 0.01 Cr, so the true growth lies in a range; the image's % came from exact figures.
    const ps = [];
    [-0.005, 0.005].forEach(dp => [-0.005, 0.005].forEach(dc => {
      const pv = prev + dp, cv = cur + dc;
      if (pv !== 0 && Math.sign(pv) === Math.sign(prev)) ps.push((cv - pv) / Math.abs(pv) * 100);
    }));
    const p = (cur - prev) / Math.abs(prev) * 100;
    if (g.sign && Math.sign(p) !== g.sign && Math.abs(p) > 0.05) return -1;
    const loAbs = Math.min(Math.abs(p), ...ps.map(Math.abs)), hi = Math.max(Math.abs(p), ...ps.map(Math.abs));
    return (g.abs >= loAbs - 0.06 && g.abs <= hi + 0.06) ? 1 : -1;
  }

  // Try every reading of the three cells; keep the one that agrees with printed YoY/QoQ.
  function solveRow(cells, yoy, qoq, allowNeg) {
    const opts = cells.map(c => {
      const o = [];
      c.list.forEach((r, i) => {
        if (c.neg) o.push({ v: -r.v, pen: i * 0.1 });
        else {
          o.push({ v: r.v, pen: i * 0.1 });
          if (allowNeg) o.push({ v: -r.v, pen: i * 0.1 + 0.3 }); // minus possibly missed
        }
      });
      return o;
    });
    const results = [];
    for (const a of opts[0]) for (const b of opts[1]) for (const c of opts[2]) {
      const s = checkGrowth(yoy, a.v, c.v) + checkGrowth(qoq, b.v, c.v) - a.pen - b.pen - c.pen;
      results.push({ vals: [a.v, b.v, c.v], s });
    }
    results.sort((x, y) => y.s - x.s);
    const best = results[0];
    // A cell is uncertain if another equally-consistent reading gives it a different value.
    const top = results.filter(r => Math.abs((r.s + 0.0001) - best.s) < 0.65 &&
      checkGrowth(yoy, r.vals[0], r.vals[2]) === checkGrowth(yoy, best.vals[0], best.vals[2]) &&
      checkGrowth(qoq, r.vals[1], r.vals[2]) === checkGrowth(qoq, best.vals[1], best.vals[2]));
    const amb = i => top.some(r => r.vals[i] !== best.vals[i]);
    // 'm' = does not match the printed YoY/QoQ, 'u' = only a Loss/Profit label to check against, '' = confirmed
    const cy = checkGrowth(yoy, best.vals[0], best.vals[2]), cq = checkGrowth(qoq, best.vals[1], best.vals[2]);
    const failY = yoy && cy !== 1, failQ = qoq && cq !== 1;
    const pctY = yoy && cy === 1 && yoy.type === 'pct', pctQ = qoq && cq === 1 && qoq.type === 'pct';
    const check = [
      failY ? 'm' : (!pctY || amb(0)) ? 'u' : '',
      failQ ? 'm' : (!pctQ || amb(1)) ? 'u' : '',
      (failY && failQ) ? 'm' : ((pctY || pctQ) && !amb(2)) ? '' : 'u',
    ];
    return { vals: best.vals, check };
  }

  function showGrowth(g) {
    if (g.type === 'pct') return (g.sign > 0 ? '+' : g.sign < 0 ? '-' : '') + g.abs.toFixed(1) + '%';
    const w = v => v < 0 ? 'Loss' : 'Profit';
    if (g.type === 'turn') return `${w(g.from)} → ${w(g.to)}`;
    return w(g.sign);
  }
  function showCalc(prev, cur) {
    if (prev < 0 && cur >= 0) return 'Loss → Profit';
    if (prev >= 0 && cur < 0) return 'Profit → Loss';
    if (prev === 0) return '–';
    const p = (cur - prev) / Math.abs(prev) * 100;
    return (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
  }

  function prevQuarter(q, fy, back) {
    let qq = q - back, f = fy;
    while (qq < 1) { qq += 4; f -= 1; }
    return `Q${qq} FY${String(f).slice(-2)}`;
  }

  function parseSnapshot(words, text, fileName) {
    words = words.filter(w => w.text && w.text.trim());
    const out = { name: '', date: '', basis: '', q: '', periods: null, sales: null, pbt: null, np: null, check: {}, problems: [] };

    // Footer: basis, quarter, date
    const T = text.toUpperCase();
    const b = T.match(/STANDALONE|CONSOLIDATED/);
    if (b) out.basis = b[0][0] + b[0].slice(1).toLowerCase(); else out.problems.push('Standalone/Consolidated not found');
    const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const d = T.match(/(\d{1,2})\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(\d{2,4})?/);
    const q = T.match(/Q\s*([1-4])\s*F[YV]\s*(?:20)?(\d{2})(?!\d)/g);
    let qn = null, fy = null;
    if (q) {
      // Use the quarter in the footer (FY written with 4 digits), else the latest found
      const all = q.map(s => s.match(/Q\s*([1-4])\s*F[YV]\s*(?:20)?(\d{2})/)).map(m => [+m[1], 2000 + +m[2]]);
      all.sort((a, c) => (c[1] * 4 + c[0]) - (a[1] * 4 + a[0]));
      [qn, fy] = all[0];
      out.q = `Q${qn} FY${String(fy).slice(-2)}`;
      out.periods = [prevQuarter(qn, fy, 4), prevQuarter(qn, fy, 1), out.q];
    } else out.problems.push('Quarter not found');
    if (d) {
      let y = d[3] && d[3].length === 4 ? +d[3] : null;
      if (!y && qn) {
        // Results come out within a few months after the quarter ends
        const endMonth = [6, 9, 12, 3][qn - 1], endYear = qn === 4 ? fy : fy - 1;
        const m = MONTHS.indexOf(d[2]) + 1;
        y = m > endMonth ? endYear : endYear + 1;
        out.problems.push(`Date year not readable, set to ${y}. Check it`);
      }
      if (y) out.date = `${d[1].padStart(2, '0')} ${d[2][0]}${d[2].slice(1).toLowerCase()} ${y}`;
      else out.problems.push('Date not found');
    } else out.problems.push('Date not found');

    // Company name from file name, e.g. SWAN_DEFENCE_Q2FY2027.png → Swan Defence
    if (fileName) {
      out.name = fileName.replace(/\.[^.]+$/, '').replace(/[_-]?Q[1-4]\s*FY\s*\d{2,4}.*$/i, '')
        .replace(/[_-]+/g, ' ').trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    // Row labels
    const labelOf = (re, next) => {
      const c = words.filter((w, i) => re.test(w.text.replace(/[^A-Za-z]/g, '')) &&
        (!next || (words[i + 1] && next.test(words[i + 1].text))));
      c.sort((a, z) => a.bbox.x0 - z.bbox.x0);
      return c[0];
    };
    const labels = {
      sales: labelOf(/^sales$/i),
      pbt: labelOf(/^PBT$/),
      np: labelOf(/^Net$/i, /rofit/i),
      eps: labelOf(/^EPS/),
    };
    const rowKeys = Object.keys(labels).filter(k => labels[k]);
    const rowY = {}; rowKeys.forEach(k => rowY[k] = center(labels[k]).y);
    const nearestRow = w => {
      const y = center(w).y; let best = null, bd = 1e9;
      rowKeys.forEach(k => { const dd = Math.abs(rowY[k] - y); if (dd < bd) { bd = dd; best = k; } });
      return { row: best, dist: bd };
    };
    const ys = rowKeys.map(k => rowY[k]).sort((a, z) => a - z);
    const gap = ys.length > 1 ? (ys[ys.length - 1] - ys[0]) / (ys.length - 1) : 60;

    const rows = {};
    rowKeys.forEach(k => {
      const lab = labels[k];
      const mine = words.filter(w => w.bbox.x0 > lab.bbox.x1 && (() => { const n = nearestRow(w); return n.row === k && n.dist < gap * 0.6; })());
      mine.sort((a, z) => a.bbox.x0 - z.bbox.x0);
      const vals = [];
      const rest = [];
      mine.forEach(w => {
        if (vals.length < 3 && !/%/.test(w.text.replace(/^[^\d]*/, '')) && valueCandidates(w.text)) vals.push(w);
        else if (vals.length === 3 && /\d%|oss|rofit|egat|ositi/i.test(w.text)) rest.push(w);
      });
      rows[k] = { vals, rest };
    });

    // Split growth words into YoY and QoQ columns by x position
    const gx = [];
    ['sales', 'pbt', 'np'].forEach(k => rows[k] && rows[k].rest.forEach(w => gx.push(center(w).x)));
    gx.sort((a, z) => a - z);
    let split = null, bg = 0;
    for (let i = 1; i < gx.length; i++) if (gx[i] - gx[i - 1] > bg) { bg = gx[i] - gx[i - 1]; split = (gx[i] + gx[i - 1]) / 2; }

    ['sales', 'pbt', 'np'].forEach(k => {
      const r = rows[k];
      if (!r || r.vals.length < 3) { out.problems.push(`${k === 'np' ? 'Net Profit' : k === 'pbt' ? 'PBT' : 'Sales'} row not read`); out[k] = [0, 0, 0]; out.check[k] = ['m', 'm', 'm']; return; }
      const cells = r.vals.map(w => valueCandidates(w.text));
      const yoyW = split == null ? r.rest : r.rest.filter(w => center(w).x < split);
      const qoqW = split == null ? [] : r.rest.filter(w => center(w).x >= split);
      const gY = parseGrowth(yoyW), gQ = parseGrowth(qoqW);
      const res = solveRow(cells, gY, gQ, k !== "sales");
      out[k] = res.vals.map(v => Math.round(v * 100) / 100);
      out.check[k] = res.check;
      const label = k === 'np' ? 'Net Profit' : k === 'pbt' ? 'PBT' : 'Sales';
      [[gY, 0, 'YoY'], [gQ, 1, 'QoQ']].forEach(([g, i, name]) => {
        if (!g || checkGrowth(g, res.vals[i], res.vals[2]) === 1) return;
        out.problems.push(`${label} ${name}: image shows ${showGrowth(g)}, these numbers give ${showCalc(res.vals[i], res.vals[2])}`);
      });
    });
    return out;
  }

  const api = { parseSnapshot, solveRow, valueCandidates, parseGrowth, checkGrowth };
  if (typeof module !== 'undefined') module.exports = api; else root.SnapshotParser = api;
})(this);
