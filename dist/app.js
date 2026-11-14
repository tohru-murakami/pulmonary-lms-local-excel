(() => {
  'use strict';

  const TOP_SHEET = '基準値';
  const REQUIRED_SHEETS = ['基準値', '男性', '女性', 'spline'];
  const INPUT_CELLS = { sex: 'B2', age: 'B4', height: 'B6', fev1: 'B8', fvc: 'B10', vc: 'B12', ratio: 'B14' };
  const OUTPUT_CELLS = {
    fev1: { M: 'E3', LLN: 'E5', Z: 'E6' },
    fvc: { M: 'H3', LLN: 'H5', Z: 'H6' },
    vc: { M: 'E8', LLN: 'E10', Z: 'E11' },
    ratio: { M: 'H8', LLN: 'H10', Z: 'H11' }
  };
  const DESCRIPTIONS = {
    fev1: '1秒量。最大吸気後、努力性呼出の最初の1秒間に呼出した量。',
    fvc: '努力性肺活量。最大吸気位から最大努力で最後まで呼出した量。',
    vc: '肺活量。最大吸気位からゆっくり最大呼出した量。',
    ratio: '1秒率。FEV₁をFVCで割った比。',
    pvc: '予測肺活量に対する実測VCの割合。VCから自動計算でき、直接入力もできます。'
  };
  const IDS = ['fev1', 'fvc', 'vc', 'ratio', 'pvc'];
  const LABELS = { fev1: 'FEV₁', fvc: 'FVC', vc: 'VC', ratio: 'FEV₁/FVC', pvc: '%VC' };

  class ExcelError extends Error {
    constructor(code, message = '') {
      super(message || code);
      this.name = 'ExcelError';
      this.code = code;
    }
  }

  function tokenize(source) {
    const tokens = [];
    let i = 0;
    while (i < source.length) {
      const rest = source.slice(i);
      const ws = rest.match(/^\s+/);
      if (ws) { i += ws[0].length; continue; }
      const two = source.slice(i, i + 2);
      if (['<>', '<=', '>='].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
      const ch = source[i];
      if ('+-*/^=<>(),:!'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i += 1; continue; }
      if (ch === '"') {
        let value = ''; i += 1;
        while (i < source.length) {
          if (source[i] === '"' && source[i + 1] === '"') { value += '"'; i += 2; continue; }
          if (source[i] === '"') { i += 1; break; }
          value += source[i++];
        }
        tokens.push({ type: 'string', value });
        continue;
      }
      if (ch === "'") {
        let value = ''; i += 1;
        while (i < source.length) {
          if (source[i] === "'" && source[i + 1] === "'") { value += "'"; i += 2; continue; }
          if (source[i] === "'") { i += 1; break; }
          value += source[i++];
        }
        tokens.push({ type: 'ident', value });
        continue;
      }
      const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/);
      if (number) { tokens.push({ type: 'number', value: Number(number[0]) }); i += number[0].length; continue; }
      const cell = rest.match(/^\$?[A-Za-z]{1,3}\$?\d+/);
      if (cell) { tokens.push({ type: 'cell', value: cell[0].replace(/\$/g, '').toUpperCase() }); i += cell[0].length; continue; }
      const ident = rest.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
      if (ident) { tokens.push({ type: 'ident', value: ident[0] }); i += ident[0].length; continue; }
      const sheet = rest.match(/^[^\s+\-*/^=<>(),:!]+/);
      if (sheet) { tokens.push({ type: 'ident', value: sheet[0] }); i += sheet[0].length; continue; }
      throw new ExcelError('#VALUE!', `数式の文字を解釈できません: ${ch}`);
    }
    tokens.push({ type: 'eof', value: '' });
    return tokens;
  }

  class FormulaParser {
    constructor(formula, defaultSheet) {
      this.tokens = tokenize(formula.replace(/^=/, ''));
      this.pos = 0;
      this.defaultSheet = defaultSheet;
    }
    peek(value) { const t = this.tokens[this.pos]; return value === undefined ? t : t.value === value; }
    take(value) {
      const token = this.tokens[this.pos];
      if (value !== undefined && token.value !== value) throw new ExcelError('#VALUE!', `数式の構文エラー: ${value} が必要です`);
      this.pos += 1; return token;
    }
    parse() {
      const node = this.comparison();
      if (this.peek().type !== 'eof') throw new ExcelError('#VALUE!', '数式の末尾を解釈できません');
      return node;
    }
    comparison() {
      let node = this.additive();
      while (['=', '<>', '<', '>', '<=', '>='].includes(this.peek().value)) node = { type: 'binary', op: this.take().value, left: node, right: this.additive() };
      return node;
    }
    additive() {
      let node = this.multiplicative();
      while (['+', '-'].includes(this.peek().value)) node = { type: 'binary', op: this.take().value, left: node, right: this.multiplicative() };
      return node;
    }
    multiplicative() {
      let node = this.power();
      while (['*', '/'].includes(this.peek().value)) node = { type: 'binary', op: this.take().value, left: node, right: this.power() };
      return node;
    }
    power() {
      let node = this.unary();
      if (this.peek('^')) node = { type: 'binary', op: this.take().value, left: node, right: this.power() };
      return node;
    }
    unary() {
      if (['+', '-'].includes(this.peek().value)) return { type: 'unary', op: this.take().value, value: this.unary() };
      return this.primary();
    }
    primary() {
      const token = this.peek();
      if (token.type === 'number' || token.type === 'string') { this.take(); return { type: token.type, value: token.value }; }
      if (this.peek('(')) { this.take('('); const node = this.comparison(); this.take(')'); return node; }
      if (token.type === 'ident' && this.tokens[this.pos + 1]?.value === '(') {
        const name = this.take().value.toUpperCase(); this.take('(');
        const args = [];
        if (!this.peek(')')) {
          do { args.push(this.comparison()); if (!this.peek(',')) break; this.take(','); } while (!this.peek(')'));
        }
        this.take(')'); return { type: 'func', name, args };
      }
      let sheet = this.defaultSheet;
      if (token.type === 'ident' && this.tokens[this.pos + 1]?.value === '!') { sheet = this.take().value; this.take('!'); }
      const cell = this.peek();
      if (cell.type === 'cell') {
        const start = this.take().value;
        if (this.peek(':')) { this.take(':'); const end = this.take().value; return { type: 'range', sheet, start, end }; }
        return { type: 'cell', sheet, address: start };
      }
      throw new ExcelError('#VALUE!', `数式の要素を解釈できません: ${token.value}`);
    }
  }

  function decodeAddress(address) {
    const match = address.replace(/\$/g, '').toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!match) throw new ExcelError('#REF!', `セル参照が不正です: ${address}`);
    let col = 0;
    for (const c of match[1]) col = col * 26 + c.charCodeAt(0) - 64;
    return { col: col - 1, row: Number(match[2]) - 1 };
  }
  function encodeAddress(row, col) {
    let n = col + 1, letters = '';
    while (n > 0) { const rem = (n - 1) % 26; letters = String.fromCharCode(65 + rem) + letters; n = Math.floor((n - 1) / 26); }
    return `${letters}${row + 1}`;
  }

  class WorkbookRuntime {
    constructor(workbook, overrides = {}) {
      this.workbook = workbook;
      this.overrides = overrides;
      this.cache = new Map();
      this.active = new Set();
      this.astCache = new Map();
    }
    key(sheet, address) { return `${sheet}!${address.replace(/\$/g, '').toUpperCase()}`; }
    cell(sheet, address) {
      const key = this.key(sheet, address);
      if (Object.prototype.hasOwnProperty.call(this.overrides, key)) return this.overrides[key];
      if (this.cache.has(key)) return this.cache.get(key);
      if (this.active.has(key)) throw new ExcelError('#REF!', `循環参照: ${key}`);
      const ws = this.workbook.Sheets[sheet];
      if (!ws) throw new ExcelError('#REF!', `シートがありません: ${sheet}`);
      const cell = ws[address.replace(/\$/g, '').toUpperCase()];
      if (!cell) return 0;
      if (!cell.f && cell.t === 'e') throw new ExcelError(cell.w || '#VALUE!', key);
      if (!cell.f) return cell.v ?? 0;
      this.active.add(key);
      try {
        let ast = this.astCache.get(key);
        if (!ast) { ast = new FormulaParser(cell.f, sheet).parse(); this.astCache.set(key, ast); }
        const value = this.eval(ast);
        this.cache.set(key, value);
        return value;
      } finally { this.active.delete(key); }
    }
    range(sheet, start, end) {
      const a = decodeAddress(start), b = decodeAddress(end), values = [];
      for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row += 1) {
        for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col += 1) values.push(this.cell(sheet, encodeAddress(row, col)));
      }
      return values;
    }
    number(value) {
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value === '' || value === null || value === undefined) return 0;
      const number = Number(value);
      if (!Number.isFinite(number)) throw new ExcelError('#VALUE!');
      return number;
    }
    eval(node) {
      if (node.type === 'number' || node.type === 'string') return node.value;
      if (node.type === 'cell') return this.cell(node.sheet, node.address);
      if (node.type === 'range') return this.range(node.sheet, node.start, node.end);
      if (node.type === 'unary') { const n = this.number(this.eval(node.value)); return node.op === '-' ? -n : n; }
      if (node.type === 'binary') {
        const leftRaw = this.eval(node.left), rightRaw = this.eval(node.right);
        if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
          if (node.op === '=') return leftRaw === rightRaw;
          if (node.op === '<>') return leftRaw !== rightRaw;
          if (node.op === '<') return leftRaw < rightRaw;
          if (node.op === '>') return leftRaw > rightRaw;
          if (node.op === '<=') return leftRaw <= rightRaw;
          return leftRaw >= rightRaw;
        }
        const left = this.number(leftRaw), right = this.number(rightRaw);
        if (node.op === '+') return left + right;
        if (node.op === '-') return left - right;
        if (node.op === '*') return left * right;
        if (node.op === '/') { if (right === 0) throw new ExcelError('#DIV/0!'); return left / right; }
        const value = Math.pow(left, right);
        if (!Number.isFinite(value)) throw new ExcelError('#NUM!');
        return value;
      }
      if (node.type === 'func') {
        if (node.name === 'IF') {
          if (node.args.length < 2) throw new ExcelError('#VALUE!');
          return this.eval(node.args[0]) ? this.eval(node.args[1]) : (node.args[2] ? this.eval(node.args[2]) : false);
        }
        if (node.name === 'EXP') {
          const value = Math.exp(this.number(this.eval(node.args[0])));
          if (!Number.isFinite(value)) throw new ExcelError('#NUM!');
          return value;
        }
        if (node.name === 'LN') {
          const value = this.number(this.eval(node.args[0]));
          if (value <= 0) throw new ExcelError('#NUM!');
          return Math.log(value);
        }
        if (node.name === 'LOOKUP') {
          const needle = this.number(this.eval(node.args[0]));
          const lookup = this.eval(node.args[1]);
          const result = node.args[2] ? this.eval(node.args[2]) : lookup;
          if (!Array.isArray(lookup) || !Array.isArray(result) || lookup.length !== result.length) throw new ExcelError('#N/A');
          let found = -1;
          for (let i = 0; i < lookup.length; i += 1) {
            const candidate = Number(lookup[i]);
            if (Number.isFinite(candidate) && candidate <= needle) found = i;
            if (Number.isFinite(candidate) && candidate > needle) break;
          }
          if (found < 0) throw new ExcelError('#N/A');
          return result[found];
        }
        throw new ExcelError('#NAME?', `未対応の関数: ${node.name}`);
      }
      throw new ExcelError('#VALUE!');
    }
  }

  const form = document.querySelector('#calculator');
  const inputFields = document.querySelector('#input-fields');
  const cards = document.querySelector('#metric-cards');
  const status = document.querySelector('#status');
  const patternCanvas = document.querySelector('#pattern-chart');
  const patternStatus = document.querySelector('#pattern-status');
  const fileInput = document.querySelector('#workbook-file');
  const workbookMeta = document.querySelector('#workbook-meta');
  const removeWorkbookButton = document.querySelector('#remove-workbook');
  const ratioInput = document.querySelector('#ratio');
  const ratioSource = document.querySelector('#ratio-source');
  const pvcInput = document.querySelector('#pvc');
  const pvcSource = document.querySelector('#pvc-source');
  let workbook = null;
  let workbookName = '';
  let currentResults = Object.fromEntries(IDS.map(id => [id, { error: 'Excel未読込' }]));
  let currentInput = null;
  let ratioMode = 'auto';
  let pvcMode = 'auto';
  let timer = 0;

  function validateWorkbook(book) {
    for (const name of REQUIRED_SHEETS) if (!book.Sheets[name]) throw new Error(`必要なシート「${name}」がありません。`);
    for (const spec of Object.values(OUTPUT_CELLS)) {
      for (const address of Object.values(spec)) {
        const cell = book.Sheets[TOP_SHEET][address];
        if (!cell || !cell.f) throw new Error(`「${TOP_SHEET}」シートの ${address} に必要な数式がありません。`);
      }
    }
    const sample = book.Sheets.spline.A4;
    if (!sample || !Number.isFinite(Number(sample.v))) throw new Error('「spline」シートの係数表を確認できません。');
    return true;
  }

  function parseWorkbook(buffer) {
    if (!window.XLSX) throw new Error('Excel読込ライブラリを読み込めませんでした。');
    const book = window.XLSX.read(buffer, { type: 'array', cellFormula: true, cellNF: false, cellStyles: false, dense: false });
    validateWorkbook(book);
    return book;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('pulmonary-lms-local-excel', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function saveWorkbook(buffer, name) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ buffer, name, savedAt: new Date().toISOString() }, 'active');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  async function loadSavedWorkbook() {
    const db = await openDb();
    const saved = await new Promise((resolve, reject) => {
      const req = db.transaction('files').objectStore('files').get('active');
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    db.close(); return saved;
  }
  async function deleteSavedWorkbook() {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').delete('active');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  function setWorkbookReady(book, name) {
    workbook = book; workbookName = name;
    inputFields.disabled = false;
    removeWorkbookButton.hidden = false;
    workbookMeta.className = 'workbook-meta ready';
    workbookMeta.textContent = `読込済み：${name}（${book.SheetNames.length}シート）／この端末内に保存`;
    calculate();
  }

  function clearWorkbookUi(message = '未読込：計算機能は停止しています。') {
    workbook = null; workbookName = ''; inputFields.disabled = true; removeWorkbookButton.hidden = true;
    workbookMeta.className = 'workbook-meta'; workbookMeta.textContent = message;
    status.className = 'status warn'; status.textContent = '公式Excelを読み込むと計算できます。';
    currentResults = Object.fromEntries(IDS.map(id => [id, { error: 'Excel未読込' }])); currentInput = null; renderCards(); drawPatternChart(null);
  }

  function optionalNumber(id) {
    const raw = document.querySelector(`#${id}`).value.trim();
    return raw === '' ? null : Number(raw);
  }
  function collect() {
    const measured = Object.fromEntries(IDS.map(id => [id, optionalNumber(id)]));
    if (measured.ratio !== null) measured.ratio /= 100;
    return { sex: document.querySelector('#sex').value, age: Number(document.querySelector('#age').value), height: Number(document.querySelector('#height').value), measured };
  }

  function makeOverrides(input, vcOverride = input.measured.vc) {
    const value = v => Number.isFinite(v) ? v : 0;
    return {
      [`${TOP_SHEET}!${INPUT_CELLS.sex}`]: input.sex === 'male' ? 1 : 2,
      [`${TOP_SHEET}!${INPUT_CELLS.age}`]: value(input.age),
      [`${TOP_SHEET}!${INPUT_CELLS.height}`]: value(input.height),
      [`${TOP_SHEET}!${INPUT_CELLS.fev1}`]: value(input.measured.fev1),
      [`${TOP_SHEET}!${INPUT_CELLS.fvc}`]: value(input.measured.fvc),
      [`${TOP_SHEET}!${INPUT_CELLS.vc}`]: value(vcOverride),
      [`${TOP_SHEET}!${INPUT_CELLS.ratio}`]: value(input.measured.ratio)
    };
  }

  function readMetric(runtime, metric, measured) {
    const spec = OUTPUT_CELLS[metric];
    try {
      const M = Number(runtime.cell(TOP_SHEET, spec.M));
      const LLN = Number(runtime.cell(TOP_SHEET, spec.LLN));
      const Z = measured === null ? null : Number(runtime.cell(TOP_SHEET, spec.Z));
      if (![M, LLN].every(Number.isFinite) || (measured !== null && !Number.isFinite(Z))) throw new ExcelError('#NUM!');
      return { M, LLN, Z, measured, percent: measured === null ? null : measured / M * 100 };
    } catch (error) {
      const code = error instanceof ExcelError ? error.code : '#VALUE!';
      return { error: `計算不可（${code}）`, detail: error.message };
    }
  }

  function calculateResults(input) {
    const runtime = new WorkbookRuntime(workbook, makeOverrides(input));
    const results = {
      fev1: readMetric(runtime, 'fev1', input.measured.fev1),
      fvc: readMetric(runtime, 'fvc', input.measured.fvc),
      vc: readMetric(runtime, 'vc', input.measured.vc),
      ratio: readMetric(runtime, 'ratio', input.measured.ratio)
    };
    if (results.vc.error) results.pvc = { error: results.vc.error, detail: results.vc.detail };
    else {
      const M = 100;
      const LLN = results.vc.LLN / results.vc.M * 100;
      const measured = input.measured.pvc;
      let Z = null;
      if (measured !== null) {
        try {
          const syntheticVc = results.vc.M * measured / 100;
          const pvcRuntime = new WorkbookRuntime(workbook, makeOverrides(input, syntheticVc));
          Z = Number(pvcRuntime.cell(TOP_SHEET, OUTPUT_CELLS.vc.Z));
          if (!Number.isFinite(Z)) throw new ExcelError('#NUM!');
        } catch (error) {
          const code = error instanceof ExcelError ? error.code : '#VALUE!';
          results.pvc = { error: `計算不可（${code}）`, detail: error.message };
        }
      }
      if (!results.pvc) results.pvc = { M, LLN, Z, measured, percent: measured };
    }
    return results;
  }

  function normalCdf(z) {
    const sign = z < 0 ? -1 : 1, x = Math.abs(z) / Math.sqrt(2), t = 1 / (1 + 0.3275911 * x);
    const erf = 1 - (((((1.061405429*t - 1.453152027)*t + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t)*Math.exp(-x*x);
    return 0.5 * (1 + sign * erf);
  }
  function fmt(value, digits = 2) { return Number.isFinite(value) ? value.toFixed(digits) : '計算不可'; }
  function metricValue(metric, value) {
    if (metric === 'ratio') return `${fmt(value * 100, 1)}%`;
    if (metric === 'pvc') return `${fmt(value, 1)}%`;
    return `${fmt(value, 2)} L`;
  }

  function renderCards() {
    cards.innerHTML = IDS.map(metric => {
      const result = currentResults[metric] || { error: 'Excel未読込' };
      if (result.error) return `<article class="result-card"><div class="result-title"><h3>${LABELS[metric]}</h3><button class="info-button" type="button" data-tip="${DESCRIPTIONS[metric]}" aria-label="${LABELS[metric]}の説明">i</button></div><div class="status error">${result.error}</div><div class="mini-chart-head"><span>標準正規分布</span><span>下側百分位 <strong>—</strong></span></div><canvas class="mini-chart" id="chart-${metric}" role="img" aria-label="${LABELS[metric]}の標準正規分布"></canvas><p class="chart-note">${workbook ? '入力値またはExcelの数式を確認してください' : '公式Excelを読み込んでください'}</p></article>`;
      const hasZ = Number.isFinite(result.Z), percentile = hasZ ? `${fmt(normalCdf(result.Z) * 100, 1)}%` : '—';
      return `<article class="result-card"><div class="result-title"><h3>${LABELS[metric]}</h3><button class="info-button" type="button" data-tip="${DESCRIPTIONS[metric]}" aria-label="${LABELS[metric]}の説明">i</button></div><div class="metrics"><div class="metric"><span>予測値</span><strong>${metricValue(metric, result.M)}</strong></div><div class="metric"><span>LLN</span><strong>${metricValue(metric, result.LLN)}</strong></div><div class="metric"><span>予測比</span><strong>${Number.isFinite(result.percent) ? `${fmt(result.percent, 1)}%` : '—'}</strong></div></div><div class="z-chip"><span>Z-score</span><strong>${hasZ ? fmt(result.Z, 2) : '—'}</strong></div><div class="mini-chart-head"><span>標準正規分布</span><span>下側百分位 <strong>${percentile}</strong></span></div><canvas class="mini-chart" id="chart-${metric}" role="img" aria-label="${LABELS[metric]}の標準正規分布とZ-scoreの位置"></canvas><p class="chart-note">${hasZ ? `Z = ${fmt(result.Z, 2)} ／ LLNは Z = −1.645` : '実測値を入力するとZ-scoreの位置を表示'}</p></article>`;
    }).join('');
    bindTooltips(); requestAnimationFrame(drawAllCharts);
  }

  function updateAutoRatio() {
    if (ratioMode === 'manual') { ratioSource.textContent = '現在：入力したFEV₁/FVCを使用しています'; return; }
    const fev1Raw = document.querySelector('#fev1').value.trim(), fvcRaw = document.querySelector('#fvc').value.trim();
    const fev1 = Number(fev1Raw), fvc = Number(fvcRaw);
    if (fev1Raw && fvcRaw && Number.isFinite(fev1) && Number.isFinite(fvc) && fev1 >= 0 && fvc > 0) {
      ratioInput.value = (fev1 / fvc * 100).toFixed(1); ratioInput.dataset.source = 'auto';
      ratioSource.textContent = `現在：FEV₁ ÷ FVC から ${ratioInput.value}% を自動入力しました（上書き可）`;
    } else {
      if (ratioInput.dataset.source === 'auto') ratioInput.value = '';
      delete ratioInput.dataset.source; ratioSource.textContent = '現在：FEV₁とFVCの入力待ち（FEV₁/FVCだけの入力も可）';
    }
  }

  function predictedVc(input) {
    if (!workbook) return NaN;
    try { return Number(new WorkbookRuntime(workbook, makeOverrides(input)).cell(TOP_SHEET, OUTPUT_CELLS.vc.M)); }
    catch { return NaN; }
  }
  function updateAutoPvc() {
    if (pvcMode === 'manual') { pvcSource.textContent = '現在：入力した%VCを使用しています'; return; }
    const vcRaw = document.querySelector('#vc').value.trim(), vc = Number(vcRaw), input = collect(), predicted = predictedVc(input);
    if (vcRaw && Number.isFinite(vc) && vc >= 0 && Number.isFinite(predicted) && predicted > 0) {
      pvcInput.value = (vc / predicted * 100).toFixed(1); pvcInput.dataset.source = 'auto';
      pvcSource.textContent = `現在：VC ÷ 予測VC から ${pvcInput.value}% を自動入力しました（上書き可）`;
    } else {
      if (pvcInput.dataset.source === 'auto') pvcInput.value = '';
      delete pvcInput.dataset.source; pvcSource.textContent = '現在：VCの入力待ち（%VCだけの入力も可）';
    }
  }

  function calculate() {
    if (!workbook) { clearWorkbookUi(); return; }
    updateAutoPvc();
    const input = collect(); currentInput = input;
    document.querySelector('#age').setAttribute('aria-invalid', String(!Number.isFinite(input.age) || input.age <= 0));
    document.querySelector('#height').setAttribute('aria-invalid', String(!Number.isFinite(input.height) || input.height <= 0));
    currentResults = calculateResults(input);
    const errors = Object.values(currentResults).filter(r => r.error);
    if (errors.length) { status.className = 'status error'; status.textContent = `${errors[0].error}。入力値と読み込んだExcelを確認してください。`; }
    else if (Object.values(input.measured).some(v => v === null)) { status.className = 'status ok'; status.textContent = '読み込んだExcelから予測値とLLNを表示しています。実測値のある指標ではZ-scoreも表示します。'; }
    else { status.className = 'status ok'; status.textContent = `「${workbookName}」の数式を端末内で評価しました。`; }
    renderCards(); renderPattern(input);
  }

  function drawAllCharts() {
    IDS.forEach(metric => { const canvas = document.querySelector(`#chart-${metric}`); if (canvas) drawDistribution(canvas, currentResults[metric]?.Z); });
    drawPatternChart(currentInput);
  }
  function renderPattern(input) {
    const ratio = currentResults.ratio, pvc = currentResults.pvc;
    const ready = Number.isFinite(input?.measured?.ratio) && input.measured.ratio > 0 && Number.isFinite(input?.measured?.pvc) && input.measured.pvc > 0 && !ratio?.error && !pvc?.error;
    if (ready) {
      const ratioLow = input.measured.ratio * 100 < ratio.LLN * 100, pvcLow = input.measured.pvc < pvc.LLN;
      patternStatus.textContent = ratioLow && pvcLow ? '混合性パターン疑い' : ratioLow ? '閉塞性パターン疑い' : pvcLow ? '拘束性パターン疑い' : '基準範囲内';
    } else patternStatus.textContent = '実測値の入力待ち';
    requestAnimationFrame(() => drawPatternChart(input));
  }

  function drawPatternChart(input) {
    if (!patternCanvas) return;
    const ratio = currentResults.ratio || {}, pvc = currentResults.pvc || {};
    const ready = Number.isFinite(input?.measured?.ratio) && input.measured.ratio > 0 && Number.isFinite(input?.measured?.pvc) && input.measured.pvc > 0 && !ratio.error && !pvc.error;
    const ratioLln = Number.isFinite(ratio.LLN) ? ratio.LLN * 100 : 70, pvcLln = Number.isFinite(pvc.LLN) ? pvc.LLN : 80;
    const ratioValue = ready ? input.measured.ratio * 100 : NaN, pvcValue = ready ? input.measured.pvc : NaN;
    const xMin = ready ? Math.min(30, Math.floor((ratioValue - 5) / 10) * 10) : 30, xMax = ready ? Math.max(100, Math.ceil((ratioValue + 5) / 10) * 10) : 100;
    const yMin = ready ? Math.min(40, Math.floor((pvcValue - 5) / 10) * 10) : 40, yMax = ready ? Math.max(130, Math.ceil((pvcValue + 5) / 10) * 10) : 130;
    const ctx = patternCanvas.getContext('2d'), dpr = window.devicePixelRatio || 1, rect = patternCanvas.getBoundingClientRect();
    patternCanvas.width = Math.max(1, rect.width * dpr); patternCanvas.height = Math.max(1, rect.height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width, h = rect.height, left = 56, right = w - 16, top = 24, bottom = h - 48;
    const xFor = v => left + (v - xMin) / (xMax - xMin) * (right - left), yFor = v => bottom - (v - yMin) / (yMax - yMin) * (bottom - top);
    const cutX = xFor(ratioLln), cutY = yFor(pvcLln); ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(236,229,244,.9)'; ctx.fillRect(left, top, Math.max(0, cutX-left), Math.max(0, cutY-top));
    ctx.fillStyle = 'rgba(231,242,235,.9)'; ctx.fillRect(cutX, top, Math.max(0, right-cutX), Math.max(0, cutY-top));
    ctx.fillStyle = 'rgba(255,235,235,.9)'; ctx.fillRect(left, cutY, Math.max(0, cutX-left), Math.max(0, bottom-cutY));
    ctx.fillStyle = 'rgba(255,244,224,.95)'; ctx.fillRect(cutX, cutY, Math.max(0, right-cutX), Math.max(0, bottom-cutY));
    ctx.strokeStyle = '#dfd5e8'; ctx.lineWidth = 1;
    for (let v = Math.ceil(xMin/10)*10; v <= xMax; v += 10) { const x=xFor(v); ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,bottom); ctx.stroke(); ctx.fillStyle='#746981'; ctx.font='12px -apple-system,sans-serif'; ctx.textAlign='center'; ctx.fillText(v,x,bottom+18); }
    for (let v = Math.ceil(yMin/20)*20; v <= yMax; v += 20) { const y=yFor(v); ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(right,y); ctx.stroke(); ctx.fillStyle='#746981'; ctx.font='12px -apple-system,sans-serif'; ctx.textAlign='right'; ctx.fillText(v,left-8,y+4); }
    ctx.setLineDash([6,4]); ctx.strokeStyle='#a23838'; ctx.lineWidth=1.6; ctx.beginPath(); ctx.moveTo(cutX,top); ctx.lineTo(cutX,bottom); ctx.stroke(); ctx.beginPath(); ctx.moveTo(left,cutY); ctx.lineTo(right,cutY); ctx.stroke(); ctx.setLineDash([]);
    if (workbook && Number.isFinite(ratio.LLN) && Number.isFinite(pvc.LLN)) { ctx.fillStyle='#a23838'; ctx.font='700 11px -apple-system,sans-serif'; ctx.textAlign='left'; ctx.fillText(`LLN ${fmt(ratioLln,1)}%`,Math.min(right-74,cutX+5),top+42); ctx.fillText(`LLN ${fmt(pvcLln,1)}%`,left+5,Math.max(top+26,cutY-6)); }
    const label=(text,x,y,color)=>{ctx.fillStyle=color;ctx.font='700 12px -apple-system,sans-serif';ctx.textAlign='center';ctx.fillText(text,x,y);};
    label('閉塞性疑い',(left+cutX)/2,top+22,'#655074'); label('基準範囲内',(cutX+right)/2,top+22,'#3d6b50'); label('混合性疑い',(left+cutX)/2,bottom-12,'#9b4646'); label('拘束性疑い',(cutX+right)/2,bottom-12,'#8b5b18');
    ctx.strokeStyle='#8e8298';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(left,top);ctx.lineTo(left,bottom);ctx.lineTo(right,bottom);ctx.stroke();
    ctx.fillStyle='#352b43';ctx.font='700 12px -apple-system,sans-serif';ctx.textAlign='center';ctx.fillText('FEV₁/FVC（%）',(left+right)/2,h-8);ctx.save();ctx.translate(14,(top+bottom)/2);ctx.rotate(-Math.PI/2);ctx.fillText('%VC',0,0);ctx.restore();
    if (ready) { const px=xFor(ratioValue),py=yFor(pvcValue);ctx.fillStyle='#51346f';ctx.strokeStyle='white';ctx.lineWidth=3;ctx.beginPath();ctx.arc(px,py,8,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#51346f';ctx.font='800 12px -apple-system,sans-serif';ctx.textAlign=px>right-90?'right':'left';ctx.fillText(`実測 ${fmt(ratioValue,1)}%, ${fmt(pvcValue,1)}%`,px+(px>right-90?-12:12),Math.max(top+42,py-12));patternCanvas.setAttribute('aria-label',`${patternStatus.textContent}。FEV1/FVC ${fmt(ratioValue,1)}%、%VC ${fmt(pvcValue,1)}%`); }
    else patternCanvas.setAttribute('aria-label','換気パターン判定図。FEV1/FVCと%VCの入力待ち');
  }

  function drawDistribution(canvas, z) {
    const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();canvas.width=Math.max(1,rect.width*dpr);canvas.height=Math.max(1,rect.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
    const w=rect.width,h=rect.height,left=34,right=w-18,top=25,base=h-37,xFor=v=>left+(v+4)/8*(right-left),density=v=>Math.exp(-.5*v*v)/Math.sqrt(2*Math.PI),yFor=v=>base-density(v)/density(0)*(base-top);ctx.clearRect(0,0,w,h);ctx.strokeStyle='#dfd5e8';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,base);ctx.lineTo(right,base);ctx.stroke();
    const llnX=xFor(-1.645);ctx.fillStyle='rgba(162,56,56,.10)';ctx.beginPath();ctx.moveTo(left,base);for(let v=-4;v<=-1.645;v+=.04)ctx.lineTo(xFor(v),yFor(v));ctx.lineTo(llnX,base);ctx.closePath();ctx.fill();ctx.fillStyle='rgba(81,52,111,.10)';ctx.beginPath();ctx.moveTo(llnX,base);for(let v=-1.645;v<=4;v+=.04)ctx.lineTo(xFor(v),yFor(v));ctx.lineTo(right,base);ctx.closePath();ctx.fill();
    ctx.strokeStyle='#6b478b';ctx.lineWidth=2.5;ctx.beginPath();for(let v=-4;v<=4;v+=.035){const x=xFor(v),y=yFor(v);v===-4?ctx.moveTo(x,y):ctx.lineTo(x,y);}ctx.stroke();ctx.setLineDash([5,4]);ctx.strokeStyle='#a23838';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(llnX,base);ctx.lineTo(llnX,yFor(-1.645)-7);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#a23838';ctx.font='700 12px -apple-system,sans-serif';ctx.textAlign='center';ctx.fillText('LLN',llnX,16);
    [-4,-3,-2,-1,0,1,2,3,4].forEach(v=>{const x=xFor(v);ctx.strokeStyle='#a99db4';ctx.beginPath();ctx.moveTo(x,base);ctx.lineTo(x,base+5);ctx.stroke();ctx.fillStyle='#746981';ctx.font='12px -apple-system,sans-serif';ctx.fillText(String(v),x,base+20);});
    if(Number.isFinite(z)){const shown=Math.max(-4,Math.min(4,z)),x=xFor(shown),y=yFor(shown);ctx.strokeStyle='#a4562d';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,base);ctx.lineTo(x,y-6);ctx.stroke();ctx.fillStyle='#a4562d';ctx.beginPath();ctx.arc(x,y,5.5,0,Math.PI*2);ctx.fill();ctx.fillStyle='#352b43';ctx.font='800 12px -apple-system,sans-serif';ctx.fillText(`Z ${fmt(z,2)}`,Math.max(left+30,Math.min(right-30,x)),Math.max(14,y-14));}
  }

  const tooltip=document.querySelector('#tooltip');
  function bindTooltips(){document.querySelectorAll('[data-tip]').forEach(el=>{if(el.dataset.tipBound)return;el.dataset.tipBound='1';const show=()=>{tooltip.textContent=el.dataset.tip;const r=el.getBoundingClientRect();tooltip.style.left=Math.min(window.innerWidth-306,Math.max(12,r.left))+'px';tooltip.style.top=Math.min(window.innerHeight-90,r.bottom+8)+'px';tooltip.classList.add('show');};const hide=()=>tooltip.classList.remove('show');el.addEventListener('mouseenter',show);el.addEventListener('focus',show);el.addEventListener('mouseleave',hide);el.addEventListener('blur',hide);});}

  document.querySelector('#choose-workbook').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]; if (!file) return;
    workbookMeta.className='workbook-meta'; workbookMeta.textContent='Excelを端末内で確認しています…';
    try { const buffer=await file.arrayBuffer(); const book=parseWorkbook(buffer); await saveWorkbook(buffer,file.name); setWorkbookReady(book,file.name); }
    catch(error){ clearWorkbookUi(`読込できません：${error.message}`); }
    finally { fileInput.value=''; }
  });
  removeWorkbookButton.addEventListener('click', async()=>{await deleteSavedWorkbook();clearWorkbookUi('端末内に保存したExcelを削除しました。');});
  form.addEventListener('submit',event=>{event.preventDefault();calculate();});
  form.addEventListener('input',event=>{
    if(event.target.id==='ratio'){if(ratioInput.value.trim()===''){ratioMode='auto';delete ratioInput.dataset.source;updateAutoRatio();}else{ratioMode='manual';ratioInput.dataset.source='manual';ratioSource.textContent='現在：入力したFEV₁/FVCを使用しています';}}
    else if(event.target.id==='pvc'){if(pvcInput.value.trim()===''){pvcMode='auto';delete pvcInput.dataset.source;updateAutoPvc();}else{pvcMode='manual';pvcInput.dataset.source='manual';pvcSource.textContent='現在：入力した%VCを使用しています';}}
    else if(event.target.id==='fev1'||event.target.id==='fvc')updateAutoRatio();
    clearTimeout(timer);timer=setTimeout(calculate,120);
  });
  document.querySelector('#sex').addEventListener('change',event=>{document.querySelector('#height').value=event.target.value==='male'?'171':'158';clearTimeout(timer);calculate();});
  document.querySelector('#reset').addEventListener('click',()=>{clearTimeout(timer);ratioMode='auto';pvcMode='auto';document.querySelector('#sex').value='male';document.querySelector('#age').value='40';document.querySelector('#height').value='171';['fev1','fvc','vc','ratio','pvc'].forEach(id=>{document.querySelector(`#${id}`).value='';});delete ratioInput.dataset.source;delete pvcInput.dataset.source;updateAutoRatio();updateAutoPvc();calculate();});
  window.addEventListener('resize',drawAllCharts);
  const offlineNote=document.querySelector('#offline-note'),updateConnectionState=()=>offlineNote.classList.toggle('show',!navigator.onLine);window.addEventListener('online',updateConnectionState);window.addEventListener('offline',updateConnectionState);updateConnectionState();
  if('serviceWorker' in navigator&&location.protocol!=='file:')window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js'));
  window.__LMS_EXCEL_TEST__={
    FormulaParser,
    WorkbookRuntime,
    parseWorkbook,
    calculateResults,
    ExcelError,
    getWorkbook:()=>workbook,
    loadWorkbookForTest:(buffer)=>{
      workbook=parseWorkbook(new Uint8Array(buffer));
      return {sheetNames:[...workbook.SheetNames]};
    }
  };

  renderCards(); bindTooltips();
  loadSavedWorkbook().then(saved=>{if(!saved)return;try{setWorkbookReady(parseWorkbook(saved.buffer),saved.name||'保存済みExcel');}catch(error){clearWorkbookUi(`保存済みExcelを開けません：${error.message}`);}}).catch(()=>{});
})();
