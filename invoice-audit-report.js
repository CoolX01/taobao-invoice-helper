const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

const PAGE_ERROR_HINTS = {
  expired: [
    '订单超过可开票期限',
    '超过开票日期',
    '已超过开票日期',
    '超过可开票时间',
    '已超过可开票时间',
    '超过开票时间',
    '开票申请已截止',
    '超过申请时效',
    '开票已截止',
  ],
  wrongTitle: ['抬头信息输入有误', '抬头错误', '发票抬头有误'],
  wrongTaxNo: ['税号错误', '税号有误', '纳税人识别号错误', '税号不正确'],
  missingEmail: ['请提供邮箱', '请提供电子邮箱', '提供电子邮箱', '未提供邮箱', '缺少邮箱', '电子邮箱'],
  missingInfo: ['信息不完整', '请补充信息', '信息有误', '请核实发票信息'],
  amountMismatch: ['金额不符', '金额有误', '开票金额不符'],
  rejected: ['商家拒绝', '审核不通过', '审核未通过', '申请失败', '拒绝开票'],
};

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function loadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function saveCsv(file, rows, headers) {
  const lines = [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function classifyPageErrorText(text) {
  const bodyText = String(text || '');
  const hits = [];
  for (const [type, patterns] of Object.entries(PAGE_ERROR_HINTS)) {
    const matched = patterns.find(pattern => bodyText.includes(pattern));
    if (matched) hits.push({ type, matched });
  }
  return {
    hits,
    hasRetryableError: hits.some(hit => ['wrongTitle', 'wrongTaxNo', 'missingEmail', 'missingInfo'].includes(hit.type)),
    hasExpiredError: hits.some(hit => hit.type === 'expired'),
    primaryReason: hits[0]?.matched || '',
  };
}

function extractLatestRejectInfo(historyText) {
  const lines = String(historyText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/卖家拒绝了发票申请|商家拒绝了发票申请|拒绝了发票申请/.test(lines[i])) continue;
    const windowLines = lines.slice(i, i + 10);
    const typeLine = windowLines.find(line => line.startsWith('拒绝类型'));
    const reasonLine = windowLines.find(line => line.startsWith('拒绝原因'));
    entries.push({
      rejectType: typeLine ? typeLine.replace(/^拒绝类型[：:\s]*/, '').trim() : '',
      rejectReason: reasonLine ? reasonLine.replace(/^拒绝原因[：:\s]*/, '').trim() : '',
      rawText: windowLines.join('\n'),
    });
  }

  if (entries.length === 0) {
    const typeLine = lines.find(line => line.startsWith('拒绝类型'));
    const reasonLine = lines.find(line => line.startsWith('拒绝原因'));
    if (typeLine || reasonLine) {
      entries.push({
        rejectType: typeLine ? typeLine.replace(/^拒绝类型[：:\s]*/, '').trim() : '',
        rejectReason: reasonLine ? reasonLine.replace(/^拒绝原因[：:\s]*/, '').trim() : '',
        rawText: lines.join('\n'),
      });
    }
  }

  return {
    entries,
    latest: entries[0] || { rejectType: '', rejectReason: '', rawText: '' },
  };
}

function classifyRejectedInvoiceHandling({ detailText = '', historyText = '', hasModifyEntry = false, historyOpened = true }) {
  const combinedText = `${detailText}\n${historyText}`;
  const hasRejectedState = [
    '商家拒绝',
    '卖家拒绝了发票申请',
    '拒绝了发票申请',
    '审核不通过',
    '审核未通过',
    '申请失败',
    '拒绝开票',
  ].some(word => combinedText.includes(word));

  if (!hasRejectedState) {
    return { action: 'continue', reason: '', rejectInfo: extractLatestRejectInfo(historyText) };
  }

  const rejectInfo = extractLatestRejectInfo(historyText);
  const rejectType = rejectInfo.latest.rejectType || '';
  const rejectReason = rejectInfo.latest.rejectReason || '';
  const reasonText = `${rejectType}\n${rejectReason}`;
  const parseResult = classifyPageErrorText(`${reasonText}\n${combinedText}`);

  if (!rejectReason && historyOpened) {
    return {
      action: 'manual_required',
      reason: '已读取申请历史，但未解析到明确拒绝原因，请人工确认',
      rejectInfo,
      parseResult,
    };
  }
  if (!historyOpened) {
    return {
      action: 'manual_required',
      reason: '当前为商家拒绝，但未能打开申请历史读取拒绝原因',
      rejectInfo,
      parseResult,
    };
  }

  if (/已开.*发票|已经开.*发票|已为.*开具|已开具.*发票/.test(reasonText)) {
    return {
      action: 'manual_required',
      reason: `商家称已开票，需确认是否下载或换开：${rejectReason}`,
      rejectInfo,
      parseResult,
    };
  }

  const asksSellerContact = /联系客服|联系在线客服|联系我们在线客服|在线客服|咨询客服|联系商家|联系卖家|旺旺/.test(reasonText);
  const asksInvoiceByContact = /(开具|开票|进行开票|发邮箱|提供邮箱|电子发票|普票)/.test(reasonText);
  const smallScaleCannotVat = /小规模.*开.*不了|小规模.*不能开|开不了.*增值税|无法开具.*增值税/.test(reasonText);
  if ((asksSellerContact && asksInvoiceByContact) || (smallScaleCannotVat && asksSellerContact)) {
    return {
      action: 'contact_seller',
      reason: `拒绝原因要求联系商家处理：${rejectReason}`,
      rejectInfo,
      parseResult,
    };
  }

  const clearlyFixableInForm = parseResult.hasRetryableError
    || /抬头|税号|纳税人识别号|统一社会信用代码|信息输入有误|信息有误|信息不完整|请核实发票信息|邮箱/.test(reasonText);
  if (clearlyFixableInForm) {
    if (!hasModifyEntry) {
      return {
        action: 'contact_seller',
        reason: `拒绝原因看起来可修正，但页面没有可用修改申请入口，改为联系商家：${rejectReason || rejectType}`,
        rejectInfo,
        parseResult,
      };
    }
    return {
      action: 'modify_invoice',
      reason: `拒绝原因可通过修改申请修正：${rejectReason || rejectType}`,
      rejectInfo,
      parseResult,
    };
  }

  return {
    action: 'manual_required',
    reason: `商家拒绝原因未纳入自动规则，请确认处理方式：${rejectReason || rejectType || '未提供原因'}`,
    rejectInfo,
    parseResult,
  };
}

function listArtifactFiles() {
  const include = [
    /^invoice-action.*\.json$/,
    /^invoice-status.*\.json$/,
    /^repair-.*\.json$/,
    /^inspect-invoice-history\.json$/,
  ];
  return fs.readdirSync(ROOT)
    .filter(fileName => include.some(pattern => pattern.test(fileName)))
    .filter(fileName => !fileName.endsWith('.tmp'))
    .filter(fileName => fileName !== 'invoice-config.json')
    .sort();
}

function readContactedLedger(fileName) {
  const filePath = path.join(ROOT, fileName);
  const ledger = loadJson(filePath, { orders: {} });
  return ledger?.orders && typeof ledger.orders === 'object' ? ledger.orders : {};
}

function mergeOrder(orders, orderId, patch) {
  if (!orderId) return null;
  const existing = orders.get(orderId) || {
    orderId,
    sourceFiles: new Set(),
    statuses: new Set(),
    actions: new Set(),
    reasons: [],
    detailText: '',
    historyText: '',
    hasModifyEntry: false,
    invoiceFilePath: '',
    orderDate: '',
    shopName: '',
    amount: '',
    invoiceTitle: '',
    currentStatus: '',
    currentStatusAt: '',
    currentStatusSource: '',
  };

  if (patch.sourceFile) existing.sourceFiles.add(patch.sourceFile);
  if (patch.status) existing.statuses.add(patch.status);
  if (patch.currentStatus) existing.statuses.add(patch.currentStatus);
  if (patch.currentStatus) {
    const nextTime = new Date(patch.currentStatusAt || patch.checkedAt || patch.processedAt || 0).getTime() || 0;
    const currentTime = new Date(existing.currentStatusAt || 0).getTime() || 0;
    if (!existing.currentStatus || nextTime >= currentTime) {
      existing.currentStatus = patch.currentStatus;
      existing.currentStatusAt = patch.currentStatusAt || patch.checkedAt || patch.processedAt || '';
      existing.currentStatusSource = patch.sourceFile || '';
    }
  }
  if (patch.executionStatus) existing.statuses.add(patch.executionStatus);
  if (patch.action) existing.actions.add(patch.action);
  if (patch.reason) existing.reasons.push(patch.reason);
  if (patch.detailText && patch.detailText.length > existing.detailText.length) existing.detailText = patch.detailText;
  if (patch.historyText && patch.historyText.length > existing.historyText.length) existing.historyText = patch.historyText;
  if (patch.hasModifyEntry) existing.hasModifyEntry = true;
  if (patch.invoiceFilePath) existing.invoiceFilePath = patch.invoiceFilePath;
  if (patch.orderDate) existing.orderDate = patch.orderDate;
  if (patch.shopName) existing.shopName = patch.shopName;
  if (patch.amount) existing.amount = patch.amount;
  if (patch.invoiceTitle) existing.invoiceTitle = patch.invoiceTitle;
  if (patch.checkedAt) existing.checkedAt = patch.checkedAt;
  if (patch.processedAt) existing.processedAt = patch.processedAt;

  orders.set(orderId, existing);
  return existing;
}

function collectOrdersFromArtifact(parsed, sourceFile, orders) {
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const orderId = typeof node.bizOrderId === 'string'
      ? node.bizOrderId
      : typeof node.orderId === 'string' && /^\d{8,}$/.test(node.orderId)
        ? node.orderId
        : '';

    if (orderId) {
      const candidates = Array.isArray(node.candidates) ? node.candidates : [];
      mergeOrder(orders, orderId, {
        sourceFile,
        status: node.status || '',
        currentStatus: node.currentStatus || '',
        executionStatus: node.execution?.status || '',
        action: node.actionPlan?.action || node.execution?.action || '',
        reason: node.execution?.reason || node.reason || node.actionPlan?.reason || node.error || '',
        detailText: node.detailBodyText || node.bodyText || node.detail?.bodyText || '',
        historyText: node.history?.historyText || node.historyText || '',
        hasModifyEntry: candidates.some(candidate => candidate.type === 'modify_invoice' && candidate.visible && !candidate.disabled)
          || JSON.stringify(node).includes('修改申请'),
        invoiceFilePath: node.execution?.downloadResult?.path || node.invoiceFilePath || '',
        orderDate: node.orderDate || '',
        shopName: node.shopName || node.orderMeta?.shopName || '',
        amount: node.amount || node.orderMeta?.amount || '',
        invoiceTitle: node.invoiceInfo?.invoiceTitle || '',
        checkedAt: node.checkedAt || node.capturedAt || '',
        currentStatusAt: node.checkedAt || node.capturedAt || parsed.generatedAt || '',
        processedAt: node.execution?.executedAt || node.checkedAt || '',
      });
    }

    for (const value of Object.values(node)) visit(value);
  }

  visit(parsed);
}

function collectContactedFromArtifact(parsed, sourceFile, contacted) {
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const orderId = typeof node.bizOrderId === 'string'
      ? node.bizOrderId
      : typeof node.orderId === 'string' && /^\d{8,}$/.test(node.orderId)
        ? node.orderId
        : '';
    if (orderId && node.execution?.status === 'seller_contacted') {
      const existing = contacted[orderId] || {};
      const contactResult = node.execution.contactResult || {};
      contacted[orderId] = {
        orderId,
        shopName: node.shopName || node.orderMeta?.shopName || existing.shopName || '',
        amount: node.amount || node.orderMeta?.amount || existing.amount || '',
        orderDate: node.orderDate || existing.orderDate || '',
        invoiceUrl: node.invoiceUrl || node.detailUrl || node.url || existing.invoiceUrl || '',
        rejectType: node.rejectedDecision?.rejectInfo?.latest?.rejectType || existing.rejectType || '',
        rejectReason: node.rejectedDecision?.rejectInfo?.latest?.rejectReason || existing.rejectReason || '',
        message: contactResult.message || node.execution.message || existing.message || '',
        contactedAt: contactResult.executedAt || node.execution.executedAt || node.checkedAt || existing.contactedAt || new Date().toISOString(),
        finalUrl: contactResult.finalUrl || node.execution.finalUrl || existing.finalUrl || '',
        source: existing.source ? `${existing.source}|${sourceFile}` : sourceFile,
        updatedAt: new Date().toISOString(),
      };
    }

    for (const value of Object.values(node)) visit(value);
  }

  visit(parsed);
}

function writeContactedLedgerFromArtifacts(artifactFiles, ledgerFile) {
  const ledgerPath = path.join(ROOT, ledgerFile);
  const existingLedger = loadJson(ledgerPath, { version: '0.1.0', orders: {} });
  const contacted = { ...(existingLedger.orders || {}) };

  for (const fileName of artifactFiles) {
    const parsed = loadJson(path.join(ROOT, fileName));
    if (!parsed) continue;
    collectContactedFromArtifact(parsed, fileName, contacted);
  }

  saveJson(ledgerPath, {
    version: existingLedger.version || '0.1.0',
    generatedFromArtifactsAt: existingLedger.generatedFromArtifactsAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    orders: contacted,
  });

  return Object.keys(contacted).length;
}

function chooseCategory(order, contactedRecord) {
  const statuses = order.statuses;
  const actions = order.actions;
  const currentStatus = order.currentStatus || '';
  const rejection = classifyRejectedInvoiceHandling({
    detailText: order.detailText,
    historyText: order.historyText,
    hasModifyEntry: order.hasModifyEntry,
    historyOpened: Boolean(order.historyText),
  });
  const rejectReason = rejection.rejectInfo?.latest?.rejectReason || '';

  if (contactedRecord || statuses.has('seller_contacted')) {
    return { category: 'seller_contacted', recommendation: '等待商家回复或后续状态变化', rejection };
  }
  if (currentStatus === 'processing') {
    return { category: 'processing', recommendation: '最新扫描仍为处理中，继续等待', rejection };
  }
  if (currentStatus === 'downloadable_now') {
    return { category: 'downloadable', recommendation: '最新扫描显示可下载，可执行下载发票', rejection };
  }
  if (currentStatus === 'apply_available') {
    return { category: 'apply_available', recommendation: '最新扫描显示可申请开票', rejection };
  }
  if (currentStatus === 'reissuable_now') {
    return { category: 'reissuable', recommendation: '最新扫描显示可换开', rejection };
  }
  if (currentStatus === 'login_required' || currentStatus === 'error') {
    return { category: currentStatus, recommendation: order.reasons.slice(-1)[0] || '最新扫描异常', rejection };
  }
  if (statuses.has('downloaded') || order.invoiceFilePath) {
    return { category: 'downloaded', recommendation: '已下载，无需重复处理', rejection };
  }
  if (statuses.has('downloadable_now') || actions.has('download_invoice')) {
    return { category: 'downloadable', recommendation: '可执行下载发票', rejection };
  }
  if (rejection.action === 'contact_seller') {
    return { category: 'rejected_contact_seller', recommendation: '可自动联系商家，发送单条开票信息', rejection };
  }
  if (rejection.action === 'modify_invoice') {
    return { category: 'rejected_auto_modify', recommendation: '可自动修改申请并重提', rejection };
  }
  if (rejection.action === 'manual_required' || rejectReason) {
    return { category: 'rejected_manual_required', recommendation: rejection.reason || '拒绝原因需人工确认', rejection };
  }
  if (statuses.has('processing') || statuses.has('pending') || statuses.has('submitted')) {
    return { category: 'processing', recommendation: '继续等待，定期只读扫描', rejection };
  }
  if (statuses.has('apply_available') || actions.has('apply_invoice')) {
    return { category: 'apply_available', recommendation: '可执行申请开票', rejection };
  }
  if (statuses.has('reissuable_now') || actions.has('reissue_invoice')) {
    return { category: 'reissuable', recommendation: '可执行换开', rejection };
  }
  if (statuses.has('manual_required') || actions.has('manual_review')) {
    return { category: 'manual_required', recommendation: order.reasons[0] || '需人工复核', rejection };
  }
  return { category: 'unknown', recommendation: order.reasons[0] || '暂无明确动作', rejection };
}

function buildReports() {
  const ledgerFile = getArg('contacted-ledger', 'contacted-orders.json');
  const contactedOrders = readContactedLedger(ledgerFile);
  const orders = new Map();
  const artifactFiles = listArtifactFiles();

  for (const fileName of artifactFiles) {
    const parsed = loadJson(path.join(ROOT, fileName));
    if (!parsed) continue;
    collectOrdersFromArtifact(parsed, fileName, orders);
  }

  for (const [orderId, record] of Object.entries(contactedOrders)) {
    mergeOrder(orders, orderId, {
      sourceFile: ledgerFile,
      executionStatus: 'seller_contacted',
      reason: record.rejectReason || '联系商家台账记录',
      shopName: record.shopName || '',
      amount: record.amount || '',
      orderDate: record.orderDate || '',
      processedAt: record.contactedAt || '',
    });
  }

  const rows = [...orders.values()]
    .map(order => {
      const contactedRecord = contactedOrders[order.orderId] || null;
      const decision = chooseCategory(order, contactedRecord);
      const rejectInfo = decision.rejection.rejectInfo?.latest || {};
      return {
        order_id: order.orderId,
        category: decision.category,
        recommendation: decision.recommendation,
        statuses: [...order.statuses].filter(Boolean).sort().join('|'),
        current_status: order.currentStatus || '',
        current_status_at: order.currentStatusAt || '',
        current_status_source: order.currentStatusSource || '',
        actions: [...order.actions].filter(Boolean).sort().join('|'),
        reject_action: decision.rejection.action || '',
        reject_type: rejectInfo.rejectType || '',
        reject_reason: rejectInfo.rejectReason || '',
        last_reason: order.reasons.filter(Boolean).slice(-1)[0] || '',
        contacted_at: contactedRecord?.contactedAt || '',
        shop_name: order.shopName,
        amount: order.amount,
        order_date: order.orderDate,
        invoice_title: order.invoiceTitle,
        invoice_file_path: order.invoiceFilePath,
        source_files: [...order.sourceFiles].sort().join('|'),
        processed_at: order.processedAt || order.checkedAt || '',
      };
    })
    .sort((left, right) => {
      const categoryCompare = left.category.localeCompare(right.category);
      if (categoryCompare !== 0) return categoryCompare;
      return right.order_id.localeCompare(left.order_id);
    });

  const summary = {};
  for (const row of rows) {
    summary[row.category] = (summary[row.category] || 0) + 1;
  }

  const rejectionRows = rows.filter(row => row.reject_action && row.reject_action !== 'continue');
  const rejectionSummary = {};
  for (const row of rejectionRows) {
    rejectionSummary[row.reject_action] = (rejectionSummary[row.reject_action] || 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    artifactFiles,
    contactedLedger: ledgerFile,
    summary,
    rejectionSummary,
    rows,
    rejectionRows,
  };
}

function main() {
  const date = getArg('date', formatDate(new Date()));
  const output = getArg('output', `invoice-audit-report-${date}.json`);
  const csv = getArg('csv', output.replace(/\.json$/i, '.csv'));
  const rejectionOutput = getArg('rejection-output', `invoice-rejection-report-${date}.json`);
  const rejectionCsv = getArg('rejection-csv', rejectionOutput.replace(/\.json$/i, '.csv'));
  const report = buildReports();
  let contactedLedgerOrders = null;
  if (hasFlag('write-contacted-ledger')) {
    contactedLedgerOrders = writeContactedLedgerFromArtifacts(report.artifactFiles, report.contactedLedger);
  }

  saveJson(path.join(ROOT, output), {
    generatedAt: report.generatedAt,
    artifactFiles: report.artifactFiles,
    contactedLedger: report.contactedLedger,
    summary: report.summary,
    rows: report.rows,
  });
  saveCsv(path.join(ROOT, csv), report.rows, [
    'order_id',
    'category',
    'recommendation',
    'statuses',
    'current_status',
    'current_status_at',
    'current_status_source',
    'actions',
    'reject_action',
    'reject_type',
    'reject_reason',
    'last_reason',
    'contacted_at',
    'shop_name',
    'amount',
    'order_date',
    'invoice_title',
    'invoice_file_path',
    'source_files',
    'processed_at',
  ]);

  saveJson(path.join(ROOT, rejectionOutput), {
    generatedAt: report.generatedAt,
    summary: report.rejectionSummary,
    rows: report.rejectionRows,
  });
  saveCsv(path.join(ROOT, rejectionCsv), report.rejectionRows, [
    'order_id',
    'category',
    'recommendation',
    'reject_action',
    'reject_type',
    'reject_reason',
    'last_reason',
    'contacted_at',
    'source_files',
  ]);

  if (!hasFlag('quiet')) {
    console.log(JSON.stringify({
      output,
      csv,
      rejectionOutput,
      rejectionCsv,
      contactedLedgerOrders,
      totalOrders: report.rows.length,
      summary: report.summary,
      rejectionSummary: report.rejectionSummary,
    }, null, 2));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyRejectedInvoiceHandling,
  extractLatestRejectInfo,
  classifyPageErrorText,
  buildReports,
};
