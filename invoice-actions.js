// 淘宝发票动作计划生成器
// 默认只做 dry-run：识别下载、查看、申请开票、换开等候选动作，不提交表单。
process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

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
    if (!arg.startsWith('--')) continue;
    const [key, value = ''] = arg.slice(2).split('=');
    if (key === 'test') args.test = parseInt(value, 10) || null;
    if (key === 'max-pages') args.maxPages = parseInt(value, 10) || args.maxPages;
    if (key === 'output') args.output = value;
    if (key === 'progress') args.progress = value;
    if (key === 'confirm') args.confirm = value;
    if (key === 'action') args.action = value || args.action;
    if (key === 'start-date') args.startDate = value || args.startDate;
    if (key === 'end-date') args.endDate = value || args.endDate;
    if (key === 'download-dir') args.downloadDir = value || args.downloadDir;
    if (key === 'config') args.config = value || args.config;
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
const PROGRESS_FILE = safeRelativePath(cliArgs.progress, 'invoice-action-progress.json');
const CONFIG_FILE = safeRelativePath(cliArgs.config, 'invoice-config.json');
const DOWNLOAD_DIR = safeRelativePath(cliArgs.downloadDir, 'downloads');
const LIST_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const CONFIRM_TEXT = 'YES_EXECUTE_TAOBAO_INVOICE_ACTIONS';

const CONFIG = {
  listWaitTimeout: 20000,
  pageTimeout: 60000,
  detailWaitTimeout: 30000,
  loginWaitTimeout: 180000,
  delayMin: 1500,
  delayMax: 3000,
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
  { type: 'apply_invoice', words: ['申请开票', '开具发票', '我要开票'] },
];

const MUTATING_ACTIONS = new Set(['apply_invoice', 'reissue_invoice', 'send_email']);
const RETRYABLE_STATUS = new Set(['error']);
const UNCERTAIN_STATUS = new Set(['unknown', 'no_action']);
const EXECUTABLE_ACTIONS = new Set(['reissue', 'apply', 'download', 'all']);
const TERMINAL_EXECUTION_STATUS = new Set(['submitted', 'pending', 'downloaded', 'skipped', 'expired_deadline']);

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  };
}

function saveJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
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

function normalizeUrl(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href.startsWith('//') ? `https:${href}` : href, baseUrl).href;
  } catch {
    return href;
  }
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

async function ensureLoggedIn(page) {
  console.log('📄 验证登录...');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
  await sleep(3000);

  if (!isLoginOrVerifyUrl(page.url())) {
    console.log('✅ 已登录');
    return;
  }

  console.log('\n⚠️  需要登录！请在浏览器中扫码或完成验证...');
  await page.waitForFunction(
    markers => !markers.some(marker => location.href.toLowerCase().includes(marker)),
    LOGIN_URL_MARKERS,
    { timeout: CONFIG.loginWaitTimeout }
  );
  console.log('✅ 登录成功');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
  await sleep(2000);
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

        results.push({
          bizOrderId,
          platform: tmallMatch ? 'tmall' : 'taobao',
          orderDate,
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
      await sleep(1500);
      return { page: actionPage, openedPopup: Boolean(popup), clickedText: word };
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

async function downloadFirstInvoice(context, page, mapping, preferredType = 'download_invoice') {
  ensureDirectory(DOWNLOAD_DIR);
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
            return await downloadFirstInvoice(context, popup, mapping, 'download_invoice');
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
        const ext = path.extname(suggested) || '.pdf';
        const base = sanitizeFilenamePart(`${mapping.orderDate || 'unknown_date'}_${mapping.bizOrderId}_${suggested.replace(ext, '')}`);
        const targetPath = path.join(DOWNLOAD_DIR, `${base}${ext}`);
        await download.saveAs(targetPath);
        return {
          status: 'downloaded',
          clickedText: word,
          filename: path.basename(targetPath),
          path: targetPath,
        };
      } finally {
        await closePageQuietly(popup);
      }
    }
  }

  return { status: 'blocked', reason: '没有找到可点击下载入口' };
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

async function fillReissueForm(page, invoiceConfig) {
  await clickRadioOrOption(page, ['企业', '单位', '公司']);

  const filledFields = [];
  filledFields.push(await fillFirstVisible(page, [
    'input[placeholder*="发票抬头"]',
    'input[placeholder*="抬头名称"]',
    'input[placeholder*="公司名称"]',
    'input[placeholder*="单位名称"]',
    'input[name*="title" i]',
    'input[name*="company" i]',
    'input[id*="title" i]',
    'input[id*="company" i]',
  ], invoiceConfig.companyName, 'companyName', ['发票抬头', '抬头名称', '公司名称', '单位名称']));

  filledFields.push(await fillFirstVisible(page, [
    'input[placeholder*="税号"]',
    'input[placeholder*="纳税人识别号"]',
    'input[placeholder*="统一社会信用代码"]',
    'input[name*="tax" i]',
    'input[id*="tax" i]',
    'input[name*="payer" i]',
    'input[id*="payer" i]',
  ], invoiceConfig.taxNo, 'taxNo', ['纳税人识别号', '税号', '统一社会信用代码']));

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

  filledFields.push(await fillFirstVisible(page, [
    'input[placeholder*="地址"]',
    'textarea[placeholder*="地址"]',
    'input[name*="address" i]',
    'textarea[name*="address" i]',
  ], invoiceConfig.address, 'address', ['单位地址', '注册地址', '地址']));

  filledFields.push(await fillFirstVisible(page, [
    'input[placeholder*="开户行"]',
    'input[placeholder*="银行"]',
    'input[name*="bank" i]',
    'input[id*="bank" i]',
  ], invoiceConfig.bankName, 'bankName', ['开户银行', '开户行', '银行']));

  filledFields.push(await fillFirstVisible(page, [
    'input[placeholder*="银行账号"]',
    'input[placeholder*="账号"]',
    'input[name*="account" i]',
    'input[id*="account" i]',
  ], invoiceConfig.bankAccount, 'bankAccount', ['银行账户', '银行账号', '账号']));

  const requiredFilled = filledFields.filter(field => ['companyName', 'taxNo'].includes(field.fieldName));
  const missingRequired = requiredFilled.filter(field => !field.filled).map(field => field.fieldName);
  return { filledFields, missingRequired };
}

async function detectExistingInvoiceApplication(page, invoiceConfig) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const pending = ['申请中', '商家正在处理', '已提交', '处理中', '查看申请历史'].some(word => bodyText.includes(word));
  const success = ['已开票', '申请成功', '提交成功', '开票成功', '换开成功'].some(word => bodyText.includes(word));
  const hasCompany = invoiceConfig.companyName && bodyText.includes(invoiceConfig.companyName);
  const hasTaxNo = invoiceConfig.taxNo && bodyText.includes(invoiceConfig.taxNo);

  if (pending || success) {
    return {
      exists: true,
      status: success ? 'submitted' : 'pending',
      hasCompany,
      hasTaxNo,
      reason: success ? '页面显示已提交/成功' : '页面显示申请中/处理中',
    };
  }

  return { exists: false, status: '' };
}

async function detectInvoiceDeadlineExceeded(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const keywords = [
    '超过开票日期',
    '已超过开票日期',
    '超过可开票时间',
    '已超过可开票时间',
    '超过开票时间',
    '开票申请已截止',
    '超过申请时效',
    '开票已截止',
  ];
  const hit = keywords.find(word => bodyText.includes(word));
  if (!hit) return { exceeded: false };

  return {
    exceeded: true,
    keyword: hit,
    reason: `页面提示${hit}`,
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

async function executeApplyInvoice(context, page, mapping, invoiceConfig) {
  const inspection = await inspectOrder(page, mapping);
  if (inspection.status === 'error') {
    return { ...inspection, execution: { status: 'error', error: inspection.error } };
  }

  const hasApplyCandidate = inspection.candidates?.some(candidate => candidate.type === 'apply_invoice' && candidate.visible && !candidate.disabled);
  if (inspection.invoiceInfo?.invoiceType !== 'no_invoice') {
    return {
      ...inspection,
      execution: {
        status: 'skipped',
        reason: `只自动申请明确识别为未开票的订单，当前为 ${inspection.invoiceInfo?.invoiceType || 'unknown'}`,
      },
    };
  }
  if (!hasApplyCandidate) {
    return {
      ...inspection,
      execution: { status: 'skipped', reason: '没有发现可见的申请开票入口' },
    };
  }

  const clickResult = await clickFirstAction(context, page, 'apply_invoice');
  const actionPage = clickResult.page;
  try {
    const postClickCandidates = await collectActionCandidates(actionPage);
    if (postClickCandidates.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled)) {
      const downloadResult = await downloadFirstInvoice(context, actionPage, mapping, 'download_invoice');
      return {
        ...inspection,
        execution: {
          status: downloadResult.status,
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          downloadResult,
          finalUrl: actionPage.url(),
          executedAt: new Date().toISOString(),
        },
      };
    }

    const existingApplication = await detectExistingInvoiceApplication(actionPage, invoiceConfig);
    if (existingApplication.exists) {
      return {
        ...inspection,
        execution: {
          status: existingApplication.status,
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          existingApplication,
          finalUrl: actionPage.url(),
          executedAt: new Date().toISOString(),
        },
      };
    }

    const deadlineExceeded = await detectInvoiceDeadlineExceeded(actionPage);
    if (deadlineExceeded.exceeded) {
      return {
        ...inspection,
        execution: {
          status: 'expired_deadline',
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          deadlineExceeded,
          finalUrl: actionPage.url(),
          reason: deadlineExceeded.reason,
          executedAt: new Date().toISOString(),
        },
      };
    }

    const fillResult = await fillReissueForm(actionPage, invoiceConfig);
    if (fillResult.missingRequired.length > 0) {
      return {
        ...inspection,
        execution: {
          status: 'blocked',
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          fillResult,
          reason: `必填字段未填上: ${fillResult.missingRequired.join(', ')}`,
        },
      };
    }

    const submitResult = await clickSubmitInvoiceForm(actionPage);
    const afterText = await actionPage.evaluate(() => document.body.innerText || '').catch(() => '');
    const successHint = ['申请成功', '提交成功', '开票成功', '已提交', '处理中'].find(word => afterText.includes(word));

    return {
      ...inspection,
      execution: {
        status: submitResult.submitted ? 'submitted' : 'blocked',
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
        fillResult,
        submitResult,
        successHint: successHint || '',
        finalUrl: actionPage.url(),
        executedAt: new Date().toISOString(),
      },
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function executeDownloadInvoice(context, page, mapping) {
  const inspection = await inspectOrder(page, mapping);
  if (inspection.status === 'error') {
    return { ...inspection, execution: { status: 'error', error: inspection.error } };
  }

  const hasDownloadCandidate = inspection.candidates?.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled);
  if (hasDownloadCandidate) {
    const downloadResult = await downloadFirstInvoice(context, page, mapping, 'download_invoice');
    return {
      ...inspection,
      execution: {
        status: downloadResult.status,
        downloadResult,
        executedAt: new Date().toISOString(),
      },
    };
  }

  const hasViewCandidate = inspection.candidates?.some(candidate => candidate.type === 'view_invoice' && candidate.visible && !candidate.disabled);
  if (hasViewCandidate) {
    const clickResult = await clickFirstAction(context, page, 'view_invoice');
    const actionPage = clickResult.page;
    try {
      const candidates = await collectActionCandidates(actionPage);
      if (candidates.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled)) {
        const downloadResult = await downloadFirstInvoice(context, actionPage, mapping, 'download_invoice');
        return {
          ...inspection,
          execution: {
            status: downloadResult.status,
            clickedText: clickResult.clickedText,
            openedPopup: clickResult.openedPopup,
            downloadResult,
            executedAt: new Date().toISOString(),
          },
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
    execution: {
      status: 'skipped',
      reason: '没有发现可见下载入口',
    },
  };
}

async function executeReissue(context, page, mapping, invoiceConfig) {
  const inspection = await inspectOrder(page, mapping);
  if (inspection.status === 'error') {
    return { ...inspection, execution: { status: 'error', error: inspection.error } };
  }

  const hasReissueCandidate = inspection.candidates?.some(candidate => candidate.type === 'reissue_invoice' && candidate.visible && !candidate.disabled);
  if (inspection.invoiceInfo?.invoiceType !== 'personal') {
    return {
      ...inspection,
      execution: {
        status: 'skipped',
        reason: `只自动换开明确识别为个人发票的订单，当前为 ${inspection.invoiceInfo?.invoiceType || 'unknown'}`,
      },
    };
  }
  if (!hasReissueCandidate) {
    return {
      ...inspection,
      execution: { status: 'skipped', reason: '没有发现可见的换开入口' },
    };
  }

  const clickResult = await clickFirstAction(context, page, 'reissue_invoice');
  const actionPage = clickResult.page;
  try {
    const fillResult = await fillReissueForm(actionPage, invoiceConfig);
    if (fillResult.missingRequired.length > 0) {
      return {
        ...inspection,
        execution: {
          status: 'blocked',
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          fillResult,
          reason: `必填字段未填上: ${fillResult.missingRequired.join(', ')}`,
        },
      };
    }

    const submitResult = await clickSubmitInvoiceForm(actionPage);
    const afterText = await actionPage.evaluate(() => document.body.innerText || '').catch(() => '');
    const successHint = ['申请成功', '提交成功', '换开成功', '已提交', '处理中'].find(word => afterText.includes(word));

    return {
      ...inspection,
      execution: {
        status: submitResult.submitted ? 'submitted' : 'blocked',
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
        fillResult,
        submitResult,
        successHint: successHint || '',
        finalUrl: actionPage.url(),
        executedAt: new Date().toISOString(),
      },
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function executeInvoiceAction(context, page, mapping, invoiceConfig) {
  if (cliArgs.action === 'apply') {
    return executeApplyInvoice(context, page, mapping, invoiceConfig);
  }
  if (cliArgs.action === 'reissue') {
    return executeReissue(context, page, mapping, invoiceConfig);
  }
  if (cliArgs.action === 'download') {
    return executeDownloadInvoice(context, page, mapping);
  }

  const inspection = await inspectOrder(page, mapping);
  if (inspection.status === 'error') {
    return { ...inspection, execution: { status: 'error', error: inspection.error } };
  }
  if (inspection.actionPlan?.action === 'download_invoice' || inspection.actionPlan?.action === 'inspect_invoice') {
    return executeDownloadInvoice(context, page, mapping);
  }
  if (inspection.actionPlan?.action === 'reissue_invoice') {
    return executeReissue(context, page, mapping, invoiceConfig);
  }
  if (inspection.actionPlan?.action === 'apply_invoice') {
    return executeApplyInvoice(context, page, mapping, invoiceConfig);
  }
  return {
    ...inspection,
    execution: {
      status: 'skipped',
      reason: `没有可执行的开票/换开动作，当前计划为 ${inspection.actionPlan?.action || 'unknown'}`,
    },
  };
}

function chooseRecommendedAction(invoiceInfo, candidates) {
  const visibleEnabled = candidates.filter(c => c.visible && !c.disabled);
  const byType = type => visibleEnabled.find(c => c.type === type);

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

async function inspectOrder(page, mapping) {
  try {
    await page.goto(mapping.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
    await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    await sleep(1500);
    try { await page.click('text=知道了', { timeout: 1500 }); } catch {}

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const invoiceInfo = classifyInvoiceText(bodyText);
    const candidates = await collectActionCandidates(page);
    const actionPlan = chooseRecommendedAction(invoiceInfo, candidates);

    return {
      status: 'ok',
      ...mapping,
      detailUrl: page.url(),
      invoiceInfo,
      actionPlan,
      candidates: candidates.map(candidate => ({
        ...candidate,
        href: normalizeUrl(candidate.href, page.url()),
      })),
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      status: 'error',
      ...mapping,
      error: e.message,
      checkedAt: new Date().toISOString(),
    };
  }
}

function shouldSkipExisting(result) {
  if (!result) return false;
  if (cliArgs.execute) {
    return TERMINAL_EXECUTION_STATUS.has(result.execution?.status);
  }
  if (RETRYABLE_STATUS.has(result.status)) return false;
  if (cliArgs.retryUncertain && UNCERTAIN_STATUS.has(result.actionPlan?.action)) return false;
  return true;
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
    pending: 0,
    blocked: 0,
    skipped: 0,
    expiredDeadline: 0,
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
    if (result.execution?.status === 'pending') summary.pending++;
    if (result.execution?.status === 'blocked') summary.blocked++;
    if (result.execution?.status === 'skipped') summary.skipped++;
    if (result.execution?.status === 'expired_deadline') summary.expiredDeadline++;
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
    throw new Error(`执行模式目前只支持 --action=apply、--action=reissue、--action=download 或 --action=all`);
  }
  const invoiceConfig = cliArgs.execute ? loadInvoiceConfig() : null;

  const progress = cliArgs.fresh ? null : loadProgress();
  let mappings = progress?.mappings || null;
  const resultsById = progress?.resultsById && typeof progress.resultsById === 'object'
    ? progress.resultsById
    : {};
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

    if (!mappings) {
      mappings = await extractBizOrderIds(page);
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
        resultsById[mapping.bizOrderId] = skippedResult;
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
          : await inspectOrder(page, mapping);
      } finally {
        await closeAuxiliaryPages(context, page);
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
      console.log(`  处理中：${summary.pending}`);
      console.log(`  已阻止：${summary.blocked}`);
      console.log(`  已跳过：${summary.skipped}`);
      console.log(`  超期开票：${summary.expiredDeadline}`);
    }
    console.log(`\n💾 计划文件: ${OUTPUT_FILE}`);

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

main().catch(e => {
  console.error('❌ 致命错误:', e.message);
  process.exit(1);
});
