// 淘宝发票动作计划生成器
// 默认只做 dry-run：识别下载、查看、申请开票、换开等候选动作，不提交表单。
process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  classifyInvoicePage,
  classifyPageErrorText: classifyRichPageErrorText,
} = require('./error-classifier');
const {
  ORDER_STATES,
  appendStateEvent,
  createOrderTrace,
  deriveStateFromClassification,
  deriveStateFromExecution,
  isTerminalState,
} = require('./order-state-machine');

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDefaultDateRange() {
  const today = new Date();
  return {
    startDate: `${today.getFullYear()}-01-01`,
    endDate: formatDate(today),
  };
}

function parseArgs() {
  const defaultRange = buildDefaultDateRange();
  const args = {
    test: null,
    orderIds: [],
    maxPages: 8,
    output: 'invoice-action-plan.json',
    progress: 'invoice-action-progress.json',
    execute: false,
    confirm: '',
    action: 'plan',
    startDate: defaultRange.startDate,
    endDate: defaultRange.endDate,
    downloadDir: 'downloads',
    config: 'invoice-config.json',
    closeOnFinish: false,
    retryUncertain: false,
    fresh: false,
    resultsCsv: '',
    maxRetries: 2,
    manualTimeoutMs: 15 * 60 * 1000,
    contactedLedger: 'contacted-orders.json',
    downloadedLedger: 'downloaded-invoices.json',
    modifiedLedger: 'modified-orders.json',
    chatReplyLedger: 'seller-chat-replies.json',
    snapshotDir: 'snapshots',
    forceContact: false,
    forceDownload: false,
    outputExplicit: false,
    progressExplicit: false,
    resultsCsvExplicit: false,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--execute') {
      args.execute = true;
      continue;
    }
    if (arg === '--close-on-finish') {
      args.closeOnFinish = true;
      continue;
    }
    if (arg === '--retry-uncertain') {
      args.retryUncertain = true;
      continue;
    }
    if (arg === '--fresh') {
      args.fresh = true;
      continue;
    }
    if (arg === '--force-contact') {
      args.forceContact = true;
      continue;
    }
    if (arg === '--force-download') {
      args.forceDownload = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const [key, value = ''] = arg.slice(2).split('=');
    if (key === 'test') args.test = parseInt(value, 10) || null;
    if (key === 'order-id' && value) args.orderIds.push(...value.split(',').map(item => item.trim()).filter(Boolean));
    if (key === 'max-pages') args.maxPages = parseInt(value, 10) || args.maxPages;
    if (key === 'output') {
      args.output = value;
      args.outputExplicit = true;
    }
    if (key === 'progress') {
      args.progress = value;
      args.progressExplicit = true;
    }
    if (key === 'confirm') args.confirm = value;
    if (key === 'action') args.action = value || args.action;
    if (key === 'start-date') args.startDate = value || args.startDate;
    if (key === 'end-date') args.endDate = value || args.endDate;
    if (key === 'download-dir') args.downloadDir = value || args.downloadDir;
    if (key === 'config') args.config = value || args.config;
    if (key === 'results-csv') {
      args.resultsCsv = value;
      args.resultsCsvExplicit = true;
    }
    if (key === 'max-retries') args.maxRetries = Math.max(1, parseInt(value, 10) || args.maxRetries);
    if (key === 'manual-timeout-ms') args.manualTimeoutMs = Math.max(30000, parseInt(value, 10) || args.manualTimeoutMs);
    if (key === 'contacted-ledger') args.contactedLedger = value || args.contactedLedger;
    if (key === 'downloaded-ledger') args.downloadedLedger = value || args.downloadedLedger;
    if (key === 'modified-ledger') args.modifiedLedger = value || args.modifiedLedger;
    if (key === 'chat-reply-ledger') args.chatReplyLedger = value || args.chatReplyLedger;
    if (key === 'snapshot-dir') args.snapshotDir = value || args.snapshotDir;
  }

  if (args.action === 'chat' || args.action === 'chat-followup') {
    args.action = 'chat';
    if (!args.outputExplicit) args.output = 'seller-chat-followup.json';
    if (!args.progressExplicit) args.progress = 'seller-chat-followup-progress.json';
    if (!args.resultsCsvExplicit) args.resultsCsv = 'seller-chat-followup.csv';
  }

  return args;
}

const cliArgs = parseArgs();

function safeRelativePath(value, fallbackName) {
  const name = value || fallbackName;
  if (path.isAbsolute(name) || name.includes('..')) {
    throw new Error(`不允许使用项目目录外的路径: ${name}`);
  }
  return path.join(__dirname, name);
}

const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');
const OUTPUT_FILE = safeRelativePath(cliArgs.output, 'invoice-action-plan.json');
const OUTPUT_CSV_FILE = safeRelativePath(
  cliArgs.resultsCsv || cliArgs.output.replace(/\.json$/i, '.csv'),
  'invoice-action-plan.csv'
);
const PROGRESS_FILE = safeRelativePath(cliArgs.progress, 'invoice-action-progress.json');
const CONFIG_FILE = safeRelativePath(cliArgs.config, 'invoice-config.json');
const DOWNLOAD_DIR = safeRelativePath(cliArgs.downloadDir, 'downloads');
const CONTACTED_LEDGER_FILE = safeRelativePath(cliArgs.contactedLedger, 'contacted-orders.json');
const DOWNLOADED_LEDGER_FILE = safeRelativePath(cliArgs.downloadedLedger, 'downloaded-invoices.json');
const MODIFIED_LEDGER_FILE = safeRelativePath(cliArgs.modifiedLedger, 'modified-orders.json');
const CHAT_REPLY_LEDGER_FILE = safeRelativePath(cliArgs.chatReplyLedger, 'seller-chat-replies.json');
const SNAPSHOT_DIR = safeRelativePath(cliArgs.snapshotDir, 'snapshots');
const DEBUG_CHAT_FILE = path.join(__dirname, 'debug-chat-page.json');
const LIST_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const CONFIRM_TEXT = 'YES_EXECUTE_TAOBAO_INVOICE_ACTIONS';

const CONFIG = {
  listWaitTimeout: 20000,
  pageTimeout: 60000,
  detailWaitTimeout: 30000,
  loginWaitTimeout: 180000,
  actionReadyTimeout: 20000,
  manualTimeoutMs: cliArgs.manualTimeoutMs,
  delayMin: 1500,
  delayMax: 3000,
  maxRetries: cliArgs.maxRetries,
};

const LOGIN_URL_MARKERS = [
  'login',
  'havanaone',
  'havanone',
  'passport.taobao.com',
  'login.taobao.com',
  'havanalogin',
];

const ACTION_KEYWORDS = [
  { type: 'download_invoice', words: ['下载发票', '发票下载'] },
  { type: 'send_email', words: ['发送邮箱', '发送到邮箱', '发邮箱'] },
  { type: 'view_invoice', words: ['查看发票', '发票详情', '查看电子发票'] },
  { type: 'reissue_invoice', words: ['换开发票', '换开', '重新开票', '重开发票'] },
  { type: 'modify_invoice', words: ['修改申请', '修改发票', '修改开票信息'] },
  { type: 'apply_invoice', words: ['申请开票', '开具发票', '我要开票'] },
  { type: 'contact_seller', words: ['咨询商家', '联系商家', '联系卖家', '旺旺联系', '联系客服'] },
  { type: 'view_history', words: ['申请历史', '查看申请历史'] },
];

const MUTATING_ACTIONS = new Set(['apply_invoice', 'reissue_invoice', 'modify_invoice', 'send_email']);
const RETRYABLE_STATUS = new Set(['error']);
const UNCERTAIN_STATUS = new Set(['unknown', 'no_action']);
const EXECUTABLE_ACTIONS = new Set(['reissue', 'apply', 'download', 'all', 'chat']);
const TERMINAL_EXECUTION_STATUS = new Set(['submitted', 'pending', 'downloaded', 'file_exists', 'skipped', 'seller_contacted']);

const VERIFICATION_TEXT_MARKERS = [
  '请扫码登录',
  '扫码登录',
  '验证码',
  '请输入验证码',
  '滑动验证',
  '人机验证',
  '安全验证',
  '请完成验证',
  '请拖动滑块',
];

const MESSAGE_FIELD_SELECTORS = [
  'textarea',
  'input[type="text"]',
  'div[contenteditable]',
  'div[contenteditable="true"]',
  '[role="textbox"]',
  '.editBox',
  '.biz-expression-editor',
  '.text-area',
  '[aria-label*="消息"]',
  '[aria-label*="输入"]',
  '[placeholder*="请输入"]',
  '[placeholder*="输入"]',
].join(', ');

const SEND_BUTTON_TEXTS = ['发送', '发 送', '确认发送', '发送消息'];
const WEB_CHAT_TEXTS = ['网页聊天', '网页版聊天', '继续网页聊天', '继续网页版聊天', '继续使用网页聊天', '留在网页版'];
const CHAT_HINT_CLOSE_SELECTORS = ['.next-balloon-close', '[aria-label="关闭"]', '[title="关闭"]'];
const CHAT_INVOICE_FILE_EXTENSIONS = ['.pdf', '.ofd', '.xml', '.zip', '.rar', '.7z', '.jpg', '.jpeg', '.png', '.webp'];
const CHAT_INVOICE_LINK_PATTERN = /发票|电子票|电子发票|开票|附件|文件|下载|pdf|ofd|invoice|fapiao|bill/i;
const CHAT_PAYMENT_PATTERN = /补差|差价|差额|付款|支付|收款码|补款|补邮费|补运费/;
const CHAT_INFO_REQUEST_PATTERN = /请.*(提供|补充|发送).*(邮箱|抬头|税号|纳税人|资料|信息)|需要.*(邮箱|抬头|税号|纳税人|资料|信息)|(邮箱|抬头|税号|纳税人识别号).*(发一下|提供一下|发我|给我)/;
const CHAT_REJECTION_PATTERN = /无法开|不能开|开不了|不给开|不支持开|已超过|过期|超时|无法补开|无法重开/;
const CHAT_FILE_DOWNLOAD_TEXTS = ['下载文件', '下载附件', '保存文件', '下载'];

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

const DEFAULT_SELLER_MESSAGE_TEMPLATE = [
  '您好，这笔订单需要申请开具发票。订单号：{orderId}。烦请协助开具发票。',
  '发票信息如下：发票抬头：{companyName}；税号：{taxNo}；发票类型：{invoiceType}；接收邮箱：{email}。',
  '如需补充信息，请告知，谢谢。',
].join(' ');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, fallbackValue) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function randomDelay() {
  const { delayMin, delayMax } = CONFIG;
  return sleep(delayMin + Math.random() * (delayMax - delayMin));
}

function isLoginOrVerifyUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return LOGIN_URL_MARKERS.some(marker => normalized.includes(marker));
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    console.error('⚠️  进度文件损坏，从头开始:', e.message);
    return null;
  }
}

function loadInvoiceConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`找不到配置文件: ${CONFIG_FILE}。请复制 invoice-config.example.json 为 invoice-config.json 并填写公司信息。`);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const required = ['companyName', 'taxNo'];
  for (const key of required) {
    if (!config[key] || typeof config[key] !== 'string') {
      throw new Error(`配置文件缺少 ${key}`);
    }
  }

  return {
    companyName: config.companyName.trim(),
    taxNo: config.taxNo.trim(),
    email: (config.email || '').trim(),
    phone: (config.phone || '').trim(),
    address: (config.address || '').trim(),
    bankName: (config.bankName || '').trim(),
    bankAccount: (config.bankAccount || '').trim(),
    sellerMessageTemplate: (config.sellerMessageTemplate || '').trim(),
  };
}

function saveJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function saveDebugJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function buildRedactionSecrets(invoiceConfig = {}) {
  return Object.values(invoiceConfig || {})
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(value => value.length >= 4 && !/^EXAMPLE_/i.test(value));
}

function redactSensitiveText(text, invoiceConfig = {}) {
  let next = String(text || '');
  for (const secret of buildRedactionSecrets(invoiceConfig)) {
    next = next.split(secret).join(`[REDACTED_${secret.length}]`);
  }
  return next;
}

async function collectPageSnapshot(page, mapping, label, invoiceConfig = {}, options = {}) {
  const { saveArtifacts = false, historyText = '', invoiceInfo = null, candidates = null } = options;
  const capturedAt = new Date().toISOString();
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const title = await page.title().catch(() => '');
  const url = page.url();
  const buttonTexts = await page.evaluate(() => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    return [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(isVisible)
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 120);
  }).catch(() => []);
  const actionCandidates = candidates || await collectActionCandidates(page).catch(() => []);

  const snapshot = {
    capturedAt,
    label,
    orderId: mapping?.bizOrderId || '',
    url,
    title,
    text: bodyText,
    historyText,
    buttons: buttonTexts,
    candidates: actionCandidates,
    invoiceInfo,
    artifacts: {},
  };

  if (!saveArtifacts) return snapshot;

  ensureDirectory(SNAPSHOT_DIR);
  const stamp = capturedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const baseName = [
    stamp,
    sanitizeFilenamePart(mapping?.bizOrderId || 'unknown_order'),
    sanitizeFilenamePart(label || 'snapshot'),
  ].filter(Boolean).join('_');
  const screenshotPath = path.join(SNAPSHOT_DIR, `${baseName}.png`);
  const htmlPath = path.join(SNAPSHOT_DIR, `${baseName}.html`);
  const textPath = path.join(SNAPSHOT_DIR, `${baseName}.txt`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
  const html = await page.content().catch(() => '');
  fs.writeFileSync(htmlPath, redactSensitiveText(html, invoiceConfig), 'utf8');
  fs.writeFileSync(textPath, redactSensitiveText(bodyText, invoiceConfig), 'utf8');

  snapshot.artifacts = {
    screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : '',
    htmlSnapshotPath: htmlPath,
    textSnapshotPath: textPath,
  };
  return snapshot;
}

function loadContactedLedger() {
  if (!fs.existsSync(CONTACTED_LEDGER_FILE)) {
    return { version: '0.1.0', orders: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTACTED_LEDGER_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: parsed.version || '0.1.0',
        generatedFromArtifactsAt: parsed.generatedFromArtifactsAt || '',
        updatedAt: parsed.updatedAt || '',
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
      };
    }
  } catch (error) {
    console.error(`⚠️  联系商家台账读取失败，将新建台账: ${error.message}`);
  }
  return { version: '0.1.0', orders: {} };
}

function saveContactedLedger(ledger) {
  saveJsonAtomic(CONTACTED_LEDGER_FILE, {
    version: ledger.version || '0.1.0',
    generatedFromArtifactsAt: ledger.generatedFromArtifactsAt || '',
    updatedAt: new Date().toISOString(),
    orders: ledger.orders || {},
  });
}

function loadDownloadedLedger() {
  if (!fs.existsSync(DOWNLOADED_LEDGER_FILE)) {
    return { version: '0.1.0', orders: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DOWNLOADED_LEDGER_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: parsed.version || '0.1.0',
        updatedAt: parsed.updatedAt || '',
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
      };
    }
  } catch (error) {
    console.error(`⚠️  下载台账读取失败，将新建台账: ${error.message}`);
  }
  return { version: '0.1.0', orders: {} };
}

function saveDownloadedLedger(ledger) {
  saveJsonAtomic(DOWNLOADED_LEDGER_FILE, {
    version: ledger.version || '0.1.0',
    updatedAt: new Date().toISOString(),
    orders: ledger.orders || {},
  });
}

function getDownloadedLedgerRecord(orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) return null;
  const ledger = loadDownloadedLedger();
  const record = ledger.orders?.[normalizedOrderId] || null;
  if (!record?.path) return record;
  return fs.existsSync(record.path) ? record : null;
}

function recordDownloadedInvoice(mapping, downloadResult, inspection) {
  const orderId = String(mapping?.bizOrderId || '').trim();
  if (!orderId || !downloadResult?.path) return null;
  const ledger = loadDownloadedLedger();
  const existing = ledger.orders?.[orderId] || {};
  const record = {
    orderId,
    shopName: mapping.shopName || inspection?.orderMeta?.shopName || existing.shopName || '',
    amount: mapping.amount || inspection?.orderMeta?.amount || existing.amount || '',
    orderDate: mapping.orderDate || existing.orderDate || '',
    invoiceType: inspection?.invoiceInfo?.invoiceType || existing.invoiceType || '',
    invoiceTitle: inspection?.invoiceInfo?.invoiceTitle || existing.invoiceTitle || '',
    filename: downloadResult.filename || existing.filename || '',
    path: downloadResult.path || existing.path || '',
    downloadedAt: downloadResult.downloadedAt || existing.downloadedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  ledger.orders = { ...(ledger.orders || {}), [orderId]: record };
  saveDownloadedLedger(ledger);
  return record;
}

function loadChatReplyLedger() {
  if (!fs.existsSync(CHAT_REPLY_LEDGER_FILE)) {
    return { version: '0.1.0', orders: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CHAT_REPLY_LEDGER_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: parsed.version || '0.1.0',
        updatedAt: parsed.updatedAt || '',
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
      };
    }
  } catch (error) {
    console.error(`⚠️  商家聊天回访台账读取失败，将新建台账: ${error.message}`);
  }
  return { version: '0.1.0', orders: {} };
}

function saveChatReplyLedger(ledger) {
  saveJsonAtomic(CHAT_REPLY_LEDGER_FILE, {
    version: ledger.version || '0.1.0',
    updatedAt: new Date().toISOString(),
    orders: ledger.orders || {},
  });
}

function getChatReplyLedgerRecord(orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) return null;
  const ledger = loadChatReplyLedger();
  return ledger.orders?.[normalizedOrderId] || null;
}

function recordChatReplyOrder(mapping, result, patch = {}) {
  const orderId = String(mapping?.bizOrderId || mapping?.orderId || '').trim();
  if (!orderId) return null;
  const ledger = loadChatReplyLedger();
  const existing = ledger.orders?.[orderId] || {};
  const record = {
    orderId,
    shopName: mapping.shopName || existing.shopName || '',
    amount: mapping.amount || existing.amount || '',
    orderDate: mapping.orderDate || existing.orderDate || '',
    status: result?.status || patch.status || existing.status || '',
    reason: result?.reason || patch.reason || existing.reason || '',
    replyCategory: result?.replyCategory || patch.replyCategory || existing.replyCategory || '',
    invoiceFilePath: result?.downloadResult?.path || result?.downloadResult?.existingPath || patch.invoiceFilePath || existing.invoiceFilePath || '',
    invoiceLink: result?.invoiceLink || patch.invoiceLink || existing.invoiceLink || '',
    finalUrl: result?.finalUrl || patch.finalUrl || existing.finalUrl || '',
    checkedAt: result?.checkedAt || patch.checkedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  ledger.orders = { ...(ledger.orders || {}), [orderId]: record };
  saveChatReplyLedger(ledger);
  return record;
}

function loadModifiedLedger() {
  if (!fs.existsSync(MODIFIED_LEDGER_FILE)) {
    return { version: '0.1.0', orders: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(MODIFIED_LEDGER_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: parsed.version || '0.1.0',
        updatedAt: parsed.updatedAt || '',
        generatedFromArtifactsAt: parsed.generatedFromArtifactsAt || '',
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
      };
    }
  } catch (error) {
    console.error(`⚠️  修改/换开台账读取失败，将新建台账: ${error.message}`);
  }
  return { version: '0.1.0', orders: {} };
}

function saveModifiedLedger(ledger) {
  saveJsonAtomic(MODIFIED_LEDGER_FILE, {
    version: ledger.version || '0.1.0',
    updatedAt: new Date().toISOString(),
    generatedFromArtifactsAt: ledger.generatedFromArtifactsAt || '',
    orders: ledger.orders || {},
  });
}

function getModifiedLedgerRecord(orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) return null;
  const ledger = loadModifiedLedger();
  return ledger.orders?.[normalizedOrderId] || null;
}

function recordModifiedOrder(mapping, execution, patch = {}) {
  const orderId = String(mapping?.bizOrderId || '').trim();
  if (!orderId) return null;
  const ledger = loadModifiedLedger();
  const existing = ledger.orders?.[orderId] || {};
  const record = {
    orderId,
    shopName: mapping.shopName || existing.shopName || '',
    amount: mapping.amount || existing.amount || '',
    orderDate: mapping.orderDate || existing.orderDate || '',
    action: execution?.action || patch.action || existing.action || '',
    status: execution?.status || patch.status || existing.status || '',
    reason: execution?.reason || patch.reason || existing.reason || '',
    submittedAt: execution?.executedAt || patch.submittedAt || existing.submittedAt || new Date().toISOString(),
    finalUrl: execution?.finalUrl || patch.finalUrl || existing.finalUrl || '',
    updatedAt: new Date().toISOString(),
  };
  ledger.orders = { ...(ledger.orders || {}), [orderId]: record };
  saveModifiedLedger(ledger);
  return record;
}

function getContactedLedgerRecord(orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) return null;
  const ledger = loadContactedLedger();
  return ledger.orders?.[normalizedOrderId] || null;
}

function recordContactedOrder(mapping, message, patch = {}) {
  const orderId = String(mapping?.bizOrderId || '').trim();
  if (!orderId) return null;
  const ledger = loadContactedLedger();
  const existing = ledger.orders?.[orderId] || {};
  const record = {
    orderId,
    shopName: mapping.shopName || existing.shopName || '',
    amount: mapping.amount || existing.amount || '',
    orderDate: mapping.orderDate || existing.orderDate || '',
    invoiceUrl: mapping.invoiceUrl || mapping.detailUrl || mapping.url || existing.invoiceUrl || '',
    rejectType: mapping.rejectInfo?.rejectType || existing.rejectType || '',
    rejectReason: mapping.rejectInfo?.rejectReason || mapping.contactReason || existing.rejectReason || '',
    message: message || existing.message || '',
    contactedAt: patch.contactedAt || existing.contactedAt || new Date().toISOString(),
    finalUrl: patch.finalUrl || existing.finalUrl || '',
    source: patch.source || existing.source || '',
    updatedAt: new Date().toISOString(),
  };
  ledger.orders = { ...(ledger.orders || {}), [orderId]: record };
  saveContactedLedger(ledger);
  return record;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function saveResultsCsv(file, results) {
  const headers = [
    'order_id',
    'platform',
    'order_date',
    'shop_name',
    'amount',
    'invoice_type',
    'invoice_title',
    'action',
    'state',
    'status',
    'page_classification',
    'matched_rules',
    'failure_reason',
    'price_diff_amount',
    'invoice_file_path',
    'chat_reply_category',
    'chat_invoice_link',
    'screenshot_path',
    'html_snapshot_path',
    'processed_at',
  ];
  const rows = [headers.join(',')];
  for (const result of results) {
    rows.push([
      result.bizOrderId || '',
      result.platform || '',
      result.orderDate || '',
      result.orderMeta?.shopName || result.shopName || '',
      result.orderMeta?.amount || result.amount || '',
      result.invoiceInfo?.invoiceType || '',
      result.invoiceInfo?.invoiceTitle || '',
      result.execution?.action || result.actionPlan?.action || '',
      result.state || result.execution?.state || '',
      result.execution?.status || result.status || '',
      result.pageClassification?.category || '',
      (result.pageClassification?.matchedRules || []).map(rule => rule.id).join('|'),
      result.execution?.reason || result.error || '',
      result.pageClassification?.priceDiff?.amount || result.execution?.pageClassification?.priceDiff?.amount || '',
      result.execution?.downloadResult?.path || result.execution?.downloadResult?.existingPath || result.execution?.chatReplyResult?.downloadResult?.path || result.execution?.chatReplyResult?.downloadResult?.existingPath || '',
      result.execution?.chatReplyResult?.replyCategory || result.chatReply?.replyCategory || '',
      result.execution?.chatReplyResult?.invoiceLink || result.chatReply?.invoiceLink || '',
      result.artifacts?.screenshotPath || result.execution?.snapshot?.screenshotPath || '',
      result.artifacts?.htmlSnapshotPath || result.execution?.snapshot?.htmlSnapshotPath || '',
      result.execution?.executedAt || result.checkedAt || '',
    ].map(csvEscape).join(','));
  }
  fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf8');
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function buildInvoiceReceiveType(invoiceConfig) {
  return invoiceConfig.address ? '普票/专票' : '普票';
}

function buildInvoiceFilename(mapping, inspection, suggestedFilename) {
  const ext = path.extname(suggestedFilename) || '.pdf';
  const invoiceType = inspection?.invoiceInfo?.invoiceType || mapping.invoiceInfo?.invoiceType || 'unknown';
  const base = [
    mapping.bizOrderId,
    mapping.shopName || inspection?.orderMeta?.shopName || 'unknown_shop',
    mapping.amount || inspection?.orderMeta?.amount || 'unknown_amount',
    invoiceType,
    mapping.orderDate || 'unknown_date',
  ].map(sanitizeFilenamePart).filter(Boolean).join('_');
  return `${base}${ext}`;
}

function buildChatInvoiceFilename(mapping, suggestedFilename) {
  const ext = path.extname(suggestedFilename || '') || '.pdf';
  const base = [
    mapping.bizOrderId || mapping.orderId || 'unknown_order',
    mapping.shopName || 'unknown_shop',
    mapping.amount || 'unknown_amount',
    'chat_reply_invoice',
    mapping.orderDate || formatDate(new Date()),
  ].map(sanitizeFilenamePart).filter(Boolean).join('_');
  return `${base}${ext}`;
}

function ensureUniqueFilePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const ext = path.extname(targetPath);
  const base = targetPath.slice(0, targetPath.length - ext.length);
  let index = 2;
  while (true) {
    const candidate = `${base}_${index}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
    index += 1;
  }
}

function normalizeUrl(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href.startsWith('//') ? `https:${href}` : href, baseUrl).href;
  } catch {
    return href;
  }
}

function classifyPageErrorText(text) {
  const parsed = classifyRichPageErrorText(text);
  const legacyType = {
    deadline_exceeded: 'expired',
    wrong_title: 'wrongTitle',
    wrong_tax_no: 'wrongTaxNo',
    missing_email: 'missingEmail',
    missing_supplement_info: 'missingInfo',
    amount_mismatch: 'amountMismatch',
    seller_rejected: 'rejected',
    security_verification: 'verification',
  };
  const hits = parsed.hits.map(hit => ({
    ...hit,
    type: legacyType[hit.type] || hit.type,
  }));
  return {
    ...parsed,
    hits,
    hasRetryableError: hits.some(hit => ['wrongTitle', 'wrongTaxNo', 'missingEmail', 'missingInfo', 'amountMismatch'].includes(hit.type)),
    hasExpiredError: hits.some(hit => hit.type === 'expired'),
    hasVerificationError: parsed.hasVerificationError || VERIFICATION_TEXT_MARKERS.some(marker => String(text || '').includes(marker)),
    primaryReason: hits[0]?.matched || parsed.primaryReason || '',
  };
}

function textIncludesAny(text, words) {
  return words.some(word => String(text || '').includes(word));
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

function classifyRejectedInvoiceHandling(inspection, history) {
  const detailText = inspection?.detailBodyText || '';
  const historyText = history?.historyText || '';
  const combinedText = `${detailText}\n${historyText}`;
  const hasRejectedState = textIncludesAny(combinedText, [
    '商家拒绝',
    '卖家拒绝了发票申请',
    '拒绝了发票申请',
    '审核不通过',
    '审核未通过',
    '申请失败',
    '拒绝开票',
  ]);

  if (!hasRejectedState) {
    return { action: 'continue', reason: '', rejectInfo: extractLatestRejectInfo(historyText) };
  }

  const rejectInfo = extractLatestRejectInfo(historyText);
  const rejectType = rejectInfo.latest.rejectType || '';
  const rejectReason = rejectInfo.latest.rejectReason || '';
  const reasonText = `${rejectType}\n${rejectReason}`;
  const parseResult = classifyPageErrorText(`${reasonText}\n${combinedText}`);
  const hasModifyEntry = inspection?.candidates?.some(candidate => (
    candidate.type === 'modify_invoice' && candidate.visible && !candidate.disabled
  ));

  if (!rejectReason && history?.opened) {
    return {
      action: 'manual_required',
      reason: '已读取申请历史，但未解析到明确拒绝原因，请人工确认',
      rejectInfo,
      parseResult,
    };
  }
  if (!history?.opened) {
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

function buildSellerMessage(mapping, invoiceConfig) {
  const replacements = {
    orderId: mapping.bizOrderId || '',
    companyName: invoiceConfig.companyName || '',
    taxNo: invoiceConfig.taxNo || '',
    invoiceType: '普票',
    email: invoiceConfig.email || '无',
  };

  return (invoiceConfig.sellerMessageTemplate || DEFAULT_SELLER_MESSAGE_TEMPLATE)
    .replace(/\{(\w+)\}/g, (_, key) => replacements[key] || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeIdentifier(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function looksLikeTaxNo(value, configuredTaxNo = '') {
  const normalized = normalizeIdentifier(value);
  const expected = normalizeIdentifier(configuredTaxNo);
  if (!normalized) return false;
  if (expected && normalized === expected) return true;
  return /^[0-9A-Z]{15,20}$/.test(normalized) && /\d{10,}/.test(normalized);
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bodyShowsTaxNoAsInvoiceTitle(text, invoiceConfig = {}) {
  const taxNo = normalizeIdentifier(invoiceConfig.taxNo);
  if (!taxNo) return false;
  const compact = normalizeIdentifier(text);
  if (!compact.includes(taxNo)) return false;

  const readable = String(text || '').replace(/\s+/g, '');
  const taxPattern = String(invoiceConfig.taxNo || '')
    .split('')
    .map(escapeRegExp)
    .join('\\s*');
  return new RegExp(`(?:发票|抬头|企业)[^\\n\\r]{0,20}${taxPattern}`).test(readable)
    || readable.includes(`企业-${invoiceConfig.taxNo}`)
    || readable.includes(`发票${invoiceConfig.taxNo}`);
}

function looksLikePlatformCustomerService(url) {
  const normalized = String(url || '').toLowerCase();
  return normalized.includes('consumerservice.taobao.com')
    || normalized.includes('helpcenter.taobao.com')
    || normalized.includes('/online-help');
}

function isDateInRange(dateText) {
  if (!dateText) return false;
  return dateText >= cliArgs.startDate && dateText <= cliArgs.endDate;
}

function isBeforeStartDate(dateText) {
  if (!dateText) return false;
  return dateText < cliArgs.startDate;
}

function getMonthKey(dateText) {
  return typeof dateText === 'string' && dateText.length >= 7 ? dateText.slice(0, 7) : '';
}

function buildInvoiceDetailUrl(orderId) {
  return `https://invoice-ua.taobao.com/detail/pc#/?orderId=${orderId}`;
}

function buildFallbackMappingFromOrderId(orderId) {
  const bizOrderId = String(orderId || '').trim();
  return {
    bizOrderId,
    platform: 'taobao',
    orderDate: '',
    amount: '',
    shopName: '',
    url: buildInvoiceDetailUrl(bizOrderId),
    detailUrl: '',
    invoiceUrl: buildInvoiceDetailUrl(bizOrderId),
    sourceTag: 'direct_invoice_detail',
  };
}

function buildExpiredDeadlineSkipResult(mapping, skippedFromDate) {
  return {
    status: 'ok',
    ...mapping,
    invoiceInfo: { invoiceType: 'no_invoice', invoiceTitle: '未开票', confidence: 'low' },
    actionPlan: {
      action: 'apply_invoice',
      confidence: 'medium',
      reason: '同月较新的订单已明确超过开票日期，更早订单直接跳过',
    },
    candidates: [],
    checkedAt: new Date().toISOString(),
    execution: {
      status: 'expired_deadline',
      reason: `同月 ${skippedFromDate} 已明确超过开票日期，跳过更早订单`,
      inferred: true,
      executedAt: new Date().toISOString(),
    },
  };
}

function mergeMappingCandidate(targetMap, candidate) {
  if (!candidate || !candidate.bizOrderId) return;
  const existing = targetMap.get(candidate.bizOrderId) || {};
  const merged = {
    ...existing,
    ...candidate,
    bizOrderId: candidate.bizOrderId || existing.bizOrderId || '',
    platform: candidate.platform || existing.platform || '',
    orderDate: candidate.orderDate || existing.orderDate || '',
    amount: candidate.amount || existing.amount || '',
    shopName: candidate.shopName || existing.shopName || '',
    url: candidate.url || existing.url || candidate.detailUrl || existing.detailUrl || candidate.invoiceUrl || existing.invoiceUrl || '',
    detailUrl: candidate.detailUrl || existing.detailUrl || candidate.url || existing.url || '',
    invoiceUrl: candidate.invoiceUrl || existing.invoiceUrl || '',
  };
  targetMap.set(merged.bizOrderId, merged);
}

function getArtifactFiles() {
  return [
    'invoice-action-2025-2026-execute.json',
    'invoice-action-2025-2026-progress.json',
    'invoice-action-2025-2026-status-2026-05-14.json',
    'invoice-action-2025-2026-status-2026-05-14.progress.json',
    'invoice-action-expired-contact.json',
    'invoice-action-expired-contact-progress.json',
    'repair-paper-invoices-2026-05-15.json',
    'repair-paper-invoices-2026-05-15.progress.json',
    'repair-paper-invoices-2026-05-14.json',
    'repair-pending-invoices-2026-05-14.json',
  ];
}

function collectMappingsFromArtifacts() {
  const candidates = new Map();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const bizOrderId = typeof node.bizOrderId === 'string'
      ? node.bizOrderId
      : typeof node.orderId === 'string' && /^\d{8,}$/.test(node.orderId)
        ? node.orderId
        : '';
    if (bizOrderId) {
      mergeMappingCandidate(candidates, {
        bizOrderId,
        platform: typeof node.platform === 'string' ? node.platform : '',
        orderDate: typeof node.orderDate === 'string' ? node.orderDate : '',
        amount: typeof node.amount === 'string'
          ? node.amount
          : typeof node.orderMeta?.amount === 'string'
            ? node.orderMeta.amount
            : '',
        shopName: typeof node.shopName === 'string'
          ? node.shopName
          : typeof node.orderMeta?.shopName === 'string'
            ? node.orderMeta.shopName
            : '',
        url: typeof node.url === 'string'
          ? node.url
          : typeof node.detailUrl === 'string'
            ? node.detailUrl
            : typeof node.invoiceUrl === 'string'
              ? node.invoiceUrl
              : '',
        detailUrl: typeof node.detailUrl === 'string' ? node.detailUrl : '',
        invoiceUrl: typeof node.invoiceUrl === 'string' ? node.invoiceUrl : '',
      });
    }

    for (const value of Object.values(node)) {
      visit(value);
    }
  }

  for (const fileName of getArtifactFiles()) {
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      visit(parsed);
    } catch (error) {
      console.error(`⚠️  读取历史映射失败 ${fileName}: ${error.message}`);
    }
  }

  return candidates;
}

function getExecutionStatusPriority(status) {
  const priorities = {
    seller_contacted: 500,
    downloaded: 450,
    submitted: 400,
    pending: 350,
    skipped: 300,
  };
  return priorities[status] || 0;
}

function compareArtifactResults(left, right) {
  const leftStatus = left?.execution?.status || '';
  const rightStatus = right?.execution?.status || '';
  const priorityDiff = getExecutionStatusPriority(leftStatus) - getExecutionStatusPriority(rightStatus);
  if (priorityDiff !== 0) return priorityDiff;

  const leftTime = new Date(
    left?.execution?.executedAt || left?.checkedAt || left?.generatedAt || 0
  ).getTime() || 0;
  const rightTime = new Date(
    right?.execution?.executedAt || right?.checkedAt || right?.generatedAt || 0
  ).getTime() || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;

  const leftReason = String(left?.execution?.reason || left?.reason || '');
  const rightReason = String(right?.execution?.reason || right?.reason || '');
  return leftReason.length - rightReason.length;
}

function artifactLooksLikeWrongTitle(node) {
  let invoiceConfig = {};
  try {
    invoiceConfig = loadInvoiceConfig();
  } catch {
    invoiceConfig = {};
  }
  const texts = [
    node?.detailBodyText,
    node?.bodyText,
    node?.historyText,
    node?.invoiceInfo?.invoiceTitle,
    node?.execution?.existingApplication?.reason,
    node?.execution?.reason,
  ].filter(value => typeof value === 'string').join('\n');
  return node?.invoiceInfo?.invoiceType === 'wrong_company_title'
    || node?.execution?.existingApplication?.titleLooksLikeTaxNo === true
    || bodyShowsTaxNoAsInvoiceTitle(texts, invoiceConfig);
}

function collectTerminalResultsFromArtifacts() {
  const results = new Map();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const bizOrderId = typeof node.bizOrderId === 'string' ? node.bizOrderId : '';
    const executionStatus = node?.execution?.status;
    if (bizOrderId && TERMINAL_EXECUTION_STATUS.has(executionStatus) && !artifactLooksLikeWrongTitle(node)) {
      const current = results.get(bizOrderId);
      if (!current || compareArtifactResults(node, current) > 0) {
        results.set(bizOrderId, node);
      }
    }

    for (const value of Object.values(node)) {
      visit(value);
    }
  }

  for (const fileName of getArtifactFiles()) {
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      visit(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
      console.error(`⚠️  读取历史终态失败 ${fileName}: ${error.message}`);
    }
  }

  return results;
}

function seedContactedLedgerFromArtifacts() {
  const ledger = loadContactedLedger();
  let changed = false;

  for (const [orderId, artifact] of collectTerminalResultsFromArtifacts()) {
    if (artifact?.execution?.status !== 'seller_contacted') continue;
    if (ledger.orders?.[orderId]) continue;

    const contactResult = artifact.execution.contactResult || {};
    const message = contactResult.message || artifact.execution.message || '';
    ledger.orders = ledger.orders || {};
    ledger.orders[orderId] = {
      orderId,
      shopName: artifact.shopName || artifact.orderMeta?.shopName || '',
      amount: artifact.amount || artifact.orderMeta?.amount || '',
      orderDate: artifact.orderDate || '',
      invoiceUrl: artifact.invoiceUrl || artifact.detailUrl || artifact.url || '',
      rejectType: artifact.rejectedDecision?.rejectInfo?.latest?.rejectType || '',
      rejectReason: artifact.rejectedDecision?.rejectInfo?.latest?.rejectReason || '',
      message,
      contactedAt: contactResult.executedAt || artifact.execution.executedAt || artifact.checkedAt || new Date().toISOString(),
      finalUrl: contactResult.finalUrl || artifact.execution.finalUrl || '',
      source: 'artifact_seed',
      updatedAt: new Date().toISOString(),
    };
    changed = true;
  }

  if (changed) {
    ledger.generatedFromArtifactsAt = ledger.generatedFromArtifactsAt || new Date().toISOString();
    saveContactedLedger(ledger);
    console.log(`🧾 已从历史结果补全联系商家台账: ${CONTACTED_LEDGER_FILE}`);
  }
}

function seedModifiedLedgerFromArtifacts() {
  const ledger = loadModifiedLedger();
  let changed = false;
  const files = fs.readdirSync(__dirname)
    .filter(fileName => /^(invoice-action|repair-).*\.(json)$/i.test(fileName))
    .filter(fileName => !fileName.includes('progress') && fileName !== path.basename(MODIFIED_LEDGER_FILE));

  function visit(node, sourceFile) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(item => visit(item, sourceFile));
      return;
    }

    const orderId = typeof node.bizOrderId === 'string' ? node.bizOrderId : '';
    const execution = node.execution || {};
    const action = execution.action || '';
    const status = execution.status || '';
    const state = node.state || execution.state || '';
    if (orderId
      && ['modify_invoice', 'reissue_invoice'].includes(action)
      && ['submitted', 'pending'].includes(status)
      && !ledger.orders?.[orderId]) {
      ledger.orders = ledger.orders || {};
      ledger.orders[orderId] = {
        orderId,
        shopName: node.shopName || node.orderMeta?.shopName || '',
        amount: node.amount || node.orderMeta?.amount || '',
        orderDate: node.orderDate || '',
        action,
        status,
        state,
        reason: execution.reason || '',
        submittedAt: execution.executedAt || node.checkedAt || new Date().toISOString(),
        finalUrl: execution.finalUrl || node.detailUrl || '',
        source: sourceFile,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    }

    for (const value of Object.values(node)) {
      visit(value, sourceFile);
    }
  }

  for (const fileName of files) {
    try {
      visit(JSON.parse(fs.readFileSync(path.join(__dirname, fileName), 'utf8')), fileName);
    } catch {
      // Ignore partial or obsolete local run artifacts.
    }
  }

  if (changed) {
    ledger.generatedFromArtifactsAt = ledger.generatedFromArtifactsAt || new Date().toISOString();
    saveModifiedLedger(ledger);
    console.log(`🧾 已从历史结果补全修改/换开台账: ${MODIFIED_LEDGER_FILE}`);
  }
}

async function ensureLoggedIn(page) {
  console.log('📄 验证登录...');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
  await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
  await sleep(1000);

  if (!isLoginOrVerifyUrl(page.url())) {
    console.log('✅ 已登录');
    return;
  }

  console.log('\n⚠️  需要登录！请在浏览器中扫码或完成验证...');
  try {
    await page.waitForFunction(
      markers => !markers.some(marker => location.href.toLowerCase().includes(marker)),
      LOGIN_URL_MARKERS,
      { timeout: CONFIG.loginWaitTimeout }
    );
  } catch (error) {
    throw new Error('登录/验证未在超时时间内完成，请手动完成后重试');
  }
  console.log('✅ 登录成功');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
  await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
  await sleep(1000);
}

async function waitForRelevantPageContent(page, timeout = CONFIG.actionReadyTimeout) {
  await page.waitForFunction(({ actionWords, verificationWords }) => {
    const bodyText = document.body?.innerText || '';
    return actionWords.some(word => bodyText.includes(word)) || verificationWords.some(word => bodyText.includes(word));
  }, {
    actionWords: ACTION_KEYWORDS.flatMap(group => group.words),
    verificationWords: VERIFICATION_TEXT_MARKERS,
  }, { timeout }).catch(() => null);
}

async function pauseForManualVerification(page, reason) {
  console.log(`⚠️  触发人工验证: ${reason}`);
  await waitForRelevantPageContent(page, CONFIG.manualTimeoutMs);
  const currentText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const parseResult = classifyPageErrorText(currentText);
  if (parseResult.hasVerificationError || isLoginOrVerifyUrl(page.url())) {
    return { resolved: false, reason: '人工验证未完成' };
  }
  return { resolved: true, reason: '人工验证已完成' };
}

async function extractBizOrderIds(page) {
  console.log('\n📋 从订单列表提取订单详情链接...');
  const allMappings = [];

  for (let currentPage = 1; currentPage <= cliArgs.maxPages; currentPage++) {
    console.log(`  第 ${currentPage}/${cliArgs.maxPages} 页...`);
    await page.waitForSelector('body', { timeout: CONFIG.listWaitTimeout });
    await sleep(1500);
    try { await page.click('text=知道了', { timeout: 1500 }); } catch {}

    const mappings = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const links = document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]');
      links.forEach(link => {
        const text = (link.textContent || '').trim();
        const href = link.getAttribute('href') || '';
        if (text && !text.includes('订单详情') && !href.includes('/detail/')) return;

        const tmallMatch = href.match(/bizOrderId=(\d+)/);
        const taobaoMatch = href.match(/biz_order_id=(\d+)/);
        const bizOrderId = tmallMatch?.[1] || taobaoMatch?.[1] || '';
        if (!bizOrderId || seen.has(bizOrderId)) return;
        seen.add(bizOrderId);

        const container = link.closest('[id^="shopOrderContainer_"]') || link.closest('.trade-container') || link.parentElement;
        const containerText = container?.innerText || '';
        const orderDate = containerText.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
        const amountMatch = containerText.match(/实付款[\s\S]{0,20}?¥\s*([0-9.,]+)/) || containerText.match(/￥\s*([0-9.,]+)/);
        const amount = amountMatch?.[1] ? amountMatch[1].replace(/,/g, '') : '';
        const shopName = (
          containerText.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,40}(旗舰店|专卖店|企业店|店铺))/)?.[1]
          || ''
        ).trim();

        results.push({
          bizOrderId,
          platform: tmallMatch ? 'tmall' : 'taobao',
          orderDate,
          amount,
          shopName,
          url: new URL(href.startsWith('//') ? `https:${href}` : href, location.href).href,
        });
      });
      return results;
    });

    const inRangeMappings = mappings.filter(mapping => !mapping.orderDate || isDateInRange(mapping.orderDate));
    console.log(`    找到 ${mappings.length} 个详情链接，其中日期范围内 ${inRangeMappings.length} 个`);
    allMappings.push(...inRangeMappings);

    const datedMappings = mappings.filter(mapping => mapping.orderDate);
    if (datedMappings.length > 0 && datedMappings.every(mapping => isBeforeStartDate(mapping.orderDate))) {
      console.log(`    本页订单均早于 ${cliArgs.startDate}，停止翻页`);
      break;
    }

    if (currentPage >= cliArgs.maxPages) break;

    try {
      const beforeIds = mappings.map(m => m.bizOrderId).sort().join(',');
      await page.click('text=下一页', { timeout: 3000 });
      await page.waitForFunction((previousIds) => {
        const ids = [];
        document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]').forEach(link => {
          const href = link.getAttribute('href') || '';
          const match = href.match(/bizOrderId=(\d+)/) || href.match(/biz_order_id=(\d+)/);
          if (match) ids.push(match[1]);
        });
        return ids.length > 0 && [...new Set(ids)].sort().join(',') !== previousIds;
      }, beforeIds, { timeout: 10000 }).catch(() => null);
      await sleep(1000);
    } catch {
      console.log('    未找到下一页，停止');
      break;
    }
  }

  const seen = new Set();
  const unique = allMappings.filter(mapping => {
    if (seen.has(mapping.bizOrderId)) return false;
    seen.add(mapping.bizOrderId);
    return true;
  });

  console.log(`  总计: ${unique.length} 个唯一订单`);
  return unique;
}

function classifyInvoiceText(bodyText) {
  const companyTitleKeywords = [
    '公司',
    '有限',
    '企业',
    '集团',
    '中心',
    '工作室',
    '事务所',
    '研究院',
    '学校',
    '大学',
    '医院',
    '委员会',
    '协会',
    '银行',
    '厂',
  ];

  function matchField(labels, maxLen) {
    for (const label of labels) {
      const pattern = new RegExp(`${label}[：:\\s]*([^\\n\\r]{1,${maxLen}})`);
      const match = bodyText.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
    return '';
  }

  function looksLikeCompanyTitle(title) {
    if (!title || title.includes('个人')) return false;
    if (companyTitleKeywords.some(keyword => title.includes(keyword))) return true;
    return title.length >= 6 && !/先生|女士|小姐/.test(title);
  }

  const title = matchField(['发票抬头', '抬头名称', '购买方名称', '购方名称', '购买方', '抬头'], 60);
  if (looksLikeCompanyTitle(title)) {
    if (looksLikeTaxNo(title)) {
      return { invoiceType: 'wrong_company_title', invoiceTitle: `错抬头-疑似税号-${title}`, confidence: 'high' };
    }
    return { invoiceType: 'company', invoiceTitle: `企业-${title}`, confidence: 'high' };
  }
  if (title.includes('个人')) {
    return { invoiceType: 'personal', invoiceTitle: `个人-${title}`, confidence: 'high' };
  }
  if (title) {
    return { invoiceType: 'has_invoice_unknown', invoiceTitle: `未知抬头-${title}`, confidence: 'low' };
  }

  const type = matchField(['抬头类型', '发票类型', '发票性质'], 30);
  if (type.includes('个人')) {
    return { invoiceType: 'personal', invoiceTitle: `个人-${type}`, confidence: 'high' };
  }
  if (type.includes('企业') || type.includes('单位')) {
    return { invoiceType: 'company', invoiceTitle: `企业-${type}`, confidence: 'medium' };
  }
  if (bodyText.includes('申请开票') || bodyText.includes('暂未开票') || bodyText.includes('未开票')) {
    return { invoiceType: 'no_invoice', invoiceTitle: '未开票', confidence: 'high' };
  }
  if (['发票', '开票', '抬头', '税号', '纳税人', '增值税'].some(keyword => bodyText.includes(keyword))) {
    return { invoiceType: 'has_invoice_unknown', invoiceTitle: '有发票信息-类型需人工确认', confidence: 'low' };
  }
  return { invoiceType: 'no_invoice_info', invoiceTitle: '页面无发票信息', confidence: 'none' };
}

async function collectActionCandidates(page) {
  return page.evaluate((actionKeywords) => {
    const candidates = [];
    const elements = [...document.querySelectorAll('a, button, div, span')];
    const seen = new Set();

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    elements.forEach((el, index) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const href = el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '';
      const className = typeof el.className === 'string' ? el.className : '';
      const role = el.getAttribute('role') || '';
      const clickable = el.tagName === 'A' ||
        el.tagName === 'BUTTON' ||
        role === 'button' ||
        className.includes('button') ||
        className.includes('btn') ||
        Boolean(el.getAttribute('onclick')) ||
        Boolean(el.closest('a'));
      if (!text && !href) return;
      if (!clickable || text.length > 120) return;

      for (const group of actionKeywords) {
        let matchedWord = group.words.find(word => text.includes(word) || href.toLowerCase().includes(word.toLowerCase()));
        if (!matchedWord && group.type === 'download_invoice' && text === '下载' && /invoice|bill|pdf|ofd/i.test(href)) {
          matchedWord = '下载';
        }
        if (!matchedWord) continue;

        const key = `${group.type}|${text}|${href}`;
        if (seen.has(key)) continue;
        seen.add(key);

        candidates.push({
          type: group.type,
          matchedWord,
          text: text.slice(0, 80),
          tag: el.tagName.toLowerCase(),
          href,
          visible: isVisible(el),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true' || className.includes('disabled')),
          className: className.slice(0, 120),
          elementIndex: index,
        });
      }
    });

    return candidates.slice(0, 30);
  }, ACTION_KEYWORDS);
}

async function clickFirstAction(context, page, type) {
  const group = ACTION_KEYWORDS.find(item => item.type === type);
  if (!group) throw new Error(`未知动作类型: ${type}`);

  const clickableSelector = [
    'a',
    'button',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const word of group.words) {
    const locator = page.locator(clickableSelector).filter({ hasText: word });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;

      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await target.click({ timeout: 8000 });
      const popup = await popupPromise;
      const actionPage = popup || page;
      await actionPage.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
      await actionPage.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
      await waitForRelevantPageContent(actionPage);
      await sleep(600);
      return { page: actionPage, openedPopup: Boolean(popup), clickedText: word };
    }
  }

  for (const word of group.words) {
    const locator = page.getByText(word, { exact: true });
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;

      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await target.click({ timeout: 8000 });
      const popup = await popupPromise;
      const actionPage = popup || page;
      await actionPage.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
      await actionPage.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
      await waitForRelevantPageContent(actionPage);
      await sleep(600);
      return { page: actionPage, openedPopup: Boolean(popup), clickedText: word, source: 'text_fallback' };
    }
  }

  throw new Error(`没有找到可点击的 ${type} 入口`);
}

async function closePageQuietly(page) {
  if (!page || page.isClosed()) return;
  await page.close({ runBeforeUnload: false }).catch(() => null);
}

async function closeAuxiliaryPages(context, keepPage) {
  const pages = context.pages();
  for (const openPage of pages) {
    if (openPage === keepPage) continue;
    await closePageQuietly(openPage);
  }
}

async function downloadFirstInvoice(context, page, mapping, preferredType = 'download_invoice', inspection = null) {
  ensureDirectory(DOWNLOAD_DIR);
  const existingDownload = getDownloadedLedgerRecord(mapping.bizOrderId);
  if (existingDownload && !cliArgs.forceDownload) {
    return {
      status: 'file_exists',
      reason: '下载台账中已有该订单发票文件，跳过重复下载',
      filename: existingDownload.filename || path.basename(existingDownload.path || ''),
      existingPath: existingDownload.path || '',
      path: existingDownload.path || '',
    };
  }

  const group = ACTION_KEYWORDS.find(item => item.type === preferredType);
  if (!group) throw new Error(`未知下载动作类型: ${preferredType}`);

  const clickableSelector = [
    'a',
    'button',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const word of group.words) {
    const locator = page.locator(clickableSelector).filter({ hasText: word });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;

      const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await target.click({ timeout: 8000 });

      let download = await downloadPromise;
      const popup = await popupPromise;
      try {
        if (!download && popup) {
          await popup.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
          await popup.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
          const popupDownloadCandidates = await collectActionCandidates(popup);
          if (popupDownloadCandidates.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled)) {
            return await downloadFirstInvoice(context, popup, mapping, 'download_invoice', inspection);
          }
        }

        if (!download) {
          return {
            status: 'blocked',
            reason: '点击下载入口后没有捕获到浏览器下载事件',
            clickedText: word,
            openedPopup: Boolean(popup),
          };
        }

        const suggested = download.suggestedFilename();
        const targetFile = buildInvoiceFilename(mapping, inspection || mapping, suggested);
        const targetPath = ensureUniqueFilePath(path.join(DOWNLOAD_DIR, targetFile));
        await download.saveAs(targetPath);
        const result = {
          status: 'downloaded',
          clickedText: word,
          filename: path.basename(targetPath),
          path: targetPath,
          downloadedAt: new Date().toISOString(),
        };
        recordDownloadedInvoice(mapping, result, inspection);
        return result;
      } finally {
        await closePageQuietly(popup);
      }
    }
  }

  return { status: 'blocked', reason: '没有找到可点击下载入口' };
}

function buildChatInvoiceDownloadResult(mapping, savedPath, source = {}) {
  const result = {
    status: 'downloaded',
    clickedText: source.text || '',
    filename: path.basename(savedPath),
    path: savedPath,
    downloadedAt: new Date().toISOString(),
    sourceUrl: source.href || '',
    sourceText: source.text || '',
  };
  recordDownloadedInvoice(mapping, result, {
    invoiceInfo: {
      invoiceType: 'chat_reply_invoice',
      invoiceTitle: '商家聊天回复发票',
    },
    orderMeta: {
      shopName: mapping.shopName || '',
      amount: mapping.amount || '',
    },
  });
  return result;
}

async function saveChatDownload(download, mapping, source = {}) {
  ensureDirectory(DOWNLOAD_DIR);
  const suggested = download.suggestedFilename();
  const targetFile = buildChatInvoiceFilename(mapping, suggested);
  const targetPath = ensureUniqueFilePath(path.join(DOWNLOAD_DIR, targetFile));
  await download.saveAs(targetPath);
  return buildChatInvoiceDownloadResult(mapping, targetPath, source);
}

async function downloadChatInvoiceUrlWithBrowserContext(page, url, mapping, source = {}) {
  const normalizedUrl = normalizeUrl(url, page.url());
  if (!normalizedUrl || !/^https?:\/\//i.test(normalizedUrl)) {
    return { status: 'blocked', reason: '聊天发票链接不是可请求的 HTTP/HTTPS 地址', invoiceLink: normalizedUrl || url };
  }

  try {
    const response = await page.request.get(normalizedUrl, {
      timeout: 20000,
      maxRedirects: 5,
    });
    if (!response.ok()) {
      return {
        status: 'manual_required',
        reason: `发现疑似发票链接，但直接请求失败: HTTP ${response.status()}`,
        invoiceLink: normalizedUrl,
      };
    }

    const buffer = await response.body();
    if (!buffer || buffer.length < 128) {
      return {
        status: 'manual_required',
        reason: '发现疑似发票链接，但直接请求返回内容过小',
        invoiceLink: normalizedUrl,
      };
    }

    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    const disposition = headers['content-disposition'] || '';
    const dispositionName = decodeURIComponent(
      disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      || disposition.match(/filename="?([^";]+)"?/i)?.[1]
      || ''
    );
    const urlPathName = new URL(normalizedUrl).pathname.split('/').pop() || '';
    const suggested = dispositionName || urlPathName || source.text || 'chat-invoice.pdf';
    const ext = path.extname(suggested)
      || (contentType.includes('ofd') ? '.ofd'
        : contentType.includes('zip') ? '.zip'
          : contentType.includes('image/') ? `.${contentType.split('/')[1].split(';')[0] || 'jpg'}`
            : '.pdf');
    const fileName = path.extname(suggested) ? suggested : `${sanitizeFilenamePart(suggested)}${ext}`;
    ensureDirectory(DOWNLOAD_DIR);
    const targetPath = ensureUniqueFilePath(path.join(DOWNLOAD_DIR, buildChatInvoiceFilename(mapping, fileName)));
    fs.writeFileSync(targetPath, buffer);
    return buildChatInvoiceDownloadResult(mapping, targetPath, {
      href: normalizedUrl,
      text: source.text || source.sourceText || 'direct-request',
    });
  } catch (error) {
    return {
      status: 'manual_required',
      reason: `发现疑似发票链接，但直接请求异常: ${error.message}`,
      invoiceLink: normalizedUrl,
    };
  }
}

function isLikelyInvoiceHref(href = '', text = '') {
  const normalized = String(href || '').toLowerCase();
  const label = `${href} ${text}`;
  if (CHAT_INVOICE_FILE_EXTENSIONS.some(ext => normalized.includes(ext))) return true;
  return CHAT_INVOICE_LINK_PATTERN.test(label);
}

function isLikelyChatInvoiceFileText(text = '') {
  const label = String(text || '').replace(/\s+/g, '');
  return Boolean(
    /PDF|OFD|发票|电子票|文件|附件|下载文件|下载附件/i.test(label)
    || CHAT_INVOICE_FILE_EXTENSIONS.some(ext => label.toLowerCase().includes(ext.slice(1)))
  );
}

async function collectChatReplySnapshot(page, invoiceConfig = {}) {
  const frames = [];
  for (const scope of getActiveChatScopes(page).slice(0, 10)) {
    const frame = await scope.evaluate(() => {
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }

      const bodyText = document.body?.innerText || '';
      const links = [...document.querySelectorAll('a[href], button, [role="button"], div, span')]
        .filter(isVisible)
        .map((el, index) => {
          const href = el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '';
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          const title = el.getAttribute('title') || '';
          const ariaLabel = el.getAttribute('aria-label') || '';
          const downloadName = el.getAttribute('download') || '';
          const className = typeof el.className === 'string' ? el.className : '';
          return {
            index,
            tag: el.tagName.toLowerCase(),
            href,
            text: text.slice(0, 160),
            title: title.slice(0, 160),
            ariaLabel: ariaLabel.slice(0, 160),
            downloadName: downloadName.slice(0, 160),
            className: className.slice(0, 160),
          };
        })
        .filter(item => item.href
          || /发票|电子票|附件|文件|下载|查看|pdf|ofd|zip/i.test(`${item.text} ${item.title} ${item.ariaLabel} ${item.downloadName} ${item.className}`))
        .slice(0, 120);

      return {
        url: location.href,
        title: document.title,
        bodyText,
        links,
      };
    }).catch(error => ({
      url: scope.url(),
      title: '',
      bodyText: '',
      links: [],
      error: error.message,
    }));

    frames.push({
      frameUrl: scope.url(),
      ...frame,
      bodyText: redactSensitiveText(frame.bodyText || '', invoiceConfig),
    });
  }

  const combinedText = frames.map(frame => frame.bodyText || '').join('\n');
  return {
    capturedAt: new Date().toISOString(),
    finalUrl: page.url(),
    title: await page.title().catch(() => ''),
    bodyText: combinedText,
    frames,
  };
}

function classifyChatReply(snapshot) {
  const rawText = String(snapshot?.bodyText || '');
  const compact = rawText.replace(/\s+/g, '');
  const links = (snapshot?.frames || []).flatMap(frame => (frame.links || []).map(link => ({
    ...link,
    frameUrl: frame.frameUrl || frame.url || '',
  })));
  const invoiceLinks = links.filter(link => isLikelyInvoiceHref(link.href, `${link.text} ${link.title} ${link.ariaLabel} ${link.downloadName}`));
  const hasFileCard = isLikelyChatInvoiceFileText(rawText) && /下载文件|下载附件|PDF|OFD|\[文件\]/i.test(rawText);

  if (CHAT_PAYMENT_PATTERN.test(compact)) {
    const priceDiff = compact.match(/(?:补差|差价|差额|付款|支付|补款)[^0-9]{0,12}([0-9]+(?:\.[0-9]{1,2})?)/);
    return {
      replyCategory: 'price_diff_required',
      status: 'manual_required',
      state: ORDER_STATES.NEED_MANUAL_PAYMENT_CONFIRM,
      reason: priceDiff ? `商家聊天回复要求补差/付款，金额疑似 ${priceDiff[1]}` : '商家聊天回复要求补差/付款',
      invoiceLinks,
      priceDiffAmount: priceDiff?.[1] || '',
    };
  }

  if (invoiceLinks.length > 0 || hasFileCard) {
    return {
      replyCategory: 'invoice_link_found',
      status: 'can_download',
      state: ORDER_STATES.CAN_DOWNLOAD,
      reason: hasFileCard ? '商家聊天回复中发现疑似发票文件卡片' : '商家聊天回复中发现疑似发票附件或下载链接',
      invoiceLinks,
      hasFileCard,
    };
  }

  if (/已开|开好了|已发送|发票已发|已上传/.test(compact) && /发票|电子票|票据/.test(compact)) {
    return {
      replyCategory: 'invoice_claimed_no_link',
      status: 'manual_required',
      state: ORDER_STATES.FAILED_RETRYABLE,
      reason: '商家称已开票/已发送，但未识别到可下载附件或链接',
      invoiceLinks,
    };
  }

  if (CHAT_INFO_REQUEST_PATTERN.test(rawText)) {
    return {
      replyCategory: 'seller_requests_info',
      status: 'manual_required',
      state: ORDER_STATES.FAILED_RETRYABLE,
      reason: '商家聊天回复要求补充开票信息',
      invoiceLinks,
    };
  }

  if (CHAT_REJECTION_PATTERN.test(compact)) {
    return {
      replyCategory: 'seller_rejected_in_chat',
      status: 'manual_required',
      state: ORDER_STATES.FAILED_FINAL,
      reason: '商家聊天回复表示无法开票或无法补开',
      invoiceLinks,
    };
  }

  if (!compact || compact.length < 20) {
    return {
      replyCategory: 'chat_not_loaded',
      status: 'manual_required',
      state: ORDER_STATES.FAILED_RETRYABLE,
      reason: '聊天页面未加载出足够内容',
      invoiceLinks,
    };
  }

  return {
    replyCategory: 'waiting_or_no_invoice_reply',
    status: 'waiting',
    state: ORDER_STATES.CONTACTED_SELLER,
    reason: '暂未识别到商家发来的发票附件/链接或明确处理要求',
    invoiceLinks,
  };
}

async function clickRadioOrOption(page, texts) {
  const clickableSelector = [
    'a',
    'label',
    'button',
    '[role="radio"]',
    '[role="button"]',
    'div[class*="radio"]',
    'span[class*="radio"]',
    'div[class*="button"]',
    'span[class*="button"]',
  ].join(',');

  for (const text of texts) {
    const locator = page.locator(clickableSelector).filter({ hasText: text });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click({ timeout: 5000 }).catch(() => null);
      await sleep(500);
      return true;
    }
  }
  return false;
}

async function confirmModifyIfNeeded(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  if (!bodyText.includes('修改发票申请') && !bodyText.includes('您只有一次修改电子发票的机会')) {
    return false;
  }

  const locator = page.locator('button, a, [role="button"], div[class*="button"], span[class*="button"], div[class*="btn"], span[class*="btn"]').filter({ hasText: '修改' });
  const count = Math.min(await locator.count().catch(() => 0), 6);
  for (let i = 0; i < count; i++) {
    const target = locator.nth(i);
    const text = (await target.textContent().catch(() => '') || '').trim();
    if (text !== '修改') continue;
    if (!(await target.isVisible().catch(() => false))) continue;
    await target.click({ timeout: 8000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    await sleep(1200);
    return true;
  }

  return false;
}

async function fillByNearbyLabel(page, labelTexts, value, fieldName) {
  if (!value || labelTexts.length === 0) return { fieldName, filled: false, reason: 'empty_value' };

  return page.evaluate(({ labelTexts, value, fieldName }) => {
    const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function setInputValue(el, nextValue) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, nextValue);
      else el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    const controls = [...document.querySelectorAll(inputSelector)]
      .filter(el => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .map(el => ({ el, rect: el.getBoundingClientRect() }));

    const labelNodes = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: (el.textContent || '').replace(/\s+/g, ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 80);

    for (const labelText of labelTexts) {
      const normalized = labelText.replace(/\s+/g, '');
      const labels = labelNodes.filter(item => item.text.includes(normalized));
      for (const label of labels) {
        const candidates = controls
          .map(control => {
            const sameRow = Math.abs(control.rect.top - label.rect.top) < 28;
            const belowLabel = control.rect.top >= label.rect.top - 4 && control.rect.top <= label.rect.bottom + 42;
            const rightOfLabel = control.rect.left >= label.rect.left;
            const distance = Math.abs(control.rect.top - label.rect.top) + Math.max(0, control.rect.left - label.rect.right);
            return { ...control, sameRow, belowLabel, rightOfLabel, distance };
          })
          .filter(control => (control.sameRow || control.belowLabel) && control.rightOfLabel)
          .sort((a, b) => a.distance - b.distance);

        const target = candidates[0]?.el;
        if (!target) continue;
        if (target.value !== value) setInputValue(target, value);
        return {
          fieldName,
          filled: true,
          selector: 'nearby-label',
          label: labelText,
          alreadyHadValue: target.value === value,
        };
      }
    }

    return { fieldName, filled: false, reason: 'nearby_label_not_found' };
  }, { labelTexts, value, fieldName }).catch(() => ({ fieldName, filled: false, reason: 'nearby_label_error' }));
}

async function fillInputByLabelWithPlaywright(page, labelTexts, value, fieldName) {
  if (!value || labelTexts.length === 0) return { fieldName, filled: false, reason: 'empty_value' };

  const targetMeta = await page.evaluate(({ labelTexts }) => {
    const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalize(text) {
      return (text || '').replace(/\s+/g, '');
    }

    const allControls = [...document.querySelectorAll(inputSelector)];
    const controls = allControls
      .map((el, index) => ({ el, index, rect: el.getBoundingClientRect() }))
      .filter(item => isVisible(item.el) && !item.el.disabled && item.el.getAttribute('aria-disabled') !== 'true');

    const labelNodes = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        text: normalize(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 60);

    for (const labelText of labelTexts) {
      const normalized = normalize(labelText);
      const labels = labelNodes.filter(item => item.text === normalized || item.text.startsWith(normalized) || item.text.includes(normalized));
      for (const label of labels) {
        const candidates = controls
          .map(control => {
            const rowAligned = Math.abs((control.rect.top + control.rect.bottom) / 2 - (label.rect.top + label.rect.bottom) / 2) <= 28;
            const belowLabel = control.rect.top >= label.rect.top - 6 && control.rect.top <= label.rect.bottom + 48;
            const rightOfLabel = control.rect.left >= label.rect.right - 16;
            const distance = Math.abs(control.rect.top - label.rect.top) + Math.max(0, control.rect.left - label.rect.right);
            return { ...control, rowAligned, belowLabel, rightOfLabel, distance };
          })
          .filter(control => (control.rowAligned || control.belowLabel) && control.rightOfLabel)
          .sort((a, b) => a.distance - b.distance);

        const target = candidates[0];
        if (target) {
          return {
            found: true,
            index: target.index,
            label: labelText,
            beforeValue: target.el.value || '',
          };
        }
      }
    }

    return { found: false };
  }, { labelTexts }).catch(() => ({ found: false, error: 'label_lookup_error' }));

  if (!targetMeta.found) {
    return { fieldName, filled: false, reason: targetMeta.error || 'label_input_not_found' };
  }

  const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';
  const target = page.locator(inputSelector).nth(targetMeta.index);
  if (!(await target.isVisible().catch(() => false))) {
    return { fieldName, filled: false, reason: 'label_input_not_visible', label: targetMeta.label };
  }
  await target.click({ timeout: 5000 }).catch(() => null);
  await target.fill('', { timeout: 5000 }).catch(() => null);
  await target.fill(value, { timeout: 5000 });
  await sleep(600);
  const afterValue = await target.inputValue({ timeout: 1000 }).catch(() => '');
  return {
    fieldName,
    filled: afterValue === value,
    selector: 'playwright-label',
    label: targetMeta.label,
    beforeValue: targetMeta.beforeValue || '',
    afterValue,
    reason: afterValue === value ? '' : 'value_reverted_after_fill',
  };
}

async function clickInvoiceTitleSuggestion(page, invoiceConfig) {
  if (!invoiceConfig.companyName) return { clicked: false, reason: 'empty_company_name' };
  const optionSelectors = [
    '.search-input-result',
    '.search-input-result .item',
    '.next-menu',
    '.next-menu-item',
    '.next-menu *',
    '.next-menu li',
    '[role="option"]',
    '[role="menuitem"]',
    'li',
  ].join(', ');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(700);
    const locator = page.locator(optionSelectors).filter({ hasText: invoiceConfig.companyName });
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click({ timeout: 5000 }).catch(() => null);
      await sleep(1000);
      return { clicked: true, text: invoiceConfig.companyName, attempt };
    }
  }
  return { clicked: false, reason: 'suggestion_not_found' };
}

async function fillByExactRowLabel(page, labelTexts, value, fieldName) {
  if (!value || labelTexts.length === 0) return { fieldName, filled: false, reason: 'empty_value' };

  return page.evaluate(({ labelTexts, value, fieldName }) => {
    const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalize(text) {
      return (text || '').replace(/\s+/g, '');
    }

    function setInputValue(el, nextValue) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, nextValue);
      else el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    const controls = [...document.querySelectorAll(inputSelector)]
      .filter(el => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .map(el => ({ el, rect: el.getBoundingClientRect() }));

    const labelNodes = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: normalize(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 40);

    for (const labelText of labelTexts) {
      const normalized = normalize(labelText);
      const labels = labelNodes.filter(item => item.text === normalized || item.text.startsWith(normalized) || item.text.includes(normalized));
      for (const label of labels) {
        const candidates = controls
          .map(control => {
            const rowAligned = Math.abs((control.rect.top + control.rect.bottom) / 2 - (label.rect.top + label.rect.bottom) / 2) <= 24;
            const rightOfLabel = control.rect.left >= label.rect.right - 12;
            const distance = Math.abs(control.rect.top - label.rect.top) + Math.max(0, control.rect.left - label.rect.right);
            return { ...control, rowAligned, rightOfLabel, distance };
          })
          .filter(control => control.rowAligned && control.rightOfLabel)
          .sort((a, b) => a.distance - b.distance);

        const target = candidates[0]?.el;
        if (!target) continue;
        const beforeValue = target.value || '';
        if (beforeValue !== value) setInputValue(target, value);
        return {
          fieldName,
          filled: true,
          selector: 'exact-row-label',
          label: labelText,
          beforeValue,
          afterValue: target.value || '',
        };
      }
    }

    return { fieldName, filled: false, reason: 'exact_row_label_not_found' };
  }, { labelTexts, value, fieldName }).catch(() => ({ fieldName, filled: false, reason: 'exact_row_label_error' }));
}

async function readValueByExactRowLabel(page, labelTexts, fieldName) {
  return page.evaluate(({ labelTexts, fieldName }) => {
    const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalize(text) {
      return (text || '').replace(/\s+/g, '');
    }

    const controls = [...document.querySelectorAll(inputSelector)]
      .filter(el => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .map(el => ({ el, rect: el.getBoundingClientRect() }));

    const labelNodes = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        text: normalize(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 40);

    for (const labelText of labelTexts) {
      const normalized = normalize(labelText);
      const labels = labelNodes.filter(item => item.text === normalized || item.text.startsWith(normalized) || item.text.includes(normalized));
      for (const label of labels) {
        const candidates = controls
          .map(control => {
            const rowAligned = Math.abs((control.rect.top + control.rect.bottom) / 2 - (label.rect.top + label.rect.bottom) / 2) <= 24;
            const rightOfLabel = control.rect.left >= label.rect.right - 12;
            const distance = Math.abs(control.rect.top - label.rect.top) + Math.max(0, control.rect.left - label.rect.right);
            return { ...control, rowAligned, rightOfLabel, distance };
          })
          .filter(control => control.rowAligned && control.rightOfLabel)
          .sort((a, b) => a.distance - b.distance);

        const target = candidates[0]?.el;
        if (!target) continue;
        return {
          fieldName,
          found: true,
          label: labelText,
          value: target.value || '',
        };
      }
    }

    return { fieldName, found: false, value: '' };
  }, { labelTexts, fieldName }).catch(() => ({ fieldName, found: false, value: '' }));
}

async function fillFirstVisible(page, selectors, value, fieldName, nearbyLabels = []) {
  if (!value) return { fieldName, filled: false, reason: 'empty_value' };

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;

      const currentValue = await target.inputValue({ timeout: 1000 }).catch(() => '');
      if (currentValue === value) {
        return { fieldName, filled: true, selector, alreadyHadValue: true };
      }
      await target.fill('', { timeout: 5000 }).catch(() => null);
      await target.fill(value, { timeout: 5000 });
      await sleep(300);
      return { fieldName, filled: true, selector };
    }
  }

  const nearbyResult = await fillByNearbyLabel(page, nearbyLabels, value, fieldName);
  if (nearbyResult.filled) {
    await sleep(300);
    return nearbyResult;
  }

  return { fieldName, filled: false, reason: 'not_found' };
}

async function validateFilledInvoiceForm(page, invoiceConfig) {
  const companyValue = await readValueByExactRowLabel(page, ['发票抬头'], 'companyName');
  const taxValue = await readValueByExactRowLabel(page, ['税号', '纳税人识别号'], 'taxNo');
  const emailValue = await readValueByExactRowLabel(page, ['邮箱', '电子邮箱'], 'email');
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const companyActual = companyValue.value || (invoiceConfig.companyName && bodyText.includes(invoiceConfig.companyName) ? invoiceConfig.companyName : '');
  const taxActual = taxValue.value || (invoiceConfig.taxNo && bodyText.includes(invoiceConfig.taxNo) ? invoiceConfig.taxNo : '');
  const emailActual = emailValue.value || (invoiceConfig.email && bodyText.includes(invoiceConfig.email) ? invoiceConfig.email : '');

  const mismatches = [];
  if (companyActual !== invoiceConfig.companyName) {
    mismatches.push({
      fieldName: 'companyName',
      expected: invoiceConfig.companyName,
      actual: companyActual || '',
    });
  }
  if (taxActual !== invoiceConfig.taxNo) {
    mismatches.push({
      fieldName: 'taxNo',
      expected: invoiceConfig.taxNo,
      actual: taxActual || '',
    });
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    companyValue: { ...companyValue, value: companyActual, found: companyValue.found || Boolean(companyActual) },
    taxValue: { ...taxValue, value: taxActual, found: taxValue.found || Boolean(taxActual) },
    emailValue: { ...emailValue, value: emailActual, found: emailValue.found || Boolean(emailActual) },
    emailOk: !invoiceConfig.email || emailActual === invoiceConfig.email,
  };
}

async function fillReissueForm(page, invoiceConfig) {
  await clickRadioOrOption(page, ['企业', '单位', '公司']);

  const filledFields = [];
  let companyField = await fillInputByLabelWithPlaywright(page, ['发票抬头', '抬头名称', '公司名称', '单位名称'], invoiceConfig.companyName, 'companyName');
  let titleSuggestion = null;
  if (companyField.filled) {
    titleSuggestion = await clickInvoiceTitleSuggestion(page, invoiceConfig);
  }
  if (!companyField.filled) {
    companyField = await fillByExactRowLabel(page, ['发票抬头'], invoiceConfig.companyName, 'companyName');
  }
  if (!companyField.filled) {
    companyField = await fillFirstVisible(page, [
    'input[placeholder*="发票抬头"]',
    'input[placeholder*="抬头名称"]',
    'input[placeholder*="公司名称"]',
    'input[placeholder*="单位名称"]',
    'input[name*="title" i]',
    'input[name*="company" i]',
    'input[id*="title" i]',
    'input[id*="company" i]',
    ], invoiceConfig.companyName, 'companyName', ['发票抬头', '抬头名称', '公司名称', '单位名称']);
  }
  filledFields.push({ ...companyField, titleSuggestion });

  let taxField = await fillInputByLabelWithPlaywright(page, ['税号', '纳税人识别号', '统一社会信用代码'], invoiceConfig.taxNo, 'taxNo');
  if (!taxField.filled) {
    taxField = await fillByExactRowLabel(page, ['税号', '纳税人识别号', '统一社会信用代码'], invoiceConfig.taxNo, 'taxNo');
  }
  if (!taxField.filled) {
    taxField = await fillFirstVisible(page, [
    'input[placeholder*="税号"]',
    'input[placeholder*="纳税人识别号"]',
    'input[placeholder*="统一社会信用代码"]',
    'input[name*="tax" i]',
    'input[id*="tax" i]',
    'input[name*="payer" i]',
    'input[id*="payer" i]',
    ], invoiceConfig.taxNo, 'taxNo', ['纳税人识别号', '税号', '统一社会信用代码']);
  }
  filledFields.push(taxField);

  await clickRadioOrOption(page, ['展开非必填信息', '更多信息', '展开']);

  filledFields.push(await fillFirstVisible(page, [
    'input[placeholder*="邮箱"]',
    'input[type="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
  ], invoiceConfig.email, 'email', ['邮箱', '电子邮箱']));

  filledFields.push(await fillFirstVisible(page, [
    'input[placeholder*="手机号"]',
    'input[placeholder*="电话"]',
    'input[name*="phone" i]',
    'input[id*="phone" i]',
    'input[name*="mobile" i]',
    'input[id*="mobile" i]',
  ], invoiceConfig.phone, 'phone', ['手机号', '电话号码', '电话']));

  filledFields.push({ fieldName: 'address', filled: false, reason: 'skipped_optional_address' });

  let bankNameField = await fillByExactRowLabel(page, ['开户银行', '开户行'], invoiceConfig.bankName, 'bankName');
  if (!bankNameField.filled) {
    bankNameField = await fillFirstVisible(page, [
    'input[placeholder*="开户行"]',
    'input[placeholder*="银行"]',
    'input[name*="bank" i]',
    'input[id*="bank" i]',
    ], invoiceConfig.bankName, 'bankName', ['开户银行', '开户行', '银行']);
  }
  filledFields.push(bankNameField);

  let bankAccountField = await fillByExactRowLabel(page, ['银行账号', '银行账户'], invoiceConfig.bankAccount, 'bankAccount');
  if (!bankAccountField.filled) {
    bankAccountField = await fillFirstVisible(page, [
    'input[placeholder*="银行账号"]',
    'input[placeholder*="账号"]',
    'input[name*="account" i]',
    'input[id*="account" i]',
    ], invoiceConfig.bankAccount, 'bankAccount', ['银行账户', '银行账号', '账号']);
  }
  filledFields.push(bankAccountField);

  const requiredFilled = filledFields.filter(field => ['companyName', 'taxNo'].includes(field.fieldName));
  const missingRequired = requiredFilled.filter(field => !field.filled).map(field => field.fieldName);
  const validation = await validateFilledInvoiceForm(page, invoiceConfig);
  return { filledFields, missingRequired, validation };
}

function shouldAutoModify(inspection, history) {
  const bodyText = inspection?.detailBodyText || '';
  const parseResult = classifyPageErrorText(bodyText);
  return Boolean(
    inspection?.candidates?.some(candidate => candidate.type === 'modify_invoice' && candidate.visible && !candidate.disabled)
    && (
      inspection?.invoiceInfo?.invoiceType === 'wrong_company_title'
      || parseResult.hasRetryableError
      || history?.parseResult?.hasRetryableError
      || bodyText.includes('商家拒绝')
      || bodyText.includes('修改申请')
      || bodyText.includes('咨询商家')
    )
  );
}

function invoiceNeedsReissue(inspection, invoiceConfig = {}) {
  const invoiceType = inspection?.invoiceInfo?.invoiceType || '';
  const bodyText = inspection?.detailBodyText || '';
  if (invoiceType === 'personal' || invoiceType === 'wrong_company_title') return true;
  if (inspection?.pageClassification?.status === ORDER_STATES.NEED_REISSUE) return true;
  if (invoiceType === 'company' && invoiceConfig.companyName && invoiceConfig.taxNo) {
    return !bodyText.includes(invoiceConfig.companyName) || !bodyText.includes(invoiceConfig.taxNo);
  }
  return false;
}

async function executeModifyInvoice(context, page, mapping, invoiceConfig, baseInspection = null, baseHistory = null) {
  const inspection = baseInspection || await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'modify_invoice', status: 'error', reason: inspection.error, error: inspection.error }) };
  }

  const history = baseHistory || await inspectHistory(context, page);
  const clickResult = await clickFirstAction(context, page, 'modify_invoice').catch(() => null);
  if (!clickResult) {
    return {
      ...inspection,
      history,
      execution: buildExecutionMeta(inspection, {
        action: 'modify_invoice',
        status: 'manual_required',
        reason: '未找到修改申请入口',
      }),
    };
  }

  const actionPage = clickResult.page;
  try {
    await confirmModifyIfNeeded(actionPage);

    const verification = await handleVerificationIfNeeded(actionPage, '修改申请前需要安全验证');
    if (verification.blocked) {
      return {
        ...inspection,
        history,
        execution: buildExecutionMeta(inspection, {
          action: 'modify_invoice',
          status: 'manual_required',
          reason: verification.reason,
        }),
      };
    }

    const deadlineExceeded = await detectInvoiceDeadlineExceeded(actionPage);
    if (deadlineExceeded.exceeded) {
      const contactResult = await contactSellerForInvoice(context, actionPage, mapping, invoiceConfig);
      return {
        ...inspection,
        history,
        execution: buildExecutionMeta(inspection, {
          action: 'modify_invoice',
          status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          deadlineExceeded,
          contactResult,
          finalUrl: contactResult.finalUrl || actionPage.url(),
          reason: contactResult.reason || deadlineExceeded.reason,
        }),
      };
    }

    const submitMeta = await retryableFormSubmit(context, actionPage, mapping, invoiceConfig, inspection, 'modify_invoice');
    if (['submitted', 'pending'].includes(submitMeta.status)) {
      recordModifiedOrder(mapping, submitMeta, { action: 'modify_invoice', finalUrl: actionPage.url() });
    }
    return {
      ...inspection,
      history,
      execution: {
        ...submitMeta,
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
      },
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function detectExistingInvoiceApplication(page, invoiceConfig) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const pending = ['申请中', '商家正在处理', '已提交', '处理中', '查看申请历史'].some(word => bodyText.includes(word));
  const success = ['已开票', '申请成功', '提交成功', '开票成功', '换开成功'].some(word => bodyText.includes(word));
  const hasCompany = invoiceConfig.companyName && bodyText.includes(invoiceConfig.companyName);
  const hasTaxNo = invoiceConfig.taxNo && bodyText.includes(invoiceConfig.taxNo);
  const titleLooksLikeTaxNo = bodyShowsTaxNoAsInvoiceTitle(bodyText, invoiceConfig);

  if (pending || success) {
    return {
      exists: true,
      status: titleLooksLikeTaxNo ? 'manual_required' : (success ? 'submitted' : 'pending'),
      hasCompany,
      hasTaxNo,
      titleLooksLikeTaxNo,
      reason: titleLooksLikeTaxNo
        ? '页面显示已申请，但发票抬头像税号，需走修改申请修正'
        : (success ? '页面显示已提交/成功' : '页面显示申请中/处理中'),
    };
  }

  return { exists: false, status: '' };
}

async function detectInvoiceDeadlineExceeded(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const parseResult = classifyPageErrorText(bodyText);
  const hit = parseResult.hits.find(item => item.type === 'expired')?.matched;
  if (!hit) return { exceeded: false, parseResult };

  return {
    exceeded: true,
    keyword: hit,
    reason: `页面提示${hit}`,
    parseResult,
  };
}

async function inspectHistory(context, page) {
  const originalUrl = page.url();
  const hasHistoryEntry = await page.evaluate((words) => {
    const bodyText = document.body?.innerText || '';
    return words.some(word => bodyText.includes(word));
  }, ACTION_KEYWORDS.find(item => item.type === 'view_history')?.words || []).catch(() => false);
  if (!hasHistoryEntry) {
    return { opened: false, historyText: '', parseResult: classifyPageErrorText('') };
  }

  const clickResult = await clickFirstAction(context, page, 'view_history').catch(() => null);
  if (!clickResult) {
    return { opened: false, historyText: '', parseResult: classifyPageErrorText('') };
  }

  const historyPage = clickResult.page;
  try {
    const historyText = await historyPage.evaluate(() => document.body.innerText || '').catch(() => '');
    return {
      opened: true,
      historyText,
      historyUrl: historyPage.url(),
      parseResult: classifyPageErrorText(historyText),
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(historyPage);
    } else if (historyPage === page && page.url() !== originalUrl) {
      await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
      await waitForRelevantPageContent(page).catch(() => null);
      await sleep(800);
    }
  }
}

async function tryClickAction(page, texts) {
  const clickableSelector = [
    'a',
    'button',
    'textarea',
    'input',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const text of texts) {
    const locator = page.locator(clickableSelector).filter({ hasText: text });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let index = 0; index < count; index += 1) {
      const target = locator.nth(index);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;
      await target.click({ timeout: 5000 }).catch(() => null);
      await sleep(500);
      return { clicked: true, text };
    }
  }
  return { clicked: false };
}

function getActiveChatScopes(page) {
  return page.frames().filter(scope => {
    try {
      return !scope.isDetached();
    } catch {
      return true;
    }
  });
}

async function findVisibleLocatorInScope(scope, selector, maxCount = 12) {
  const locator = scope.locator(selector);
  const count = Math.min(await locator.count().catch(() => 0), maxCount);
  for (let index = 0; index < count; index += 1) {
    const target = locator.nth(index);
    if (!(await target.isVisible().catch(() => false))) continue;
    if (await target.isDisabled?.().catch(() => false)) continue;
    return target;
  }
  return null;
}

async function tryClickActionInScope(scope, texts) {
  const clickableSelector = [
    'a',
    'button',
    'input[type="button"]',
    'input[type="submit"]',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const text of texts) {
    const candidates = [
      scope.locator(clickableSelector).filter({ hasText: text }),
      scope.locator(`[aria-label*="${text}"], [title*="${text}"]`),
    ];

    for (const locator of candidates) {
      const count = Math.min(await locator.count().catch(() => 0), 8);
      for (let index = 0; index < count; index += 1) {
        const target = locator.nth(index);
        if (!(await target.isVisible().catch(() => false))) continue;
        if (await target.isDisabled?.().catch(() => false)) continue;
        await target.click({ timeout: 5000 }).catch(() => null);
        await sleep(500);
        return { clicked: true, text };
      }
    }
  }

  return { clicked: false };
}

async function tryClickActionAcrossScopes(page, texts, preferredScope = null) {
  const scopes = getActiveChatScopes(page);
  const orderedScopes = preferredScope
    ? [preferredScope, ...scopes.filter(scope => scope !== preferredScope)]
    : scopes;

  for (const scope of orderedScopes) {
    const result = await tryClickActionInScope(scope, texts);
    if (result.clicked) {
      return {
        ...result,
        scopeUrl: scope.url(),
      };
    }
  }

  return { clicked: false };
}

async function findMessageFieldTarget(page) {
  for (const scope of getActiveChatScopes(page)) {
    const locator = await findVisibleLocatorInScope(scope, MESSAGE_FIELD_SELECTORS);
    if (locator) {
      return {
        scope,
        locator,
        scopeUrl: scope.url(),
      };
    }
  }
  return null;
}

async function fillMessageField(target, message) {
  const { page, locator } = target;
  const metadata = await locator.evaluate(el => ({
    tagName: el.tagName.toLowerCase(),
    contenteditable: el.getAttribute('contenteditable'),
    isContentEditable: Boolean(el.isContentEditable),
    className: typeof el.className === 'string' ? el.className : '',
  })).catch(() => ({
    tagName: '',
    contenteditable: null,
    isContentEditable: false,
    className: '',
  }));

  if (metadata.tagName === 'textarea' || metadata.tagName === 'input') {
    await locator.fill(message, { timeout: 5000 }).catch(() => null);
    return true;
  }

  await locator.click({ timeout: 5000 }).catch(() => null);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => null);
  await page.keyboard.press('Backspace').catch(() => null);
  await page.keyboard.type(message, { delay: 20 }).catch(() => null);

  const typedOk = await locator.evaluate((el, expected) => {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.includes(expected.slice(0, Math.min(expected.length, 12)));
  }, message).catch(() => false);
  if (typedOk) return true;

  const forceSet = await locator.evaluate((el, nextValue) => {
    function dispatch(target) {
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = nextValue;
      dispatch(el);
      return true;
    }

    el.focus();
    el.textContent = nextValue;
    dispatch(el);
    return (el.innerText || el.textContent || '').includes(nextValue.slice(0, Math.min(nextValue.length, 12)));
  }, message).catch(() => false);

  return forceSet;
}

async function dismissKnownChatHints(page) {
  let acted = false;
  const mainScope = page.mainFrame();

  for (const selector of CHAT_HINT_CLOSE_SELECTORS) {
    const closeTarget = await findVisibleLocatorInScope(mainScope, selector, 3);
    if (!closeTarget) continue;
    await closeTarget.click({ timeout: 3000 }).catch(() => null);
    await sleep(400);
    acted = true;
  }

  const switchResult = await tryClickActionInScope(mainScope, WEB_CHAT_TEXTS);
  if (switchResult.clicked) {
    acted = true;
    await sleep(1000);
  }

  return acted;
}

async function collectChatDebugSnapshot(page) {
  const frameSnapshots = [];
  for (const scope of getActiveChatScopes(page).slice(0, 10)) {
    const snapshot = await scope.evaluate(() => {
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }

      const candidates = [...document.querySelectorAll('textarea, input, button, a, div, span, section')]
        .filter(el => isVisible(el))
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          role: el.getAttribute('role') || '',
          contenteditable: el.getAttribute('contenteditable') || '',
          className: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
          id: el.id || '',
        }))
        .filter(item => item.placeholder
          || item.ariaLabel
          || item.title
          || item.role === 'textbox'
          || item.contenteditable === 'true'
          || /消息|发送|输入|聊天|旺旺|网页|客户端|设置/i.test(`${item.text} ${item.className} ${item.id}`))
        .slice(0, 120);

      return {
        title: document.title,
        bodyPreview: (document.body?.innerText || '').slice(0, 4000),
        candidates,
        iframeCount: document.querySelectorAll('iframe').length,
      };
    }).catch(error => ({
      error: error.message,
    }));

    frameSnapshots.push({
      url: scope.url(),
      name: typeof scope.name === 'function' ? scope.name() : '',
      ...snapshot,
    });
  }

  return {
    finalUrl: page.url(),
    title: await page.title().catch(() => ''),
    frameCount: page.frames().length,
    frames: frameSnapshots,
  };
}

function isTradeDetailUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return normalized.includes('trade.taobao.com/trade/detail/trade_order_detail.htm')
    || normalized.includes('trade.tmall.com/detail/orderdetail.htm');
}

function isSellerContactText(text) {
  const normalized = String(text || '').replace(/\s+/g, '');
  return [
    '联系卖家',
    '联系商家',
    '咨询商家',
    '旺旺',
    '旺旺联系',
    '商家客服',
  ].some(word => normalized.includes(word));
}

function buildOrderDetailUrlCandidates(mapping) {
  const urls = [];
  const seen = new Set();
  const orderId = String(mapping?.bizOrderId || '').trim();

  function add(url) {
    const normalized = normalizeUrl(url, 'https://trade.taobao.com/');
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);
  }

  [mapping?.detailUrl, mapping?.url, mapping?.invoiceUrl].forEach(url => {
    if (isTradeDetailUrl(url)) {
      add(url);
    }
  });

  if (orderId) {
    const preferred = mapping?.platform === 'tmall'
      ? [
          `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${orderId}`,
          `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${orderId}`,
        ]
      : [
          `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${orderId}`,
          `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${orderId}`,
        ];
    preferred.forEach(add);
  }

  return urls;
}

function rankSellerContactCandidate(candidate, baseUrl) {
  const text = String(candidate?.text || '');
  const href = normalizeUrl(candidate?.href || '', baseUrl);
  let score = 0;
  if (candidate?.visible) score += 100;
  if (!candidate?.disabled) score += 40;
  if (isSellerContactText(text)) score += 80;
  if (/旺旺|aliim|ww/i.test(href)) score += 50;
  if (/seller|shop|store|merchant/i.test(href)) score += 20;
  if (looksLikePlatformCustomerService(href)) score -= 200;
  if (text.replace(/\s+/g, '') === '联系客服') score -= 40;
  return score;
}

function summarizeContactAttempts(attempts, fallbackReason = '未进入商家会话') {
  const details = attempts
    .map(item => {
      const parts = [item.source];
      if (item.candidateText) parts.push(item.candidateText);
      if (item.reason) parts.push(item.reason);
      return parts.filter(Boolean).join(':');
    })
    .filter(Boolean);
  if (details.length === 0) return fallbackReason;
  return `已尝试联系入口但未成功：${details.join('；')}`;
}

async function restorePageUrl(page, url) {
  if (!url || page.isClosed() || page.url() === url) return;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
  await waitForRelevantPageContent(page).catch(() => null);
  await sleep(600);
}

async function waitForContactPageReady(page, timeout = 12000) {
  const startedAt = Date.now();
  while (!page.isClosed() && Date.now() - startedAt < timeout) {
    if (await findMessageFieldTarget(page)) {
      await sleep(500);
      return;
    }

    const markers = ['发送', '客户端聊天', '默认聊天方式', '验证', ...VERIFICATION_TEXT_MARKERS];
    const checks = await Promise.all(getActiveChatScopes(page).map(scope => {
      return scope.evaluate(markerList => {
        const bodyText = document.body?.innerText || '';
        return markerList.some(marker => bodyText.includes(marker));
      }, markers).catch(() => false);
    }));

    if (checks.some(Boolean)) {
      await sleep(500);
      return;
    }

    await sleep(500);
  }

  await sleep(500);
}

async function clickActionCandidate(context, page, candidate, options = {}) {
  const { contactMode = false } = options;
  const selector = 'a, button, div, span';
  const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  let clicked = false;

  if (Number.isInteger(candidate?.elementIndex) && candidate.elementIndex >= 0) {
    const indexedTarget = page.locator(selector).nth(candidate.elementIndex);
    if (await indexedTarget.isVisible().catch(() => false)) {
      await indexedTarget.click({ timeout: 8000 }).catch(() => null);
      clicked = true;
    }
  }

  if (!clicked && candidate?.text) {
    const fallbackTarget = page
      .locator('a, button, [role="button"], div[class*="button"], div[class*="btn"], span[class*="button"], span[class*="btn"]')
      .filter({ hasText: candidate.text })
      .first();
    if (await fallbackTarget.isVisible().catch(() => false)) {
      await fallbackTarget.click({ timeout: 8000 }).catch(() => null);
      clicked = true;
    }
  }

  const popup = await popupPromise;
  if (!clicked) {
    if (popup) await closePageQuietly(popup);
    return null;
  }

  const actionPage = popup || page;
  await actionPage.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
  if (contactMode) {
    await waitForContactPageReady(actionPage).catch(() => null);
  } else {
    await actionPage.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    await waitForRelevantPageContent(actionPage).catch(() => null);
    await sleep(600);
  }
  return {
    page: actionPage,
    openedPopup: Boolean(popup),
    clickedText: candidate?.text || candidate?.matchedWord || '',
  };
}

async function sendSellerMessageOnPage(page, mapping, invoiceConfig) {
  let bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  let manualCheck = classifyPageErrorText(bodyText);
  if (manualCheck.hasVerificationError || isLoginOrVerifyUrl(page.url())) {
    const waitResult = await pauseForManualVerification(page, '联系商家前需要安全验证');
    if (!waitResult.resolved) {
      return { status: 'manual_required', reason: waitResult.reason, finalUrl: page.url() };
    }
    bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    manualCheck = classifyPageErrorText(bodyText);
  }

  if (looksLikePlatformCustomerService(page.url())) {
    return {
      status: 'manual_required',
      reason: '当前入口跳转到淘宝平台客服，未进入商家会话',
      finalUrl: page.url(),
    };
  }

  const message = buildSellerMessage(mapping, invoiceConfig);
  let messageFieldTarget = await findMessageFieldTarget(page);
  if (!messageFieldTarget) {
    const adjusted = await dismissKnownChatHints(page);
    if (adjusted) {
      await waitForContactPageReady(page, 10000).catch(() => null);
      messageFieldTarget = await findMessageFieldTarget(page);
    }
  }

  if (!messageFieldTarget) {
    const debugPayload = await collectChatDebugSnapshot(page).catch(() => null);
    if (debugPayload) {
      saveDebugJson(DEBUG_CHAT_FILE, {
        capturedAt: new Date().toISOString(),
        orderId: mapping.bizOrderId,
        shopName: mapping.shopName || '',
        ...debugPayload,
      });
      console.log(`    [联系商家] 已导出聊天页调试信息: ${DEBUG_CHAT_FILE}`);
    }
    const blockedByChatMode = Boolean(
      debugPayload?.frames?.some(frame => /客户端聊天|默认聊天方式/.test(frame.bodyPreview || ''))
    );
    return {
      status: 'manual_required',
      reason: blockedByChatMode ? '未找到商家消息输入框，页面停留在聊天方式提示页' : '未找到商家消息输入框',
      finalUrl: page.url(),
    };
  }

  const filled = await fillMessageField({ page, locator: messageFieldTarget.locator }, message);
  if (!filled) {
    return {
      status: 'manual_required',
      reason: '已找到消息输入区，但自动填写失败',
      message,
      finalUrl: page.url(),
    };
  }

  const sendResult = await tryClickActionAcrossScopes(page, SEND_BUTTON_TEXTS, messageFieldTarget.scope);
  if (!sendResult.clicked) {
    return {
      status: 'manual_required',
      reason: '未找到发送按钮',
      message,
      finalUrl: page.url(),
    };
  }

  const executedAt = new Date().toISOString();
  const result = {
    status: 'seller_contacted',
    reason: '已联系商家申请开票',
    message,
    executedAt,
    finalUrl: page.url(),
  };
  recordContactedOrder(mapping, message, {
    contactedAt: executedAt,
    finalUrl: result.finalUrl,
    source: 'sendSellerMessageOnPage',
  });
  return result;
}

async function clickChatInvoiceLink(context, page, linkCandidate, mapping) {
  const scopes = getActiveChatScopes(page);
  const sourceText = linkCandidate.text || linkCandidate.title || linkCandidate.ariaLabel || linkCandidate.downloadName || '';
  const sourceHref = normalizeUrl(linkCandidate.href || '', linkCandidate.frameUrl || page.url());
  for (const scope of scopes) {
    if (sourceHref) {
      const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      const clickedByHref = await withTimeout(scope.evaluate(targetHref => {
        function normalize(href) {
          try {
            return new URL(href.startsWith('//') ? `https:${href}` : href, location.href).href;
          } catch {
            return href || '';
          }
        }

        const candidates = [...document.querySelectorAll('a[href]')];
        const target = candidates.find(el => normalize(el.getAttribute('href') || '') === targetHref);
        if (!target) return false;
        target.click();
        return true;
      }, sourceHref).catch(() => false), 5000, false);

      if (clickedByHref) {
        const download = await downloadPromise;
        const popup = await popupPromise;
        try {
          if (download) {
            return await saveChatDownload(download, mapping, {
              href: sourceHref,
              text: sourceText,
            });
          }
          if (!popup && sourceHref) {
            return await downloadChatInvoiceUrlWithBrowserContext(page, sourceHref, mapping, { text: sourceText });
          }
          if (popup) {
            await popup.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
            const popupDownload = await popup.waitForEvent('download', { timeout: 8000 }).catch(() => null);
            if (popupDownload) {
              return await saveChatDownload(popupDownload, mapping, {
                href: popup.url() || sourceHref,
                text: sourceText,
              });
            }
          }
        } finally {
          await closePageQuietly(popup);
        }
      }
    }

    const locator = scope.locator('a[href], button, [role="button"], div, span').filter({ hasText: sourceText || '下载' });
    const count = Math.min(await locator.count().catch(() => 0), 12);
    for (let index = 0; index < count; index += 1) {
      const target = locator.nth(index);
      if (!(await target.isVisible().catch(() => false))) continue;
      const meta = await target.evaluate(el => ({
        href: el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '',
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        title: el.getAttribute('title') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        downloadName: el.getAttribute('download') || '',
      })).catch(() => null);
      const metaHref = normalizeUrl(meta?.href || '', scope.url());
      const metaLabel = `${meta?.text || ''} ${meta?.title || ''} ${meta?.ariaLabel || ''} ${meta?.downloadName || ''}`;
      if (sourceHref && metaHref && sourceHref !== metaHref) continue;
      if (!sourceHref && sourceText && !metaLabel.includes(sourceText.slice(0, Math.min(sourceText.length, 24)))) continue;
      if (!isLikelyInvoiceHref(metaHref, metaLabel)) continue;

      const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await withTimeout(target.click({ timeout: 8000, noWaitAfter: true }).catch(() => null), 5000, null);
      const download = await downloadPromise;
      const popup = await popupPromise;
      try {
        if (download) {
          return await saveChatDownload(download, mapping, {
            href: metaHref || sourceHref,
            text: meta?.text || sourceText,
          });
        }

        if (popup) {
          await popup.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
          const popupDownload = await popup.waitForEvent('download', { timeout: 8000 }).catch(() => null);
          if (popupDownload) {
            return await saveChatDownload(popupDownload, mapping, {
              href: popup.url() || metaHref || sourceHref,
              text: meta?.text || sourceText,
            });
          }
          const popupUrl = popup.url();
          if (CHAT_INVOICE_FILE_EXTENSIONS.some(ext => popupUrl.toLowerCase().includes(ext))) {
            return {
              status: 'manual_required',
              reason: '聊天链接打开了疑似发票文件页，但未触发浏览器下载事件',
              invoiceLink: popupUrl,
            };
          }
        }

        if (sourceHref) {
          return await downloadChatInvoiceUrlWithBrowserContext(page, sourceHref, mapping, { text: meta?.text || sourceText });
        }
      } finally {
        await closePageQuietly(popup);
      }
    }
  }

  if (sourceHref) {
    return {
      status: 'manual_required',
      reason: '发现疑似发票链接，但未能定位到可点击元素',
      invoiceLink: sourceHref,
    };
  }
  return { status: 'blocked', reason: '未能点击聊天中的疑似发票附件' };
}

async function clickChatFileDownloadButton(context, page, mapping) {
  const scopes = getActiveChatScopes(page);
  for (const scope of scopes) {
    const scopeText = await scope.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!isLikelyChatInvoiceFileText(scopeText)) continue;

    for (const text of CHAT_FILE_DOWNLOAD_TEXTS) {
      const locator = scope.locator('a, button, [role="button"], div, span').filter({ hasText: text });
      const count = Math.min(await locator.count().catch(() => 0), 20);
      for (let index = count - 1; index >= 0; index -= 1) {
        const target = locator.nth(index);
        if (!(await target.isVisible().catch(() => false))) continue;
        const meta = await target.evaluate(el => {
          const card = el.closest('[class*="file"], [class*="File"], [class*="message"], [class*="Message"], [class*="bubble"], [class*="Bubble"]');
          return {
            text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
            cardText: (card?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
            href: el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '',
            className: typeof el.className === 'string' ? el.className : '',
          };
        }).catch(() => null);
        const label = `${meta?.text || ''} ${meta?.cardText || ''}`;
        if (!isLikelyChatInvoiceFileText(label) && text === '下载') continue;

        const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
        const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
        await withTimeout(target.click({ timeout: 8000, noWaitAfter: true }).catch(() => null), 5000, null);
        const download = await downloadPromise;
        const popup = await popupPromise;
        try {
          if (download) {
            return await saveChatDownload(download, mapping, {
              href: normalizeUrl(meta?.href || '', scope.url()),
              text: meta?.cardText || meta?.text || text,
            });
          }
          if (popup) {
            await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => null);
            const popupDownload = await popup.waitForEvent('download', { timeout: 8000 }).catch(() => null);
            if (popupDownload) {
              return await saveChatDownload(popupDownload, mapping, {
                href: popup.url(),
                text: meta?.cardText || meta?.text || text,
              });
            }
          }
        } finally {
          await closePageQuietly(popup);
        }
      }
    }
  }

  return { status: 'blocked', reason: '未找到可点击的聊天文件下载按钮' };
}

async function downloadInvoiceFromChatReply(context, page, mapping, chatReply) {
  const existingDownload = getDownloadedLedgerRecord(mapping.bizOrderId);
  if (existingDownload && !cliArgs.forceDownload) {
    return {
      status: 'file_exists',
      reason: '下载台账中已有该订单发票文件，跳过聊天附件重复下载',
      filename: existingDownload.filename || path.basename(existingDownload.path || ''),
      existingPath: existingDownload.path || '',
      path: existingDownload.path || '',
    };
  }

  const fileButtonResult = await clickChatFileDownloadButton(context, page, mapping);
  if (['downloaded', 'file_exists'].includes(fileButtonResult.status)) {
    return fileButtonResult;
  }

  for (const link of chatReply.invoiceLinks || []) {
    const result = await clickChatInvoiceLink(context, page, link, mapping);
    if (['downloaded', 'file_exists', 'manual_required'].includes(result.status)) {
      return result;
    }
  }

  return { status: 'blocked', reason: '未能下载聊天中的疑似发票附件或链接' };
}

async function openOrderInListPage(page, orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) {
    return { found: false, reason: '缺少订单号，无法在订单列表中检索' };
  }

  console.log(`    [联系商家] 回到订单列表查找 ${normalizedOrderId}`);
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
  await waitForRelevantPageContent(page).catch(() => null);
  await sleep(800);
  try { await page.click('text=知道了', { timeout: 1200 }); } catch {}

  const directContainer = page.locator(`#shopOrderContainer_${normalizedOrderId}`).first();
  if (await directContainer.isVisible().catch(() => false)) {
    console.log(`    [联系商家] 订单 ${normalizedOrderId} 已在当前列表页可见`);
    return { found: true, searchUsed: false };
  }

  const searchInput = page.locator('input[placeholder*="订单号"], input[placeholder*="店铺名"], input[placeholder*="快递单号"]').first();
  if (!(await searchInput.isVisible().catch(() => false))) {
    return { found: false, reason: '未找到订单列表搜索框' };
  }

  await searchInput.click({ timeout: 5000 }).catch(() => null);
  await searchInput.fill(normalizedOrderId, { timeout: 5000 }).catch(() => null);

  const waitForOrderCard = async () => {
    return page.waitForFunction(orderId => {
      return Boolean(document.querySelector(`#shopOrderContainer_${orderId}`));
    }, normalizedOrderId, { timeout: 10000 }).then(() => true).catch(() => false);
  };

  await searchInput.press('Enter').catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
  let found = await waitForOrderCard();
  if (found) {
    console.log(`    [联系商家] 已通过搜索框定位到订单 ${normalizedOrderId}`);
    return { found: true, searchUsed: true };
  }

  const searchIcon = page.locator('[class*="headerSearchInputIcon"]').first();
  if (await searchIcon.isVisible().catch(() => false)) {
    await searchIcon.click({ timeout: 5000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    found = await waitForOrderCard();
  }

  if (!found) {
    return { found: false, reason: '订单列表搜索后未定位到目标订单' };
  }

  console.log(`    [联系商家] 已通过搜索按钮定位到订单 ${normalizedOrderId}`);
  return { found: true, searchUsed: true };
}

async function clickSellerContactInOrderCard(context, page, orderId) {
  const selectors = [
    `#shopOrderContainer_${orderId} a[href*="amos.alicdn.com/getcid.aw"]`,
    `#shopOrderContainer_${orderId} .ww-inline`,
    `#shopOrderContainer_${orderId} [data-spm="order_wangwang"] a`,
    `#shopOrderContainer_${orderId} [data-nick] a`,
    `#shopOrderContainer_${orderId} [data-nick]`,
  ];

  for (const selector of selectors) {
    const target = page.locator(selector).first();
    if (!(await target.isVisible().catch(() => false))) continue;

    const text = (await target.textContent().catch(() => '') || '').trim();
    const href = await target.getAttribute('href').catch(() => '');
    const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    console.log(`    [联系商家] 尝试点击订单卡片卖家入口: ${selector}`);
    await withTimeout(target.click({ timeout: 8000, noWaitAfter: true }).catch(() => null), 5000, null);
    const popup = await popupPromise;
    const actionPage = popup || page;
    await withTimeout(actionPage.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => null), 13000, null);
    await withTimeout(waitForContactPageReady(actionPage, 12000).catch(() => null), 13000, null);
    return {
      page: actionPage,
      openedPopup: Boolean(popup),
      clickedText: text || '旺旺在线',
      href: normalizeUrl(href || '', page.url()),
      selector,
    };
  }

  return null;
}

async function tryContactSellerFromOrderList(context, page, mapping, invoiceConfig) {
  const sourceLabel = '订单列表页';
  const openResult = await openOrderInListPage(page, mapping.bizOrderId);
  if (!openResult.found) {
    return {
      status: 'manual_required',
      reason: `${sourceLabel}${openResult.reason ? `：${openResult.reason}` : '未找到目标订单'}`,
      attempts: [{
        source: sourceLabel,
        reason: openResult.reason || '未找到目标订单',
        finalUrl: page.url(),
      }],
      finalUrl: page.url(),
    };
  }

  const clickResult = await clickSellerContactInOrderCard(context, page, mapping.bizOrderId).catch(() => null);
  if (!clickResult) {
    return {
      status: 'manual_required',
      reason: `${sourceLabel}未找到旺旺/商家联系入口`,
      attempts: [{
        source: sourceLabel,
        reason: '未找到旺旺/商家联系入口',
        finalUrl: page.url(),
      }],
      finalUrl: page.url(),
    };
  }

  const attempts = [];
  const actionPage = clickResult.page;
  try {
    console.log(`    [联系商家] 已从订单列表进入卖家入口: ${clickResult.clickedText || clickResult.href || 'unknown'}`);
    const sendResult = await sendSellerMessageOnPage(actionPage, mapping, invoiceConfig);
    if (sendResult.status === 'seller_contacted') {
      return {
        ...sendResult,
        attempts,
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
        source: sourceLabel,
      };
    }

    attempts.push({
      source: sourceLabel,
      candidateText: clickResult.clickedText,
      reason: sendResult.reason,
      finalUrl: sendResult.finalUrl || actionPage.url(),
      href: clickResult.href,
    });
    return {
      status: 'manual_required',
      reason: summarizeContactAttempts(attempts, `${sourceLabel}未能进入商家会话`),
      attempts,
      finalUrl: sendResult.finalUrl || actionPage.url(),
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function openSellerChatFromLedgerOrOrder(context, page, mapping) {
  const contactedRecord = getContactedLedgerRecord(mapping.bizOrderId);
  const attempts = [];
  const ledgerUrl = contactedRecord?.finalUrl || '';
  if (ledgerUrl && !looksLikePlatformCustomerService(ledgerUrl) && !isTradeDetailUrl(ledgerUrl) && !ledgerUrl.includes('invoice-ua.taobao.com')) {
    console.log(`    [聊天回访] 尝试打开台账聊天页: ${ledgerUrl}`);
    await page.goto(ledgerUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(error => {
      attempts.push({ source: 'contacted-ledger', reason: error.message, finalUrl: ledgerUrl });
    });
    await waitForContactPageReady(page, 15000).catch(() => null);
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!isLoginOrVerifyUrl(page.url()) && !looksLikePlatformCustomerService(page.url()) && /发送|聊天|消息|旺旺|发票|附件|文件|pdf|ofd/i.test(bodyText)) {
      return { page, openedPopup: false, source: 'contacted-ledger', attempts };
    }
    attempts.push({ source: 'contacted-ledger', reason: '台账 URL 未打开可读商家聊天页', finalUrl: page.url() });
  }

  const openResult = await openOrderInListPage(page, mapping.bizOrderId);
  if (!openResult.found) {
    attempts.push({ source: '订单列表页', reason: openResult.reason || '未找到目标订单', finalUrl: page.url() });
    return {
      status: 'manual_required',
      reason: summarizeContactAttempts(attempts, '未能定位订单以打开商家聊天'),
      attempts,
      finalUrl: page.url(),
    };
  }

  const clickResult = await clickSellerContactInOrderCard(context, page, mapping.bizOrderId).catch(() => null);
  if (!clickResult) {
    attempts.push({ source: '订单列表页', reason: '未找到旺旺/商家联系入口', finalUrl: page.url() });
    return {
      status: 'manual_required',
      reason: summarizeContactAttempts(attempts, '未找到商家聊天入口'),
      attempts,
      finalUrl: page.url(),
    };
  }

  return { ...clickResult, source: '订单列表页', attempts };
}

async function inspectSellerChatReply(context, page, mapping, invoiceConfig) {
  console.log(`    [聊天回访] 检查订单 ${mapping.bizOrderId}`);
  const existingReply = getChatReplyLedgerRecord(mapping.bizOrderId);
  if (existingReply?.invoiceFilePath && fs.existsSync(existingReply.invoiceFilePath) && !cliArgs.forceDownload) {
    return {
      status: 'file_exists',
      replyCategory: existingReply.replyCategory || 'invoice_downloaded_from_chat',
      reason: '聊天回访台账已有发票文件，跳过重复下载',
      invoiceFilePath: existingReply.invoiceFilePath,
      finalUrl: existingReply.finalUrl || page.url(),
      checkedAt: new Date().toISOString(),
      downloadResult: {
        status: 'file_exists',
        existingPath: existingReply.invoiceFilePath,
        path: existingReply.invoiceFilePath,
        filename: path.basename(existingReply.invoiceFilePath),
      },
    };
  }

  const openResult = await openSellerChatFromLedgerOrOrder(context, page, mapping);
  if (openResult.status === 'manual_required') {
    const result = {
      status: 'manual_required',
      replyCategory: 'chat_open_failed',
      reason: openResult.reason,
      attempts: openResult.attempts || [],
      finalUrl: openResult.finalUrl || page.url(),
      checkedAt: new Date().toISOString(),
    };
    recordChatReplyOrder(mapping, result);
    return result;
  }

  const chatPage = openResult.page;
  try {
    const verification = await handleVerificationIfNeeded(chatPage, '聊天回访前需要安全验证');
    if (verification.blocked) {
      const result = {
        status: 'manual_required',
        replyCategory: 'security_verification',
        state: ORDER_STATES.NEED_MANUAL_SECURITY_CHECK,
        reason: verification.reason,
        finalUrl: chatPage.url(),
        checkedAt: new Date().toISOString(),
      };
      recordChatReplyOrder(mapping, result);
      return result;
    }

    await dismissKnownChatHints(chatPage).catch(() => null);
    await waitForContactPageReady(chatPage, 12000).catch(() => null);
    const snapshot = await collectChatReplySnapshot(chatPage, invoiceConfig);
    const reply = classifyChatReply(snapshot);
    let downloadResult = null;

    if (reply.status === 'can_download') {
      downloadResult = await downloadInvoiceFromChatReply(context, chatPage, mapping, reply);
      const result = {
        status: downloadResult.status === 'downloaded' || downloadResult.status === 'file_exists' ? downloadResult.status : 'manual_required',
        replyCategory: downloadResult.status === 'downloaded' || downloadResult.status === 'file_exists'
          ? 'invoice_downloaded_from_chat'
          : reply.replyCategory,
        state: downloadResult.status === 'downloaded' || downloadResult.status === 'file_exists'
          ? ORDER_STATES.DOWNLOADED
          : ORDER_STATES.FAILED_RETRYABLE,
        reason: downloadResult.reason || reply.reason,
        invoiceLink: downloadResult.invoiceLink || reply.invoiceLinks?.[0]?.href || '',
        downloadResult,
        chatReply: {
          ...reply,
          invoiceLinks: reply.invoiceLinks?.slice(0, 8) || [],
        },
        finalUrl: chatPage.url(),
        checkedAt: new Date().toISOString(),
      };
      recordChatReplyOrder(mapping, result);
      return result;
    }

    const result = {
      status: reply.status === 'waiting' ? 'chat_waiting_reply' : reply.status,
      replyCategory: reply.replyCategory,
      state: reply.state,
      reason: reply.reason,
      invoiceLink: reply.invoiceLinks?.[0]?.href || '',
      chatReply: {
        ...reply,
        invoiceLinks: reply.invoiceLinks?.slice(0, 8) || [],
      },
      finalUrl: chatPage.url(),
      checkedAt: new Date().toISOString(),
    };
    recordChatReplyOrder(mapping, result);
    return result;
  } finally {
    if (openResult.openedPopup) {
      await closePageQuietly(chatPage);
    }
  }
}

async function tryContactSellerOnPage(context, page, mapping, invoiceConfig, sourceLabel) {
  const originalUrl = page.url();
  const attempts = [];
  const candidates = (await collectActionCandidates(page))
    .filter(candidate => candidate.type === 'contact_seller' && candidate.visible && !candidate.disabled)
    .sort((left, right) => rankSellerContactCandidate(right, originalUrl) - rankSellerContactCandidate(left, originalUrl));

  if (candidates.length === 0) {
    return {
      status: 'manual_required',
      reason: `${sourceLabel}未找到联系商家入口`,
      attempts: [{
        source: sourceLabel,
        reason: '未找到联系商家入口',
        finalUrl: page.url(),
      }],
    };
  }

  for (const candidate of candidates) {
    const normalizedHref = normalizeUrl(candidate.href || '', originalUrl);
    console.log(`    [联系商家] ${sourceLabel}尝试入口: ${candidate.text || candidate.matchedWord || 'unknown'} ${normalizedHref || ''}`.trim());
    if (normalizedHref && looksLikePlatformCustomerService(normalizedHref) && !isSellerContactText(candidate.text)) {
      attempts.push({
        source: sourceLabel,
        candidateText: candidate.text,
        reason: '入口直接指向淘宝平台客服',
      });
      continue;
    }

    const clickResult = await clickActionCandidate(context, page, candidate, { contactMode: true }).catch(() => null);
    if (!clickResult) {
      attempts.push({
        source: sourceLabel,
        candidateText: candidate.text,
        reason: '点击入口失败',
      });
      continue;
    }

    const actionPage = clickResult.page;
    try {
      const sendResult = await sendSellerMessageOnPage(actionPage, mapping, invoiceConfig);
      if (sendResult.status === 'seller_contacted') {
        return {
          ...sendResult,
          attempts,
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          source: sourceLabel,
        };
      }

      attempts.push({
        source: sourceLabel,
        candidateText: clickResult.clickedText,
        reason: sendResult.reason,
        finalUrl: sendResult.finalUrl || actionPage.url(),
      });
    } finally {
      if (clickResult.openedPopup) {
        await closePageQuietly(actionPage);
      } else {
        await restorePageUrl(page, originalUrl);
      }
    }
  }

  return {
    status: 'manual_required',
    reason: summarizeContactAttempts(attempts, `${sourceLabel}未能进入商家会话`),
    attempts,
    finalUrl: page.url(),
  };
}

async function contactSellerForInvoice(context, page, mapping, invoiceConfig) {
  console.log(`    [联系商家] 开始处理订单 ${mapping.bizOrderId}`);
  const contactedRecord = getContactedLedgerRecord(mapping.bizOrderId);
  if (contactedRecord && !cliArgs.forceContact) {
    console.log(`    [联系商家] 台账已有记录，跳过重复发送: ${mapping.bizOrderId}`);
    return {
      status: 'seller_contacted',
      reason: '已在联系商家台账中，跳过重复发送',
      skippedDuplicate: true,
      ledgerRecord: contactedRecord,
      message: contactedRecord.message || '',
      executedAt: contactedRecord.contactedAt || contactedRecord.updatedAt || new Date().toISOString(),
      finalUrl: contactedRecord.finalUrl || page.url(),
    };
  }

  const inlineAttempt = await tryContactSellerOnPage(context, page, mapping, invoiceConfig, '发票页');
  if (inlineAttempt.status === 'seller_contacted') {
    return inlineAttempt;
  }

  const detailAttempts = [...(inlineAttempt.attempts || [])];
  for (const detailUrl of buildOrderDetailUrlCandidates(mapping)) {
    console.log(`    [联系商家] 切换到订单详情页尝试: ${detailUrl}`);
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    await waitForRelevantPageContent(page).catch(() => null);
    await sleep(800);
    try { await page.click('text=知道了', { timeout: 1200 }); } catch {}

    const attempt = await tryContactSellerOnPage(context, page, mapping, invoiceConfig, `订单详情页(${detailUrl})`);
    if (attempt.status === 'seller_contacted') {
      return {
        ...attempt,
        attempts: detailAttempts.concat(attempt.attempts || []),
      };
    }

    detailAttempts.push(...(attempt.attempts || []));
  }

  const listAttempt = await tryContactSellerFromOrderList(context, page, mapping, invoiceConfig);
  if (listAttempt.status === 'seller_contacted') {
    return {
      ...listAttempt,
      attempts: detailAttempts.concat(listAttempt.attempts || []),
    };
  }
  detailAttempts.push(...(listAttempt.attempts || []));

  return {
    status: 'manual_required',
    reason: summarizeContactAttempts(detailAttempts, inlineAttempt.reason || '未找到有效的商家联系入口'),
    attempts: detailAttempts,
    finalUrl: page.url(),
  };
}

async function clickSubmitInvoiceForm(page) {
  const submitWords = ['提交申请', '提交', '确认换开', '确认提交', '提交开票', '申请开票', '保存', '确定'];
  const dangerWords = ['删除', '取消', '关闭', '返回'];
  const clickableSelector = [
    'button',
    'a',
    '[role="button"]',
    'div[class*="button"]',
    'span[class*="button"]',
    'div[class*="btn"]',
    'span[class*="btn"]',
  ].join(',');

  for (const word of submitWords) {
    const locator = page.locator(clickableSelector).filter({ hasText: word });
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      const text = (await target.textContent().catch(() => '') || '').trim();
      if (dangerWords.some(danger => text.includes(danger))) continue;
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;
      await target.click({ timeout: 8000 });
      await sleep(2000);
      return { submitted: true, text };
    }
  }

  return { submitted: false, reason: 'submit_button_not_found' };
}

function buildExecutionMeta(base, patch = {}) {
  const execution = {
    action: base.actionPlan?.action || '',
    status: patch.status || 'unknown',
    reason: patch.reason || '',
    finalUrl: patch.finalUrl || base.detailUrl || '',
    retries: patch.retries || 0,
    executedAt: patch.executedAt || new Date().toISOString(),
    ...patch,
  };
  return {
    ...execution,
    state: patch.state || deriveStateFromExecution(execution, base.state || ORDER_STATES.CHECKING),
  };
}

function getMatchedRuleIds(classification) {
  return (classification?.matchedRules || []).map(rule => rule.id).filter(Boolean);
}

function buildInspectionTrace(state, classification, action = 'classify_page') {
  const trace = createOrderTrace(ORDER_STATES.PENDING);
  appendStateEvent(trace, {
    to: ORDER_STATES.CHECKING,
    action: 'inspect_order',
    reason: '打开订单发票页并读取页面',
  });
  appendStateEvent(trace, {
    to: state,
    action,
    reason: classification?.rawPrompt || classification?.category || '',
    category: classification?.category || '',
    matchedRules: getMatchedRuleIds(classification),
  });
  return trace;
}

function finalizeOrderResult(result) {
  if (!result || typeof result !== 'object') return result;
  const fallbackState = deriveStateFromClassification(result.pageClassification, result.state || ORDER_STATES.CHECKING);
  const finalState = result.execution?.state || fallbackState;
  const trace = result.stateTrace && Array.isArray(result.stateTrace.events)
    ? result.stateTrace
    : buildInspectionTrace(fallbackState, result.pageClassification, result.actionPlan?.action || 'classify_page');
  if (result.execution) {
    appendStateEvent(trace, {
      to: finalState,
      action: result.execution.action || result.actionPlan?.action || '',
      reason: result.execution.reason || '',
      category: result.pageClassification?.category || result.execution.pageClassification?.category || '',
      matchedRules: getMatchedRuleIds(result.pageClassification || result.execution.pageClassification),
      retry: Number(result.execution.retries || 0) > 0,
    });
  }
  result.state = finalState;
  result.stateTrace = trace;
  return result;
}

function shouldCaptureResultSnapshot(result) {
  const state = result?.execution?.state || result?.state || '';
  const status = result?.execution?.status || result?.status || '';
  const category = result?.pageClassification?.category || result?.execution?.pageClassification?.category || '';
  return Boolean(
    status === 'error'
    || status === 'blocked'
    || status === 'manual_required'
    || state === ORDER_STATES.FAILED_RETRYABLE
    || state === ORDER_STATES.FAILED_FINAL
    || state === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK
    || state === ORDER_STATES.NEED_MANUAL_PAYMENT_CONFIRM
    || state === ORDER_STATES.NEED_PRICE_DIFF_CONFIRM
    || category === 'unknown_error'
    || category === 'download_failed'
  );
}

async function handleVerificationIfNeeded(page, reason) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const parseResult = classifyPageErrorText(bodyText);
  if (!parseResult.hasVerificationError && !isLoginOrVerifyUrl(page.url())) {
    return { blocked: false, parseResult };
  }
  const waitResult = await pauseForManualVerification(page, reason);
  return {
    blocked: !waitResult.resolved,
    reason: waitResult.reason,
    parseResult,
  };
}

async function retryableFormSubmit(context, page, mapping, invoiceConfig, inspection, mode) {
  let retries = 0;
  let fillResult = null;
  let submitResult = null;
  let lastReason = '';

  while (retries <= CONFIG.maxRetries) {
    fillResult = await fillReissueForm(page, invoiceConfig);
    if (fillResult.missingRequired.length > 0) {
      return buildExecutionMeta(inspection, {
        action: mode,
        status: 'blocked',
        retries,
        fillResult,
        reason: `必填字段未填上: ${fillResult.missingRequired.join(', ')}`,
      });
    }
    if (!fillResult.validation?.ok) {
      lastReason = `字段回读校验失败: ${fillResult.validation.mismatches.map(item => `${item.fieldName}=${item.actual || 'empty'}`).join(', ')}`;
      retries += 1;
      if (retries > CONFIG.maxRetries) {
        return buildExecutionMeta(inspection, {
          action: mode,
          status: 'manual_required',
          retries: retries - 1,
          fillResult,
          reason: lastReason,
        });
      }
      continue;
    }

    submitResult = await clickSubmitInvoiceForm(page);
    const afterText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const afterClassification = classifyInvoicePage({
      text: afterText,
      url: page.url(),
      title: await page.title().catch(() => ''),
      invoiceInfo: inspection.invoiceInfo,
      candidates: await collectActionCandidates(page).catch(() => []),
    }, { invoiceConfig });
    const parsedError = classifyPageErrorText(afterText);
    if (afterClassification.status === ORDER_STATES.NEED_MANUAL_PAYMENT_CONFIRM || afterClassification.status === ORDER_STATES.NEED_PRICE_DIFF_CONFIRM) {
      return buildExecutionMeta(inspection, {
        action: mode,
        status: 'manual_required',
        state: afterClassification.status,
        retries,
        fillResult,
        submitResult,
        pageClassification: afterClassification,
        priceDiff: afterClassification.priceDiff,
        reason: afterClassification.manualReason || afterClassification.rawPrompt || '页面提示补差或金额差异',
      });
    }
    if (parsedError.hasRetryableError && retries < CONFIG.maxRetries) {
      retries += 1;
      lastReason = parsedError.primaryReason || '提交后页面提示可修正错误';
      continue;
    }
    if (parsedError.hasExpiredError) {
      return buildExecutionMeta(inspection, {
        action: mode,
        status: 'expired_deadline',
        retries,
        fillResult,
        submitResult,
        pageClassification: afterClassification,
        reason: parsedError.primaryReason || '页面提示超过开票期限',
      });
    }
    if (parsedError.hasVerificationError) {
      return buildExecutionMeta(inspection, {
        action: mode,
        status: 'manual_required',
        retries,
        fillResult,
        submitResult,
        pageClassification: afterClassification,
        reason: parsedError.primaryReason || '提交后需要人工验证',
        state: ORDER_STATES.NEED_MANUAL_SECURITY_CHECK,
      });
    }

    const successHint = ['申请成功', '提交成功', '换开成功', '开票成功', '已提交', '处理中'].find(word => afterText.includes(word));
    return buildExecutionMeta(inspection, {
      action: mode,
      status: submitResult.submitted ? (successHint && successHint.includes('处理中') ? 'pending' : 'submitted') : 'blocked',
      retries,
      fillResult,
      submitResult,
      pageClassification: afterClassification,
      successHint: successHint || '',
      reason: submitResult.submitted ? (successHint || '已提交') : '未找到提交按钮',
      finalUrl: page.url(),
    });
  }

  return buildExecutionMeta(inspection, {
    action: mode,
    status: 'manual_required',
    retries,
    fillResult,
    submitResult,
    reason: lastReason || '超过最大重试次数',
  });
}

async function executeApplyInvoice(context, page, mapping, invoiceConfig) {
  const inspection = await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'apply_invoice', status: 'error', reason: inspection.error, error: inspection.error }) };
  }
  if (inspection.pageClassification?.status === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'apply_invoice',
        status: 'manual_required',
        state: ORDER_STATES.NEED_MANUAL_SECURITY_CHECK,
        reason: inspection.pageClassification.manualReason || '页面需要人工安全验证',
      }),
    };
  }
  if ([ORDER_STATES.NEED_MANUAL_PAYMENT_CONFIRM, ORDER_STATES.NEED_PRICE_DIFF_CONFIRM].includes(inspection.pageClassification?.status)) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'apply_invoice',
        status: 'manual_required',
        state: inspection.pageClassification.status,
        pageClassification: inspection.pageClassification,
        priceDiff: inspection.pageClassification.priceDiff,
        reason: inspection.pageClassification.manualReason || inspection.pageClassification.rawPrompt || '页面提示补差或金额差异',
      }),
    };
  }

  const hasApplyCandidate = inspection.candidates?.some(candidate => candidate.type === 'apply_invoice' && candidate.visible && !candidate.disabled);
  if (inspection.invoiceInfo?.invoiceType !== 'no_invoice') {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'apply_invoice',
        status: 'skipped',
        reason: `只自动申请明确识别为未开票的订单，当前为 ${inspection.invoiceInfo?.invoiceType || 'unknown'}`,
      }),
    };
  }
  if (!hasApplyCandidate) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, { action: 'apply_invoice', status: 'skipped', reason: '没有发现可见的申请开票入口' }),
    };
  }

  const clickResult = await clickFirstAction(context, page, 'apply_invoice');
  const actionPage = clickResult.page;
  try {
    const verification = await handleVerificationIfNeeded(actionPage, '申请开票前需要安全验证');
    if (verification.blocked) {
      return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'apply_invoice', status: 'manual_required', reason: verification.reason }) };
    }

    const postClickCandidates = await collectActionCandidates(actionPage);
    if (postClickCandidates.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled)) {
      const downloadResult = await downloadFirstInvoice(context, actionPage, mapping, 'download_invoice', inspection);
      return {
        ...inspection,
        execution: buildExecutionMeta(inspection, {
          action: 'download_invoice',
          status: downloadResult.status,
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          downloadResult,
          finalUrl: actionPage.url(),
          reason: downloadResult.reason || '申请页已有可下载发票，已直接下载',
        }),
      };
    }

    const existingApplication = await detectExistingInvoiceApplication(actionPage, invoiceConfig);
    if (existingApplication.exists) {
      if (existingApplication.titleLooksLikeTaxNo) {
        const actionBodyText = await actionPage.evaluate(() => document.body.innerText || '').catch(() => '');
        const normalizedPostCandidates = postClickCandidates.map(candidate => ({
          ...candidate,
          href: normalizeUrl(candidate.href, actionPage.url()),
        }));
        const repairInspection = {
          ...inspection,
          detailUrl: actionPage.url(),
          detailBodyText: actionBodyText,
          candidates: normalizedPostCandidates,
          invoiceInfo: {
            invoiceType: 'wrong_company_title',
            invoiceTitle: '错抬头-疑似税号',
            confidence: 'high',
          },
          pageClassification: classifyInvoicePage({
            text: actionBodyText,
            url: actionPage.url(),
            title: await actionPage.title().catch(() => ''),
            candidates: normalizedPostCandidates,
            invoiceInfo: {
              invoiceType: 'wrong_company_title',
              invoiceTitle: '错抬头-疑似税号',
              confidence: 'high',
            },
          }, { invoiceConfig }),
          actionPlan: normalizedPostCandidates.some(candidate => candidate.type === 'modify_invoice' && candidate.visible && !candidate.disabled)
            ? { action: 'modify_invoice', confidence: 'high', reason: existingApplication.reason }
            : { action: 'contact_seller', confidence: 'medium', reason: existingApplication.reason },
        };

        if (repairInspection.actionPlan.action === 'modify_invoice') {
          const history = await inspectHistory(context, actionPage);
          const modifyResult = await executeModifyInvoice(context, actionPage, mapping, invoiceConfig, repairInspection, history);
          return {
            ...modifyResult,
            execution: {
              ...(modifyResult.execution || {}),
              originalAction: 'apply_invoice',
              existingApplication,
              clickedText: modifyResult.execution?.clickedText || clickResult.clickedText,
              openedPopup: clickResult.openedPopup || Boolean(modifyResult.execution?.openedPopup),
            },
          };
        }

        const modifiedRecord = getModifiedLedgerRecord(mapping.bizOrderId);
        if (modifiedRecord) {
          return {
            ...repairInspection,
            execution: buildExecutionMeta(repairInspection, {
              action: 'modify_invoice',
              status: 'pending',
              state: ORDER_STATES.APPLIED_WAITING,
              existingApplication,
              modifiedRecord,
              finalUrl: actionPage.url(),
              reason: '本地台账显示已提交过修改申请，等待商家处理，跳过重复修改/联系商家',
            }),
          };
        }

        const contactResult = await contactSellerForInvoice(context, actionPage, {
          ...mapping,
          contactReason: existingApplication.reason,
        }, invoiceConfig);
        return {
          ...repairInspection,
          execution: buildExecutionMeta(repairInspection, {
            action: 'contact_seller',
            status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
            existingApplication,
            contactResult,
            finalUrl: contactResult.finalUrl || actionPage.url(),
            reason: contactResult.reason || existingApplication.reason,
          }),
        };
      }

      return {
        ...inspection,
        execution: buildExecutionMeta(inspection, {
          action: 'apply_invoice',
          status: existingApplication.status,
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          existingApplication,
          finalUrl: actionPage.url(),
          reason: existingApplication.reason,
        }),
      };
    }

    const deadlineExceeded = await detectInvoiceDeadlineExceeded(actionPage);
    if (deadlineExceeded.exceeded) {
      const contactResult = await contactSellerForInvoice(context, actionPage, mapping, invoiceConfig);
      return {
        ...inspection,
        execution: buildExecutionMeta(inspection, {
          action: 'apply_invoice',
          status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          deadlineExceeded,
          contactResult,
          finalUrl: contactResult.finalUrl || actionPage.url(),
          reason: contactResult.reason || deadlineExceeded.reason,
        }),
      };
    }
    const history = await inspectHistory(context, actionPage);
    const submitMeta = await retryableFormSubmit(context, actionPage, mapping, invoiceConfig, inspection, 'apply_invoice');
    return {
      ...inspection,
      history,
      execution: {
        ...submitMeta,
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
      },
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function executeDownloadInvoice(context, page, mapping, invoiceConfig = {}) {
  const inspection = await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'download_invoice', status: 'error', reason: inspection.error, error: inspection.error }) };
  }

  const hasDownloadCandidate = inspection.candidates?.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled);
  if (hasDownloadCandidate) {
    const downloadResult = await downloadFirstInvoice(context, page, mapping, 'download_invoice', inspection);
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'download_invoice',
        status: downloadResult.status,
        downloadResult,
        reason: downloadResult.reason || '已下载发票',
      }),
    };
  }

  const hasViewCandidate = inspection.candidates?.some(candidate => candidate.type === 'view_invoice' && candidate.visible && !candidate.disabled);
  if (hasViewCandidate) {
    const clickResult = await clickFirstAction(context, page, 'view_invoice');
    const actionPage = clickResult.page;
    try {
      const candidates = await collectActionCandidates(actionPage);
      if (candidates.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled)) {
        const downloadResult = await downloadFirstInvoice(context, actionPage, mapping, 'download_invoice', inspection);
        return {
          ...inspection,
          execution: buildExecutionMeta(inspection, {
            action: 'download_invoice',
            status: downloadResult.status,
            clickedText: clickResult.clickedText,
            openedPopup: clickResult.openedPopup,
            downloadResult,
            reason: downloadResult.reason || '已从查看发票页下载',
          }),
        };
      }
    } finally {
      if (clickResult.openedPopup) {
        await closePageQuietly(actionPage);
      }
    }
  }

  return {
    ...inspection,
    execution: buildExecutionMeta(inspection, { action: 'download_invoice', status: 'skipped', reason: '没有发现可见下载入口' }),
  };
}

async function executeReissue(context, page, mapping, invoiceConfig) {
  const inspection = await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'reissue_invoice', status: 'error', reason: inspection.error, error: inspection.error }) };
  }

  const hasReissueCandidate = inspection.candidates?.some(candidate => candidate.type === 'reissue_invoice' && candidate.visible && !candidate.disabled);
  if (!invoiceNeedsReissue(inspection, invoiceConfig)) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'reissue_invoice',
        status: 'skipped',
        reason: `当前发票信息未被识别为需要换开，当前为 ${inspection.invoiceInfo?.invoiceType || 'unknown'}`,
      }),
    };
  }
  if (!hasReissueCandidate) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, { action: 'reissue_invoice', status: 'skipped', reason: '没有发现可见的换开入口' }),
    };
  }

  const clickResult = await clickFirstAction(context, page, 'reissue_invoice');
  const actionPage = clickResult.page;
  try {
    const verification = await handleVerificationIfNeeded(actionPage, '换开发票前需要安全验证');
    if (verification.blocked) {
      return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'reissue_invoice', status: 'manual_required', reason: verification.reason }) };
    }

    const submitMeta = await retryableFormSubmit(context, actionPage, mapping, invoiceConfig, inspection, 'reissue_invoice');
    if (['submitted', 'pending'].includes(submitMeta.status)) {
      recordModifiedOrder(mapping, submitMeta, { action: 'reissue_invoice', finalUrl: actionPage.url() });
    }

    return {
      ...inspection,
      execution: {
        ...submitMeta,
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
        originalInvoiceInfo: inspection.invoiceInfo || null,
      },
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function executeChatFollowup(context, page, mapping, invoiceConfig) {
  const chatReplyResult = await inspectSellerChatReply(context, page, mapping, invoiceConfig);
  const base = {
    status: 'ok',
    ...mapping,
    detailUrl: chatReplyResult.finalUrl || page.url(),
    pageTitle: '商家聊天回访',
    detailBodyText: '',
    orderMeta: {
      shopName: mapping.shopName || '',
      amount: mapping.amount || '',
    },
    invoiceInfo: {
      invoiceType: chatReplyResult.status === 'downloaded' || chatReplyResult.status === 'file_exists'
        ? 'chat_reply_invoice'
        : 'unknown',
      invoiceTitle: chatReplyResult.replyCategory || '商家聊天回访',
      confidence: 'medium',
    },
    pageClassification: {
      category: chatReplyResult.replyCategory || 'seller_chat_followup',
      status: chatReplyResult.state || ORDER_STATES.CONTACTED_SELLER,
      recommendedAction: chatReplyResult.status === 'downloaded' || chatReplyResult.status === 'file_exists' ? 'skip_download' : 'wait',
      matchedRules: [],
      rawPrompt: chatReplyResult.reason || '',
    },
    actionPlan: {
      action: 'chat_followup',
      confidence: 'medium',
      reason: '回访已联系商家的聊天窗口，识别商家旁路回复',
    },
    chatReply: chatReplyResult.chatReply || null,
    state: chatReplyResult.state || ORDER_STATES.CONTACTED_SELLER,
    stateTrace: buildInspectionTrace(chatReplyResult.state || ORDER_STATES.CONTACTED_SELLER, {
      category: chatReplyResult.replyCategory || 'seller_chat_followup',
      rawPrompt: chatReplyResult.reason || '',
      matchedRules: [],
    }, 'chat_followup'),
    checkedAt: chatReplyResult.checkedAt || new Date().toISOString(),
  };

  return {
    ...base,
    execution: buildExecutionMeta(base, {
      action: 'chat_followup',
      status: chatReplyResult.status,
      state: chatReplyResult.state,
      reason: chatReplyResult.reason,
      chatReplyResult,
      downloadResult: chatReplyResult.downloadResult || null,
      finalUrl: chatReplyResult.finalUrl || page.url(),
      executedAt: chatReplyResult.checkedAt || new Date().toISOString(),
    }),
  };
}

async function executeInvoiceAction(context, page, mapping, invoiceConfig) {
  if (cliArgs.action === 'chat') {
    return executeChatFollowup(context, page, mapping, invoiceConfig);
  }
  if (cliArgs.action === 'apply') {
    return executeApplyInvoice(context, page, mapping, invoiceConfig);
  }
  if (cliArgs.action === 'reissue') {
    return executeReissue(context, page, mapping, invoiceConfig);
  }
  if (cliArgs.action === 'download') {
    return executeDownloadInvoice(context, page, mapping, invoiceConfig);
  }

  const inspection = await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'all', status: 'error', reason: inspection.error, error: inspection.error }) };
  }
  if (inspection.pageClassification?.status === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'manual_security_check',
        status: 'manual_required',
        state: ORDER_STATES.NEED_MANUAL_SECURITY_CHECK,
        reason: inspection.pageClassification.manualReason || '页面需要人工安全验证',
      }),
    };
  }
  if ([ORDER_STATES.NEED_MANUAL_PAYMENT_CONFIRM, ORDER_STATES.NEED_PRICE_DIFF_CONFIRM].includes(inspection.pageClassification?.status)) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'manual_payment_or_price_diff',
        status: 'manual_required',
        state: inspection.pageClassification.status,
        pageClassification: inspection.pageClassification,
        priceDiff: inspection.pageClassification.priceDiff,
        reason: inspection.pageClassification.manualReason || inspection.pageClassification.rawPrompt || '页面提示补差或金额差异',
      }),
    };
  }
  const history = await inspectHistory(context, page);
  const rejectedDecision = classifyRejectedInvoiceHandling(inspection, history);
  if (rejectedDecision.action === 'manual_required') {
    return {
      ...inspection,
      history,
      rejectedDecision,
      execution: buildExecutionMeta(inspection, {
        action: 'manual_review',
        status: 'manual_required',
        reason: rejectedDecision.reason,
      }),
    };
  }
  if (rejectedDecision.action === 'contact_seller') {
    const contactResult = await contactSellerForInvoice(context, page, {
      ...mapping,
      rejectInfo: rejectedDecision.rejectInfo?.latest || null,
      contactReason: rejectedDecision.reason,
    }, invoiceConfig);
    return {
      ...inspection,
      history,
      rejectedDecision,
      execution: buildExecutionMeta(inspection, {
        action: 'contact_seller',
        status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
        contactResult,
        finalUrl: contactResult.finalUrl || page.url(),
        reason: contactResult.reason || rejectedDecision.reason,
      }),
    };
  }
  if (rejectedDecision.action === 'modify_invoice' || shouldAutoModify(inspection, history)) {
    return executeModifyInvoice(context, page, mapping, invoiceConfig, inspection, history);
  }
  if (inspection.actionPlan?.action === 'manual_review') {
    return {
      ...inspection,
      history,
      execution: buildExecutionMeta(inspection, { action: 'manual_review', status: 'manual_required', reason: inspection.actionPlan.reason }),
    };
  }
  if (inspection.actionPlan?.action === 'contact_seller') {
    const contactResult = await contactSellerForInvoice(context, page, {
      ...mapping,
      contactReason: inspection.actionPlan.reason,
    }, invoiceConfig);
    return {
      ...inspection,
      history,
      execution: buildExecutionMeta(inspection, {
        action: 'contact_seller',
        status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
        contactResult,
        finalUrl: contactResult.finalUrl || page.url(),
        reason: contactResult.reason || inspection.actionPlan.reason,
      }),
    };
  }
  if (inspection.actionPlan?.action === 'download_invoice' || inspection.actionPlan?.action === 'inspect_invoice') {
    return executeDownloadInvoice(context, page, mapping, invoiceConfig);
  }
  if (inspection.actionPlan?.action === 'reissue_invoice') {
    return executeReissue(context, page, mapping, invoiceConfig);
  }
  if (inspection.actionPlan?.action === 'apply_invoice') {
    return executeApplyInvoice(context, page, mapping, invoiceConfig);
  }
  return {
    ...inspection,
    execution: buildExecutionMeta(inspection, {
      action: 'all',
      status: 'skipped',
      reason: `没有可执行的开票/换开动作，当前计划为 ${inspection.actionPlan?.action || 'unknown'}`,
    }),
  };
}

function chooseRecommendedAction(invoiceInfo, candidates, pageClassification = null) {
  const visibleEnabled = candidates.filter(c => c.visible && !c.disabled);
  const byType = type => visibleEnabled.find(c => c.type === type);

  if (pageClassification?.status === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK) {
    return { action: 'manual_review', confidence: 'high', reason: pageClassification.manualReason || '页面需要人工安全验证' };
  }
  if (pageClassification?.status === ORDER_STATES.NEED_MANUAL_PAYMENT_CONFIRM || pageClassification?.status === ORDER_STATES.NEED_PRICE_DIFF_CONFIRM) {
    return { action: 'manual_review', confidence: 'high', reason: pageClassification.manualReason || pageClassification.rawPrompt || '页面提示补差或金额差异' };
  }
  if (pageClassification?.recommendedAction === 'contact_seller') {
    return { action: 'contact_seller', confidence: 'high', reason: pageClassification.rawPrompt || '页面提示需要联系商家处理' };
  }
  if (['wrong_title', 'wrong_tax_no', 'invoice_info_mismatch'].includes(pageClassification?.category)) {
    if (byType('modify_invoice')) return { action: 'modify_invoice', confidence: 'high', reason: pageClassification.rawPrompt || '发票信息不符合配置，发现修改申请入口' };
    if (byType('reissue_invoice')) return { action: 'reissue_invoice', confidence: 'high', reason: pageClassification.rawPrompt || '发票信息不符合配置，发现换开入口' };
    return { action: 'contact_seller', confidence: 'medium', reason: '发票信息不符合配置，但未发现修改/换开入口，改为联系商家' };
  }
  if (pageClassification?.recommendedAction === 'apply_invoice' && byType('apply_invoice')) {
    return { action: 'apply_invoice', confidence: 'high', reason: pageClassification.rawPrompt || '页面识别为可申请开票' };
  }
  if (pageClassification?.recommendedAction === 'download_invoice' && byType('download_invoice')) {
    return { action: 'download_invoice', confidence: 'high', reason: pageClassification.rawPrompt || '页面识别为可下载发票' };
  }

  if (invoiceInfo.invoiceType === 'wrong_company_title' && byType('modify_invoice')) {
    return { action: 'modify_invoice', confidence: 'high', reason: '发票抬头像税号，发现修改申请入口' };
  }
  if (invoiceInfo.invoiceType === 'wrong_company_title' && byType('reissue_invoice')) {
    return { action: 'reissue_invoice', confidence: 'high', reason: '发票抬头像税号，发现换开入口' };
  }
  if (invoiceInfo.invoiceType === 'wrong_company_title') {
    return { action: 'contact_seller', confidence: 'medium', reason: '发票抬头像税号，但未发现修改/换开入口，改为联系商家' };
  }
  if (invoiceInfo.invoiceType === 'personal' && byType('reissue_invoice')) {
    return { action: 'reissue_invoice', confidence: 'medium', reason: '个人发票且发现换开入口' };
  }
  if (invoiceInfo.invoiceType === 'no_invoice' && byType('apply_invoice')) {
    return { action: 'apply_invoice', confidence: 'medium', reason: '未开票且发现申请开票入口' };
  }
  if (byType('download_invoice')) {
    return { action: 'download_invoice', confidence: 'medium', reason: '发现可见下载发票入口' };
  }
  if (byType('view_invoice')) {
    return { action: 'inspect_invoice', confidence: 'low', reason: '发现查看发票入口，需要进一步打开确认' };
  }
  if (visibleEnabled.length > 0) {
    return { action: 'manual_review', confidence: 'low', reason: '发现发票相关入口，但无法安全判断动作' };
  }
  return { action: 'no_action', confidence: 'none', reason: '未发现可操作发票入口' };
}

async function inspectOrder(page, mapping, invoiceConfig = {}) {
  try {
    await page.goto(mapping.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
    await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    await waitForRelevantPageContent(page);
    await sleep(800);
    try { await page.click('text=知道了', { timeout: 1500 }); } catch {}

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const pageTitle = await page.title().catch(() => '');
    const invoiceInfo = classifyInvoiceText(bodyText);
    const orderMeta = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const amountMatch = bodyText.match(/实付款[\s\S]{0,20}?￥\s*([0-9.,]+)/) || bodyText.match(/发票金额[\s\S]{0,12}?￥\s*([0-9.,]+)/);
      const shopName = bodyText.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,40}(旗舰店|专卖店|企业店|店铺))/)?.[1] || '';
      return {
        amount: amountMatch?.[1] ? amountMatch[1].replace(/,/g, '') : '',
        shopName: shopName.trim(),
      };
    }).catch(() => ({ amount: '', shopName: '' }));
    const candidates = await collectActionCandidates(page);
    const normalizedCandidates = candidates.map(candidate => ({
      ...candidate,
      href: normalizeUrl(candidate.href, page.url()),
    }));
    const pageClassification = classifyInvoicePage({
      text: bodyText,
      url: page.url(),
      title: pageTitle,
      candidates: normalizedCandidates,
      invoiceInfo,
    }, { invoiceConfig });
    const actionPlan = chooseRecommendedAction(invoiceInfo, normalizedCandidates, pageClassification);
    const state = deriveStateFromClassification(pageClassification, ORDER_STATES.CHECKING);

    return {
      status: 'ok',
      ...mapping,
      detailUrl: page.url(),
      pageTitle,
      detailBodyText: bodyText,
      orderMeta,
      invoiceInfo,
      pageClassification,
      state,
      stateTrace: buildInspectionTrace(state, pageClassification, actionPlan.action),
      actionPlan,
      candidates: normalizedCandidates,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    const snapshot = await collectPageSnapshot(page, mapping, 'inspect-error', invoiceConfig, { saveArtifacts: true }).catch(() => null);
    const pageClassification = snapshot
      ? classifyInvoicePage(snapshot, { invoiceConfig })
      : classifyInvoicePage({ text: e.message || '' }, { invoiceConfig });
    return {
      status: 'error',
      ...mapping,
      error: e.message,
      pageClassification,
      state: ORDER_STATES.FAILED_RETRYABLE,
      stateTrace: buildInspectionTrace(ORDER_STATES.FAILED_RETRYABLE, pageClassification, 'inspect_error'),
      artifacts: snapshot?.artifacts || {},
      checkedAt: new Date().toISOString(),
    };
  }
}

function shouldSkipExisting(result) {
  if (!result) return false;
  if (cliArgs.action === 'chat') {
    return ['downloaded', 'file_exists'].includes(result.execution?.status)
      || result.execution?.chatReplyResult?.replyCategory === 'price_diff_required';
  }
  if (artifactLooksLikeWrongTitle(result)) return false;
  if (cliArgs.execute) {
    return TERMINAL_EXECUTION_STATUS.has(result.execution?.status) || isTerminalState(result.state || result.execution?.state);
  }
  if (RETRYABLE_STATUS.has(result.status)) return false;
  if (cliArgs.retryUncertain && UNCERTAIN_STATUS.has(result.actionPlan?.action)) return false;
  return true;
}

function seedTerminalResultsFromArtifacts(resultsById) {
  for (const [bizOrderId, artifact] of collectTerminalResultsFromArtifacts()) {
    if (!bizOrderId || resultsById[bizOrderId]) continue;
    resultsById[bizOrderId] = artifact;
  }
}

function buildSummary(results) {
  const summary = {
    total: results.length,
    downloadInvoice: 0,
    applyInvoice: 0,
    reissueInvoice: 0,
    inspectInvoice: 0,
    manualReview: 0,
    noAction: 0,
    errors: 0,
    mutatingCandidates: 0,
    submitted: 0,
    downloaded: 0,
    fileExists: 0,
    pending: 0,
    blocked: 0,
    skipped: 0,
    expiredDeadline: 0,
    sellerContacted: 0,
    manualRequired: 0,
    needPriceDiffConfirm: 0,
    needManualSecurityCheck: 0,
    needManualPaymentConfirm: 0,
    failedRetryable: 0,
    failedFinal: 0,
    chatDownloaded: 0,
    chatWaitingReply: 0,
    chatManualRequired: 0,
  };

  for (const result of results) {
    if (result.status === 'error') {
      summary.errors++;
      continue;
    }
    const action = result.actionPlan?.action;
    if (action === 'download_invoice') summary.downloadInvoice++;
    else if (action === 'apply_invoice') summary.applyInvoice++;
    else if (action === 'reissue_invoice') summary.reissueInvoice++;
    else if (action === 'inspect_invoice') summary.inspectInvoice++;
    else if (action === 'manual_review') summary.manualReview++;
    else summary.noAction++;

    if (result.candidates?.some(candidate => MUTATING_ACTIONS.has(candidate.type))) {
      summary.mutatingCandidates++;
    }
    if (result.execution?.status === 'submitted') summary.submitted++;
    if (result.execution?.status === 'downloaded') summary.downloaded++;
    if (result.execution?.status === 'file_exists') {
      summary.fileExists++;
      summary.downloaded++;
    }
    if (result.execution?.status === 'pending') summary.pending++;
    if (result.execution?.status === 'blocked') summary.blocked++;
    if (result.execution?.status === 'skipped') summary.skipped++;
    if (result.execution?.status === 'expired_deadline') summary.expiredDeadline++;
    if (result.execution?.status === 'seller_contacted') summary.sellerContacted++;
    if (result.execution?.status === 'manual_required') summary.manualRequired++;
    if (result.execution?.status === 'chat_waiting_reply') summary.chatWaitingReply++;
    if (result.execution?.action === 'chat_followup' && ['downloaded', 'file_exists'].includes(result.execution?.status)) summary.chatDownloaded++;
    if (result.execution?.action === 'chat_followup' && result.execution?.status === 'manual_required') summary.chatManualRequired++;
    const state = result.state || result.execution?.state;
    if (state === ORDER_STATES.NEED_PRICE_DIFF_CONFIRM) summary.needPriceDiffConfirm++;
    if (state === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK) summary.needManualSecurityCheck++;
    if (state === ORDER_STATES.NEED_MANUAL_PAYMENT_CONFIRM) summary.needManualPaymentConfirm++;
    if (state === ORDER_STATES.FAILED_RETRYABLE) summary.failedRetryable++;
    if (state === ORDER_STATES.FAILED_FINAL) summary.failedFinal++;
  }
  return summary;
}

async function main() {
  console.log('='.repeat(60));
  console.log('🧾 淘宝发票动作 dry-run 计划生成器');
  console.log('='.repeat(60));

  if (cliArgs.execute && cliArgs.confirm !== CONFIRM_TEXT) {
    throw new Error(`执行模式需要 --confirm=${CONFIRM_TEXT}`);
  }
  if (cliArgs.execute && !EXECUTABLE_ACTIONS.has(cliArgs.action)) {
    throw new Error(`执行模式目前只支持 --action=apply、--action=reissue、--action=download、--action=chat 或 --action=all`);
  }
  const invoiceConfig = cliArgs.execute ? loadInvoiceConfig() : null;

  const progress = cliArgs.fresh ? null : loadProgress();
  let mappings = progress?.mappings || null;
  const resultsById = progress?.resultsById && typeof progress.resultsById === 'object'
    ? progress.resultsById
    : {};
  const artifactMappings = collectMappingsFromArtifacts();
  if (!cliArgs.fresh) {
    seedTerminalResultsFromArtifacts(resultsById);
  }
  if (cliArgs.execute) {
    seedContactedLedgerFromArtifacts();
    seedModifiedLedgerFromArtifacts();
  }
  const overdueCutoffByMonth = new Map();
  for (const existing of Object.values(resultsById)) {
    if (existing?.execution?.status !== 'expired_deadline') continue;
    const monthKey = getMonthKey(existing.orderDate);
    if (!monthKey || !existing.orderDate) continue;
    const current = overdueCutoffByMonth.get(monthKey);
    if (!current || existing.orderDate > current) {
      overdueCutoffByMonth.set(monthKey, existing.orderDate);
    }
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    slowMo: 150,
  });

  const page = context.pages()[0] || await context.newPage();
  await closeAuxiliaryPages(context, page);

  try {
    await ensureLoggedIn(page);

    if (cliArgs.action === 'chat' && cliArgs.orderIds.length === 0) {
      const contactedLedger = loadContactedLedger();
      const mappingById = new Map();
      for (const record of Object.values(contactedLedger.orders || {})) {
        if (!record?.orderId) continue;
        mergeMappingCandidate(mappingById, {
          bizOrderId: String(record.orderId),
          platform: 'taobao',
          orderDate: record.orderDate || '',
          amount: record.amount || '',
          shopName: record.shopName || '',
          url: record.invoiceUrl || buildInvoiceDetailUrl(record.orderId),
          detailUrl: record.invoiceUrl || '',
          invoiceUrl: record.invoiceUrl || buildInvoiceDetailUrl(record.orderId),
          sourceTag: 'contacted_ledger_chat_followup',
        });
      }
      mappings = [...mappingById.values()];
      console.log(`\n💬 聊天回访模式：从联系商家台账读取 ${mappings.length} 个订单`);
    }

    if (!mappings && cliArgs.orderIds.length > 0) {
      const prioritized = cliArgs.orderIds
        .map(orderId => artifactMappings.get(orderId))
        .filter(Boolean);
      const mappingById = new Map();
      for (const mapping of prioritized) {
        mergeMappingCandidate(mappingById, mapping);
      }
      const missingFromArtifacts = cliArgs.orderIds.filter(orderId => !mappingById.has(orderId));
      for (const orderId of missingFromArtifacts) {
        const contactedRecord = getContactedLedgerRecord(orderId);
        mergeMappingCandidate(mappingById, contactedRecord ? {
          ...buildFallbackMappingFromOrderId(orderId),
          orderDate: contactedRecord.orderDate || '',
          amount: contactedRecord.amount || '',
          shopName: contactedRecord.shopName || '',
          invoiceUrl: contactedRecord.invoiceUrl || buildInvoiceDetailUrl(orderId),
          url: contactedRecord.invoiceUrl || buildInvoiceDetailUrl(orderId),
          sourceTag: 'contacted_ledger_chat_followup',
        } : buildFallbackMappingFromOrderId(orderId));
      }
      mappings = cliArgs.orderIds.map(orderId => mappingById.get(orderId)).filter(Boolean);
      if (missingFromArtifacts.length > 0) {
        console.log(`\n⚠️  历史映射中缺少部分指定订单，已改用发票详情页直达: ${missingFromArtifacts.join(', ')}`);
      } else {
        console.log(`\n🎯 定向模式：已从历史结果恢复指定订单 ${mappings.length} 个，无需先全量翻页`);
      }
    }

    if (!mappings) {
      mappings = await extractBizOrderIds(page);
    }
    if (cliArgs.orderIds.length > 0) {
      const wanted = new Set(cliArgs.orderIds);
      const mappingById = new Map();
      for (const mapping of mappings) {
        mergeMappingCandidate(mappingById, mapping);
      }
      for (const orderId of cliArgs.orderIds) {
        const artifactMapping = artifactMappings.get(orderId);
        if (artifactMapping) {
          mergeMappingCandidate(mappingById, artifactMapping);
        }
      }
      const filtered = cliArgs.orderIds
        .map(orderId => mappingById.get(orderId))
        .filter(Boolean);
      const missing = cliArgs.orderIds.filter(orderId => !mappingById.has(orderId));
      if (missing.length > 0) {
        for (const orderId of missing) {
          const fallback = buildFallbackMappingFromOrderId(orderId);
          mergeMappingCandidate(mappingById, fallback);
          filtered.push(fallback);
        }
        console.log(`\n⚠️  指定订单未在历史/当前列表中出现，已改用发票详情页直达: ${missing.join(', ')}`);
      }
      mappings = filtered;
      console.log(`\n🎯 定向模式：仅处理指定订单 ${mappings.length} 个`);
    }
    if (cliArgs.test && cliArgs.test > 0) {
      console.log(`\n⚠️  测试模式：仅处理前 ${cliArgs.test} 个订单`);
      mappings = mappings.slice(0, cliArgs.test);
    }

    console.log('\n' + '='.repeat(60));
    console.log(`🚀 开始生成动作计划（共 ${mappings.length} 个）`);
    console.log('='.repeat(60));

    for (let i = 0; i < mappings.length; i++) {
      const mapping = mappings[i];
      if (shouldSkipExisting(resultsById[mapping.bizOrderId])) {
        console.log(`  [${i + 1}/${mappings.length}] 跳过已检查 ${mapping.bizOrderId}`);
        continue;
      }

      const monthKey = getMonthKey(mapping.orderDate);
      const overdueCutoff = monthKey ? overdueCutoffByMonth.get(monthKey) : '';
      if (cliArgs.execute && overdueCutoff && mapping.orderDate && mapping.orderDate <= overdueCutoff) {
        const skippedResult = buildExpiredDeadlineSkipResult(mapping, overdueCutoff);
        resultsById[mapping.bizOrderId] = finalizeOrderResult(skippedResult);
        console.log(`  [${i + 1}/${mappings.length}] ${mapping.bizOrderId} (${mapping.platform}) → apply_invoice / expired_deadline | ${skippedResult.execution.reason}`);
        saveJsonAtomic(PROGRESS_FILE, {
          version: '0.1.0',
          dryRun: !cliArgs.execute,
          action: cliArgs.action,
          mappings,
          resultsById,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      let result;
      try {
        result = cliArgs.execute
          ? await executeInvoiceAction(context, page, mapping, invoiceConfig)
          : await inspectOrder(page, mapping, invoiceConfig || {});
      } finally {
        await closeAuxiliaryPages(context, page);
      }
      result = finalizeOrderResult(result);
      if (shouldCaptureResultSnapshot(result)) {
        const snapshot = await collectPageSnapshot(
          page,
          mapping,
          `final-${result.state || result.execution?.status || result.status}`,
          invoiceConfig || {},
          {
            saveArtifacts: true,
            historyText: result.history?.historyText || '',
            invoiceInfo: result.invoiceInfo || null,
            candidates: result.candidates || null,
          }
        ).catch(() => null);
        if (snapshot?.artifacts) {
          result.artifacts = {
            ...(result.artifacts || {}),
            ...snapshot.artifacts,
          };
        }
      }
      resultsById[mapping.bizOrderId] = result;

      if (result.execution?.status === 'expired_deadline' && monthKey && mapping.orderDate) {
        const currentCutoff = overdueCutoffByMonth.get(monthKey);
        if (!currentCutoff || mapping.orderDate > currentCutoff) {
          overdueCutoffByMonth.set(monthKey, mapping.orderDate);
        }
      }

      const action = result.actionPlan?.action || result.status;
      const execution = result.execution ? ` / ${result.execution.status}` : '';
      const reason = result.execution?.reason || result.actionPlan?.reason || result.error || '';
      console.log(`  [${i + 1}/${mappings.length}] ${mapping.bizOrderId} (${mapping.platform}) → ${action}${execution} | ${reason}`);

      saveJsonAtomic(PROGRESS_FILE, {
        version: '0.1.0',
        dryRun: !cliArgs.execute,
        action: cliArgs.action,
        mappings,
        resultsById,
        updatedAt: new Date().toISOString(),
      });

      await randomDelay();
    }

    const results = mappings.map(mapping => resultsById[mapping.bizOrderId]).filter(Boolean);
    const summary = buildSummary(results);
    const output = {
      version: '0.1.0',
      dryRun: !cliArgs.execute,
      action: cliArgs.action,
      generatedAt: new Date().toISOString(),
      summary,
      results,
    };
    saveJsonAtomic(OUTPUT_FILE, output);
    saveResultsCsv(OUTPUT_CSV_FILE, results);

    console.log('\n' + '='.repeat(60));
    console.log(cliArgs.execute ? '📊 执行完成' : '📊 dry-run 计划完成');
    console.log('='.repeat(60));
    console.log(`  可下载：${summary.downloadInvoice}`);
    console.log(`  可申请开票：${summary.applyInvoice}`);
    console.log(`  可换开：${summary.reissueInvoice}`);
    console.log(`  可查看后确认：${summary.inspectInvoice}`);
    console.log(`  需人工复核：${summary.manualReview}`);
    console.log(`  无动作：${summary.noAction}`);
    console.log(`  错误：${summary.errors}`);
    if (cliArgs.execute) {
      console.log(`  已提交：${summary.submitted}`);
      console.log(`  已下载：${summary.downloaded}`);
      console.log(`  复用已下载文件：${summary.fileExists}`);
      console.log(`  处理中：${summary.pending}`);
      console.log(`  已阻止：${summary.blocked}`);
      console.log(`  已跳过：${summary.skipped}`);
      console.log(`  超期开票：${summary.expiredDeadline}`);
      console.log(`  已联系商家：${summary.sellerContacted}`);
      console.log(`  需人工处理：${summary.manualRequired}`);
      console.log(`  待确认补差：${summary.needPriceDiffConfirm}`);
      console.log(`  待人工安全验证：${summary.needManualSecurityCheck}`);
      console.log(`  待人工付款确认：${summary.needManualPaymentConfirm}`);
      console.log(`  可重试失败：${summary.failedRetryable}`);
      console.log(`  最终失败：${summary.failedFinal}`);
      if (cliArgs.action === 'chat') {
        console.log(`  聊天回访下载：${summary.chatDownloaded}`);
        console.log(`  聊天等待回复：${summary.chatWaitingReply}`);
        console.log(`  聊天需人工确认：${summary.chatManualRequired}`);
      }
    }
    console.log(`\n💾 结果文件: ${OUTPUT_FILE}`);
    console.log(`💾 结果表: ${OUTPUT_CSV_FILE}`);

    if (cliArgs.closeOnFinish) {
      await context.close();
      console.log('\n✅ 完成，浏览器已关闭');
    } else {
      console.log('\n✅ 浏览器保持打开，手动关闭即可');
      await new Promise(() => {});
    }
  } catch (e) {
    await context.close().catch(() => null);
    throw e;
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('❌ 致命错误:', e.message);
    process.exit(1);
  });
}

module.exports = {
  classifyChatReply,
  isLikelyInvoiceHref,
};
