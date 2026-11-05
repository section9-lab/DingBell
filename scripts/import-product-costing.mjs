// Import the merchant costing spreadsheet into normalized import CSVs.
//
// Usage: node scripts/import-product-costing.mjs <sheet-export.csv> [--outdir <dir>]
//
// Input: the CSV export of the costing sheet ("成本计算 CNY币种结算(最新)"). Only the eight
// atomic input columns are read; every derived column (活动售价, 佣金, 运费, OZON结算, 提现,
// 利润, 利润率) is ignored on purpose — those values are recomputed from posting facts.
//
// Output (written to the output directory, default next to the input):
//   costing-import.csv   normalized product_costing rows, ready for review and import
//   name-mapping.csv     product_name_map template; offer_id and product_id stay blank for the
//                        merchant to fill after cross-checking with the DingBell product export
//
// The script never writes to the database: identity mapping is a reviewed, human-confirmed step.

import { openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const ATOMIC_COLUMNS = [
  { header: '序号', key: 'sheetRow', required: true },
  { header: '产品名', key: 'sheetName', aliases: ['f'], required: true },
  { header: '拿货成本', key: 'purchasePrice', required: true },
  { header: '代贴单', key: 'labelFee', required: false },
  { header: '平台定价', key: 'listPrice', required: false },
  { header: '活动折扣', key: 'promoDiscount', required: false },
  { header: '广告预算系数', key: 'adBudgetRate', required: false },
  { header: '平台佣金系数', key: 'commissionRate', required: false },
  { header: '重量', key: 'weightGrams', required: false },
  { header: '国际物流', key: 'supplySource', required: false },
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length > 0) { row.push(field); rows.push(row); row = []; field = ''; }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

function normalizeHeader(h) {
  return h.replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '');
}

function findColumnIndex(headers, spec) {
  const names = [spec.header, ...(spec.aliases ?? [])].map(normalizeHeader);
  return headers.findIndex(h => names.includes(normalizeHeader(h)));
}

// "13.50" → "13.50"; "1,100.00" → "1100.00"; "60.00%" → "0.60"
function normalizeMoney(value) {
  const v = value.replace(/,/g, '').trim();
  if (v === '') return '';
  if (!/^[0-9]+(\.[0-9]+)?$/.test(v)) throw new Error(`非数字金额: "${value}"`);
  return v;
}

function normalizeRate(value) {
  let v = value.replace(/,/g, '').trim();
  if (v === '') return '';
  if (v.endsWith('%')) v = (parseFloat(v) / 100).toFixed(4);
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`比例须在0~1之间: "${value}"`);
  return String(n);
}

// "300.00" → 300; "1,100.00" → 1100 (grams are stored as integer)
function normalizeWeight(value) {
  const v = value.replace(/,/g, '').trim();
  if (v === '') return '';
  const n = parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`非数字重量: "${value}"`);
  return String(Math.round(n));
}

function validate(args) {
  const errors = [];
  const rowStr = args.sheetRow;
  if (!/^[0-9]+$/.test(rowStr) || parseInt(rowStr, 10) <= 0) errors.push(`序号无效: "${rowStr}"`);
  if (args.sheetName.length < 1 || args.sheetName.length > 200) errors.push(`产品名长度无效`);
  for (const key of ['purchasePrice', 'labelFee', 'listPrice']) {
    if (args[key] !== '' && !/^[0-9]+(\.[0-9]+)?$/.test(args[key])) errors.push(`${key} 金额格式无效: "${args[key]}"`);
  }
  for (const key of ['promoDiscount', 'adBudgetRate', 'commissionRate']) {
    if (args[key] !== '') {
      const n = parseFloat(args[key]);
      if (!Number.isFinite(n) || n < 0 || n > 1) errors.push(`${key} 比例无效: "${args[key]}"`);
    }
  }
  if (args.weightGrams !== '' && (!/^[0-9]+$/.test(args.weightGrams) || parseInt(args.weightGrams, 10) <= 0)) errors.push(`重量无效: "${args.weightGrams}"`);
  if (args.supplySource.length > 200) errors.push(`物流渠道超长`);
  return errors;
}

function main() {
  const argv = process.argv.slice(2);
  const input = argv[0];
  const outdirFlag = argv.indexOf('--outdir');
  const outdir = outdirFlag >= 0 ? argv[outdirFlag + 1] : null;
  if (!input) {
    console.error('用法: node scripts/import-product-costing.mjs <sheet-export.csv> [--outdir <dir>]');
    process.exit(2);
  }
  const inputPath = resolve(input);
  const outdirPath = outdir ? resolve(outdir) : dirname(inputPath);

  let text;
  try {
    const fd = openSync(inputPath, 'r');
    const chunkSize = 1024 * 1024;
    const chunks = [];
    const buf = Buffer.alloc(chunkSize);
    let read;
    while ((read = readSync(fd, buf, 0, chunkSize, null)) > 0) chunks.push(buf.subarray(0, read).toString('utf8'));
    closeSync(fd);
    text = chunks.join('');
  } catch (err) {
    console.error(`无法读取输入文件: ${err.message}`);
    process.exit(1);
  }

  // BOM strip
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = parseCsv(text);
  if (rows.length < 2) { console.error('输入为空：至少需要表头和一行数据'); process.exit(1); }

  const headers = rows[0];
  const colIdx = new Map();
  const missing = [];
  for (const spec of ATOMIC_COLUMNS) {
    const idx = findColumnIndex(headers, spec);
    if (idx < 0) { if (spec.required) missing.push(spec.header); else continue; }
    colIdx.set(spec.key, idx);
  }
  if (missing.length > 0) { console.error(`缺少必需列: ${missing.join(', ')}；实际表头: ${headers.join(' | ')}`); process.exit(1); }

  const costing = [];
  const mapping = [];
  const nameCount = new Map();
  const allErrors = [];
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = key => (colIdx.get(key) !== undefined ? (row[colIdx.get(key)] ?? '').trim() : '');
    const sheetRow = get('sheetRow');
    const sheetName = get('sheetName').replace(/^"|"$/g, '');
    if (sheetRow === '' && sheetName === '') { skipped++; continue; }
    if (sheetName === '') { skipped++; continue; }
    const args = {
      sheetRow, sheetName,
      purchasePrice: get('purchasePrice'), labelFee: get('labelFee'), listPrice: get('listPrice'),
      promoDiscount: get('promoDiscount'), adBudgetRate: get('adBudgetRate'), commissionRate: get('commissionRate'),
      weightGrams: get('weightGrams'), supplySource: get('supplySource'),
    };
    try {
      args.purchasePrice = normalizeMoney(args.purchasePrice);
      args.labelFee = normalizeMoney(args.labelFee);
      args.listPrice = normalizeMoney(args.listPrice);
      args.promoDiscount = normalizeRate(args.promoDiscount);
      args.adBudgetRate = normalizeRate(args.adBudgetRate);
      args.commissionRate = normalizeRate(args.commissionRate);
      args.weightGrams = normalizeWeight(args.weightGrams);
    } catch (err) {
      allErrors.push(`第${r + 1}行(${sheetName}): ${err.message}`);
      continue;
    }
    const errors = validate(args);
    if (errors.length > 0) { allErrors.push(`第${r + 1}行(${sheetName}): ${errors.join('; ')}`); continue; }
    if (!nameCount.has(sheetName)) nameCount.set(sheetName, []);
    nameCount.get(sheetName).push(sheetRow);
    costing.push({
      sheetRow, sheetName,
      purchasePrice: args.purchasePrice, purchaseCurrency: 'CNY',
      labelFee: args.labelFee || '4.00', listPrice: args.listPrice,
      promoDiscount: args.promoDiscount, adBudgetRate: args.adBudgetRate, commissionRate: args.commissionRate,
      weightGrams: args.weightGrams, supplySource: args.supplySource,
    });
    mapping.push({ sheetRow, sheetName, offerId: '', productId: '' });
  }

  mkdirSync(outdirPath, { recursive: true });

  const costingHeader = 'sheet_row,sheet_name,purchase_price,purchase_currency,label_fee,list_price,promo_discount,ad_budget_rate,commission_rate,weight_grams,supply_source';
  const costingCsv = [costingHeader, ...costing.map(c => [
    c.sheetRow, `"${c.sheetName.replace(/"/g, '""')}"`, c.purchasePrice, c.purchaseCurrency,
    c.labelFee, c.listPrice, c.promoDiscount, c.adBudgetRate, c.commissionRate, c.weightGrams, c.supplySource,
  ].join(','))].join('\n');
  const costingPath = join(outdirPath, `costing-import-${basename(input, '.csv')}.csv`);
  writeFileSync(costingPath, '\ufeff' + costingCsv, 'utf8');

  const mappingHeader = 'sheet_row,sheet_name,offer_id,product_id,duplicate_name_warning';
  const mappingCsv = [mappingHeader, ...mapping.map(m => {
    const dup = nameCount.get(m.sheetName).length > 1 ? `名称重复(行:${nameCount.get(m.sheetName).join('/')})，必须按行号关联` : '';
    return [m.sheetRow, `"${m.sheetName.replace(/"/g, '""')}"`, m.offerId, m.productId, `"${dup}"`].join(',');
  })].join('\n');
  const mappingPath = join(outdirPath, `name-mapping-${basename(input, '.csv')}.csv`);
  writeFileSync(mappingPath, '\ufeff' + mappingCsv, 'utf8');

  const dupNames = [...nameCount.entries()].filter(([, rows2]) => rows2.length > 1);
  console.log(`读取 ${rows.length - 1} 数据行，有效 ${costing.length} 行，空行跳过 ${skipped} 行`);
  console.log(`重复产品名 ${dupNames.length} 个: ${dupNames.slice(0, 10).map(([n]) => n).join(', ')}${dupNames.length > 10 ? ' …' : ''}`);
  if (allErrors.length > 0) {
    console.error(`\n${allErrors.length} 行有校验错误:`);
    for (const e of allErrors.slice(0, 20)) console.error(`  ${e}`);
    if (allErrors.length > 20) console.error(`  … 其余 ${allErrors.length - 20} 条见上`);
  }
  console.log(`\n已生成:\n  ${costingPath}\n  ${mappingPath}`);
  console.log('下一步: 在 name-mapping CSV 中回填 offer_id / product_id 后，人工确认再导入。');
  if (allErrors.length > 0) process.exit(1);
}

main();
