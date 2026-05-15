const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const COOKIES_FILE = path.join(ROOT, 'taobao-cookies.json');
const CONFIG_FILE = path.join(ROOT, 'invoice-config.json');
const SOURCE_FILE = path.join(ROOT, 'invoice-action-2025-2026-execute.json');
const DOWNLOAD_DIR = path.join(ROOT, 'downloads');

const TODAY = new Date().toISOString().slice(0, 10);
const OUTPUT_FILE = path.join(ROOT, `repair-paper-invoices-${TODAY}.json`);
const PROGRESS_FILE = path.join(ROOT, `repair-paper-invoices-${TODAY}.progress.json`);

const APPLY_WORDS = ['申请开票', '开具发票', '我要开票'];
const REISSUE_WORDS = ['换开发票', '换开', '重新开票', '重开发票'];
const DOWNLOAD_WORDS = ['下载发票', '发票下载'];
const HISTORY_WORDS = ['申请历史', '查看申请历史'];
const MODIFY_WORDS = ['修改申请'];
const PROCESSING_WORDS = ['申请中', '处理中', '商家正在处理', '已提交'];
const REJECTED_WORDS = ['商家拒绝', '审核不通过', '审核未通过', '申请失败', '拒绝开票'];
const SUCCESS_HINTS = ['申请中', '处理中', '提交成功', '申请成功', '开票成功', '换开成功', '商家正在处理'];
const EMAIL_REASON_HINTS = [
  '缺少邮箱',
  '未提供邮箱',
  '未填写邮箱',
  '未留邮箱',
  '邮箱缺失',
  '请补充邮箱',
  '请补充电子邮箱',
  '请填写邮箱',
  '请填写电子邮箱',
  '请提供邮箱',
  '请提供电子邮箱',
  '需要提供邮箱',
  '需要提供电子邮箱',
  '提供电子邮箱',
  '电子发票需要邮箱',
  '邮箱到旺旺',
  '旺旺发送邮箱',
];

let REQUIRED_SHIPPING_NEEDLES = [];
let REQUIRED_SHIPPING_NORMALIZED = [];

function configureRequiredShippingNeedles(invoiceConfig) {
  REQUIRED_SHIPPING_NEEDLES = [
    invoiceConfig.paperShippingAddress || invoiceConfig.address,
    invoiceConfig.paperShippingName,
    invoiceConfig.paperShippingPhone,
    invoiceConfig.companyName,
  ].filter(Boolean);
  REQUIRED_SHIPPING_NORMALIZED = REQUIRED_SHIPPING_NEEDLES.map(item => item.replace(/\s+/g, ''));
}

const FIELD_POSITION = {
  companyName: 0,
  taxNo: 1,
  address: 2,
  phone: 3,
  bankName: 4,
  bankAccount: 5,
};

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeSpace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeTight(text) {
  return String(text || '').replace(/\s+/g, '');
}

function requiresEmailReason(text) {
  const haystack = String(text || '');
  return EMAIL_REASON_HINTS.some(item => haystack.includes(item));
}

function shippingTextMatches(text) {
  const tight = normalizeTight(text);
  return REQUIRED_SHIPPING_NORMALIZED.length > 0
    && REQUIRED_SHIPPING_NORMALIZED.every(needle => tight.includes(needle));
}

function extractShippingSnippet(text) {
  const haystack = String(text || '');
  for (const label of ['收票地址：', '收票地址', '收货地址：', '收货地址', '收件地址：', '收件地址']) {
    const idx = haystack.indexOf(label);
    if (idx === -1) continue;
    return normalizeSpace(haystack.slice(idx, idx + 220));
  }
  return '';
}

function looksLikeAddressOptionText(text) {
  const normalized = normalizeSpace(text);
  if (!normalized) return false;
  if (normalized.length < 18 || normalized.length > 120) return false;
  if (normalized.includes('保存取消') || normalized.includes('全部功能') || normalized.includes('我的购物车')) return false;
  return true;
}

function buildInvoiceUrl(orderId) {
  return `https://invoice-ua.taobao.com/detail/pc#/?orderId=${orderId}`;
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function hasLoginUrl(url) {
  return /login\.taobao\.com|passport|havana/i.test(String(url || ''));
}

async function waitForInvoiceContent(page, timeoutMs = 4000) {
  const keywords = [
    ...DOWNLOAD_WORDS,
    ...APPLY_WORDS,
    ...REISSUE_WORDS,
    ...REJECTED_WORDS,
    ...PROCESSING_WORDS,
    '发票抬头',
    '发票代码',
    '发票号码',
    '发票类型',
    '已开票',
    '未开票',
    '暂未开票',
  ];
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (keywords.some(word => bodyText.includes(word))) {
      return bodyText;
    }
    await sleep(400);
  }

  return page.evaluate(() => document.body.innerText || '').catch(() => '');
}

function pickOrders() {
  const source = loadJson(SOURCE_FILE);
  const seen = new Map();

  for (const result of source.results || []) {
    if (!result.bizOrderId) continue;
    seen.set(result.bizOrderId, {
      bizOrderId: result.bizOrderId,
      orderDate: result.orderDate || '',
      platform: result.platform || '',
      sourceStatus: result.execution?.status || '',
      sourceAction: result.actionPlan?.action || '',
      invoiceUrl: buildInvoiceUrl(result.bizOrderId),
    });
  }

  let orders = [...seen.values()].sort((a, b) => {
    if (a.orderDate === b.orderDate) return String(a.bizOrderId).localeCompare(String(b.bizOrderId));
    return String(a.orderDate).localeCompare(String(b.orderDate));
  });

  const orderId = getArg('order-id');
  const limit = Number.parseInt(getArg('limit', '0'), 10);
  if (orderId) {
    const filtered = orders.filter(order => order.bizOrderId === orderId);
    orders = filtered.length > 0
      ? filtered
      : [{
        bizOrderId: orderId,
        orderDate: '',
        platform: '',
        sourceStatus: '',
        sourceAction: '',
        invoiceUrl: buildInvoiceUrl(orderId),
      }];
  }
  if (Number.isFinite(limit) && limit > 0) {
    orders = orders.slice(0, limit);
  }
  return orders;
}

function findExistingDownload(orderId) {
  if (!fs.existsSync(DOWNLOAD_DIR)) return null;
  const files = fs.readdirSync(DOWNLOAD_DIR);
  const match = files.find(file => file.includes(`_${orderId}_`) || file.includes(`_${orderId}.`));
  return match ? path.join(DOWNLOAD_DIR, match) : null;
}

function loadProgressMap() {
  if (hasFlag('fresh') || !fs.existsSync(PROGRESS_FILE)) return {};
  try {
    const data = loadJson(PROGRESS_FILE);
    return data && typeof data.resultsById === 'object' ? data.resultsById : {};
  } catch {
    return {};
  }
}

function isFinalStatus(status) {
  return [
    'repaired',
    'submitted',
    'downloaded',
    'already_correct',
    'already_downloaded',
    'processing',
    'expired_deadline',
    'no_invoice_entry',
    'unknown',
    'rejected_pending_manual',
    'no_modify_entry',
    'blocked',
    'error',
    'login_required',
  ].includes(status);
}

async function closePageQuietly(page) {
  if (!page || page.isClosed()) return;
  await page.close({ runBeforeUnload: false }).catch(() => null);
}

async function closeAuxiliaryPages(context, keepPage) {
  for (const openPage of context.pages()) {
    if (openPage === keepPage) continue;
    await closePageQuietly(openPage);
  }
}

async function fallbackDomClick(page, words) {
  return page.evaluate(({ words }) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalize(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
    }

    function depth(el) {
      let value = 0;
      let cursor = el;
      while (cursor?.parentElement) {
        value += 1;
        cursor = cursor.parentElement;
      }
      return value;
    }

    function isClickable(el) {
      const tag = String(el.tagName || '').toUpperCase();
      const role = el.getAttribute('role') || '';
      const href = el.getAttribute('href') || '';
      const onclick = el.getAttribute('onclick') || '';
      const style = window.getComputedStyle(el);
      return tag === 'A'
        || tag === 'BUTTON'
        || role === 'button'
        || Boolean(href)
        || Boolean(onclick)
        || style.cursor === 'pointer';
    }

    function findClickableTarget(el) {
      let cursor = el;
      while (cursor && cursor !== document.body) {
        if (isVisible(cursor) && isClickable(cursor)) {
          return cursor;
        }
        cursor = cursor.parentElement;
      }
      return isVisible(el) ? el : null;
    }

    const selector = 'a, button, [role="button"], div, span, p, li, td, em, strong';
    const candidates = [...document.querySelectorAll(selector)]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: normalize(el.textContent || ''),
        depth: depth(el),
      }))
      .filter(item => item.text.length > 0 && item.text.length <= 120)
      .filter(item => words.some(word => item.text.includes(word)))
      .sort((a, b) => (a.text.length - b.text.length) || (b.depth - a.depth));

    for (const candidate of candidates) {
      const target = findClickableTarget(candidate.el);
      if (!target) continue;
      target.click();
      return {
        clicked: true,
        text: candidate.text,
        targetTag: String(target.tagName || '').toLowerCase(),
        mode: target === candidate.el ? 'dom-self' : 'dom-ancestor',
      };
    }

    return { clicked: false };
  }, { words }).catch(() => ({ clicked: false }));
}

async function collectDownloadTargets(page) {
  return page.evaluate(({ words }) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalize(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
    }

    function depth(el) {
      let value = 0;
      let cursor = el;
      while (cursor?.parentElement) {
        value += 1;
        cursor = cursor.parentElement;
      }
      return value;
    }

    return [...document.querySelectorAll('*')]
      .filter(el => isVisible(el))
      .map(el => ({
        tag: String(el.tagName || '').toLowerCase(),
        text: normalize(el.textContent || ''),
        className: typeof el.className === 'string' ? el.className : '',
        id: el.id || '',
        role: el.getAttribute('role') || '',
        href: el.getAttribute('href') || '',
        onclick: el.getAttribute('onclick') || '',
        cursor: window.getComputedStyle(el).cursor,
        depth: depth(el),
      }))
      .filter(item => item.text.length > 0 && item.text.length <= 160)
      .filter(item => words.some(word => item.text.includes(word)))
      .sort((a, b) => (a.text.length - b.text.length) || (b.depth - a.depth))
      .slice(0, 20);
  }, { words: DOWNLOAD_WORDS }).catch(() => []);
}

async function clickTextButton(context, page, words) {
  const clickableSelector = [
    'a',
    'button',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const word of words) {
    const locator = page.locator(clickableSelector).filter({ hasText: word });
    const count = Math.min(await locator.count().catch(() => 0), 10);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;

      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await target.click({ timeout: 8000 }).catch(() => null);
      const popup = await popupPromise;
      const actionPage = popup || page;
      await actionPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
      await actionPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
      await sleep(1200);
      return { page: actionPage, openedPopup: Boolean(popup), clickedText: word };
    }
  }

  const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  const fallback = await fallbackDomClick(page, words);
  if (!fallback.clicked) {
    return null;
  }

  const popup = await popupPromise;
  const actionPage = popup || page;
  await actionPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
  await actionPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
  await sleep(1200);
  return {
    page: actionPage,
    openedPopup: Boolean(popup),
    clickedText: fallback.text || words[0],
    clickMode: fallback.mode,
  };
}

async function tryDownloadSignals(context, page, trigger) {
  const beforeUrl = page.url();
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  const clickMeta = await trigger();
  const download = await downloadPromise;
  const popup = await popupPromise;
  return {
    clickMeta,
    download,
    popup,
    navigated: page.url() !== beforeUrl,
  };
}

async function clickDownloadTrigger(context, page) {
  const clickableSelector = [
    'a',
    'button',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const word of DOWNLOAD_WORDS) {
    const locator = page.locator(clickableSelector).filter({ hasText: word });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;

      const result = await tryDownloadSignals(context, page, async () => {
        await target.click({ timeout: 8000 }).catch(() => null);
        return { clicked: true, mode: 'locator', clickedText: word };
      });
      if (result.clickMeta?.clicked && (result.download || result.popup || result.navigated)) {
        return result;
      }
    }
  }

  const result = await tryDownloadSignals(context, page, async () => {
    return fallbackDomClick(page, DOWNLOAD_WORDS);
  });
  if (result.clickMeta?.clicked && (result.download || result.popup || result.navigated)) {
    return result;
  }
  return result.clickMeta?.clicked
    ? result
    : { clickMeta: { clicked: false }, download: null, popup: null, navigated: false };
}

async function closeModal(page) {
  const closeTargets = ['取消', '关闭'];
  for (const text of closeTargets) {
    const locator = page.locator('button, a, [role="button"], div[class*="button"], span[class*="button"], div[class*="btn"], span[class*="btn"]').filter({ hasText: text });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click({ timeout: 5000 }).catch(() => null);
      await sleep(500);
      return true;
    }
  }
  await page.keyboard.press('Escape').catch(() => null);
  await sleep(500);
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
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
    await sleep(1200);
    return true;
  }

  return false;
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
      await sleep(300);
      return true;
    }
  }
  return false;
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
        text: normalize(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 40);

    for (const labelText of labelTexts) {
      const normalized = normalize(labelText);
      const labels = labelNodes.filter(item => item.text === normalized || item.text.startsWith(normalized));
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
      const labels = labelNodes.filter(item => item.text === normalized || item.text.startsWith(normalized));
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

async function readValueByPosition(page, fieldName) {
  const index = FIELD_POSITION[fieldName];
  if (index === undefined) return { fieldName, found: false, value: '' };

  return page.evaluate(({ index, fieldName }) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const controls = [...document.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea')]
      .filter(el => isVisible(el) && !el.disabled && (el.name || '') !== 'q');
    const target = controls[index];
    return target
      ? { fieldName, found: true, value: target.value || '', source: 'position', index }
      : { fieldName, found: false, value: '', source: 'position', index };
  }, { index, fieldName }).catch(() => ({ fieldName, found: false, value: '' }));
}

async function fillByPosition(page, fieldName, value) {
  const index = FIELD_POSITION[fieldName];
  if (index === undefined || !value) return { fieldName, filled: false, reason: 'invalid_position' };

  return page.evaluate(({ index, fieldName, value }) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function setInputValue(el, nextValue) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, nextValue);
      else el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    const controls = [...document.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea')]
      .filter(el => isVisible(el) && !el.disabled && (el.name || '') !== 'q');
    const target = controls[index];
    if (!target) return { fieldName, filled: false, reason: 'position_not_found', index };
    const beforeValue = target.value || '';
    setInputValue(target, value);
    return { fieldName, filled: true, source: 'position', index, beforeValue, afterValue: target.value || '' };
  }, { index, fieldName, value }).catch(() => ({ fieldName, filled: false, reason: 'position_error' }));
}

async function clearByExactRowLabel(page, labelTexts, fieldName) {
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
        text: normalize(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 40);

    for (const labelText of labelTexts) {
      const normalized = normalize(labelText);
      const labels = labelNodes.filter(item => item.text === normalized || item.text.startsWith(normalized));
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
        setInputValue(target, '');
        return { fieldName, cleared: true, label: labelText };
      }
    }

    return { fieldName, cleared: false };
  }, { labelTexts, fieldName }).catch(() => ({ fieldName, cleared: false }));
}

async function clearByPosition(page, fieldName) {
  const index = FIELD_POSITION[fieldName];
  if (index === undefined) return { fieldName, cleared: false };

  return page.evaluate(({ index, fieldName }) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function setInputValue(el, nextValue) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, nextValue);
      else el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    const controls = [...document.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea')]
      .filter(el => isVisible(el) && !el.disabled && (el.name || '') !== 'q');
    const target = controls[index];
    if (!target) return { fieldName, cleared: false };
    setInputValue(target, '');
    return { fieldName, cleared: true, source: 'position', index };
  }, { index, fieldName }).catch(() => ({ fieldName, cleared: false }));
}

async function selectSavedInvoiceProfile(page, companyName) {
  if (!companyName) return { selected: false, reason: 'empty_company_name' };

  const opened = await page.evaluate(() => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const controls = [...document.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea')]
      .filter(el => isVisible(el) && !el.disabled && (el.name || '') !== 'q');
    const target = controls[0];
    if (!target) return false;

    const container = target.parentElement || target;
    const clearButton = container.querySelector('i, svg, span, div');
    if (clearButton && clearButton !== target) {
      clearButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    target.focus();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(target, '');
    else target.value = '';
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }).catch(() => false);

  if (!opened) return { selected: false, reason: 'company_profile_open_failed' };
  await sleep(600);

  const selected = await page.evaluate(({ companyName }) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function depth(el) {
      let d = 0;
      let cursor = el;
      while (cursor?.parentElement) {
        d += 1;
        cursor = cursor.parentElement;
      }
      return d;
    }

    const candidates = [...document.querySelectorAll('li, [role="option"], div, span')]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        depth: depth(el),
      }))
      .filter(item => item.text.includes(companyName) && item.text.length >= companyName.length && item.text.length <= 120)
      .sort((a, b) => (a.text.length - b.text.length) || (b.depth - a.depth));

    const target = candidates[0];
    if (!target) return { selected: false };
    target.el.click();
    return { selected: true, text: target.text };
  }, { companyName }).catch(() => ({ selected: false }));

  if (!selected.selected) {
    return { selected: false, reason: 'company_profile_option_not_found' };
  }
  await sleep(800);
  return selected;
}

async function inspectFormShipping(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalize(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
    }

    const labels = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        text: (el.textContent || '').replace(/\s+/g, ''),
        rect: el.getBoundingClientRect(),
      }));
    const targetLabel = labels.find(item => item.text.includes('收货地址'));
    if (!targetLabel) return { found: false, value: '' };

    const candidates = [...document.querySelectorAll('input, textarea, div, span')]
      .filter(el => isVisible(el))
      .map(el => ({
        text: normalize(el.textContent || el.getAttribute('value') || el.getAttribute('placeholder') || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item =>
        item.rect.left >= targetLabel.rect.right - 12
        && Math.abs((item.rect.top + item.rect.bottom) / 2 - (targetLabel.rect.top + targetLabel.rect.bottom) / 2) <= 40
        && item.rect.width > 120
      )
      .sort((a, b) => (b.rect.width - a.rect.width) || (Math.abs(a.rect.top - targetLabel.rect.top) - Math.abs(b.rect.top - targetLabel.rect.top)));

    const picked = candidates.find(item => item.text && item.text !== '请选择');
    return picked ? { found: true, value: picked.text } : { found: false, value: '' };
  }).catch(() => ({ found: false, value: '' }));
}

async function selectShippingAddress(page) {
  const directSelection = await page.evaluate(({ normalizedNeedles }) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function depth(el) {
      let d = 0;
      let cursor = el;
      while (cursor?.parentElement) {
        d += 1;
        cursor = cursor.parentElement;
      }
      return d;
    }

    const candidates = [...document.querySelectorAll('li, [role="option"], label, button, div, span, p')]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        tight: (el.textContent || '').replace(/\s+/g, ''),
        depth: depth(el),
      }))
      .filter(item => item.text.length >= 18 && item.text.length <= 120)
      .filter(item => !item.text.includes('保存取消') && !item.text.includes('全部功能') && !item.text.includes('我的购物车'));

    const target = candidates
      .filter(item => normalizedNeedles.every(needle => item.tight.includes(needle)))
      .sort((a, b) => (a.text.length - b.text.length) || (b.depth - a.depth))[0];
    if (!target) return { selected: false };
    target.el.click();
    return { selected: true, text: target.text };
  }, { normalizedNeedles: REQUIRED_SHIPPING_NORMALIZED }).catch(() => ({ selected: false }));

  if (directSelection.selected) {
    await sleep(800);
    return { selected: true, text: directSelection.text, mode: 'direct_visible_option' };
  }

  const opened = await page.evaluate(() => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const labels = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        text: (el.textContent || '').replace(/\s+/g, ''),
        rect: el.getBoundingClientRect(),
      }));
    const targetLabel = labels.find(item => item.text.includes('收货地址'));
    if (!targetLabel) return false;

    const candidates = [...document.querySelectorAll('input, textarea, div, span')]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: (el.textContent || el.getAttribute('value') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim(),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item =>
        item.rect.left >= targetLabel.rect.right - 12
        && Math.abs((item.rect.top + item.rect.bottom) / 2 - (targetLabel.rect.top + targetLabel.rect.bottom) / 2) <= 40
        && item.rect.width > 120
      )
      .sort((a, b) => (b.rect.width - a.rect.width) || (Math.abs(a.rect.top - targetLabel.rect.top) - Math.abs(b.rect.top - targetLabel.rect.top)));

    const target = candidates[0]?.el;
    if (!target) return false;
    target.click();
    return true;
  }).catch(() => false);

  if (opened) {
    await sleep(800);
  }

  const dropdownSelection = await page.evaluate(({ normalizedNeedles }) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function depth(el) {
      let d = 0;
      let cursor = el;
      while (cursor?.parentElement) {
        d += 1;
        cursor = cursor.parentElement;
      }
      return d;
    }

    const candidates = [...document.querySelectorAll('li, [role="option"], label, button, div, span, p')]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        tight: (el.textContent || '').replace(/\s+/g, ''),
        depth: depth(el),
      }))
      .filter(item => item.text.length >= 18 && item.text.length <= 120)
      .filter(item => !item.text.includes('保存取消') && !item.text.includes('全部功能') && !item.text.includes('我的购物车'))
      .filter(item => normalizedNeedles.every(needle => item.tight.includes(needle)))
      .sort((a, b) => (a.text.length - b.text.length) || (b.depth - a.depth));

    const target = candidates[0];
    if (!target) return { selected: false };
    target.el.click();
    return { selected: true, text: target.text };
  }, { normalizedNeedles: REQUIRED_SHIPPING_NORMALIZED }).catch(() => ({ selected: false }));

  if (dropdownSelection.selected) {
    await sleep(800);
    return { selected: true, text: dropdownSelection.text, opened, mode: 'dropdown_option' };
  }

  return {
    selected: false,
    reason: opened ? 'shipping_option_not_found' : 'shipping_dropdown_not_opened',
    requiredNeedles: REQUIRED_SHIPPING_NEEDLES,
  };
}

async function inspectFormValues(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

  let companyValue = await readValueByExactRowLabel(page, ['发票抬头'], 'companyName');
  if (!companyValue.found) companyValue = await readValueByPosition(page, 'companyName');

  let taxValue = await readValueByExactRowLabel(page, ['税号', '纳税人识别号', '统一社会信用代码'], 'taxNo');
  if (!taxValue.found) taxValue = await readValueByPosition(page, 'taxNo');

  let addressValue = await readValueByExactRowLabel(page, ['企业地址', '单位地址', '注册地址', '地址'], 'address');
  if (!addressValue.found) addressValue = await readValueByPosition(page, 'address');

  let phoneValue = await readValueByExactRowLabel(page, ['企业电话', '单位电话', '电话', '手机号'], 'phone');
  if (!phoneValue.found) phoneValue = await readValueByPosition(page, 'phone');

  let bankNameValue = await readValueByExactRowLabel(page, ['开户银行', '开户行'], 'bankName');
  if (!bankNameValue.found) bankNameValue = await readValueByPosition(page, 'bankName');

  let bankAccountValue = await readValueByExactRowLabel(page, ['银行账号', '银行账户', '开户行账号'], 'bankAccount');
  if (!bankAccountValue.found) bankAccountValue = await readValueByPosition(page, 'bankAccount');

  const emailValue = await readValueByExactRowLabel(page, ['邮箱', '电子邮箱'], 'email');
  const shippingAddressValue = await inspectFormShipping(page);

  return {
    bodyText,
    companyValue,
    taxValue,
    addressValue,
    phoneValue,
    bankNameValue,
    bankAccountValue,
    emailValue,
    shippingAddressValue,
  };
}

function needsRepair(currentValues, invoiceConfig, history = {}) {
  const isPaperInvoice = currentValues.bodyText?.includes('普通发票-纸质') || currentValues.bodyText?.includes('收货地址');
  const companyWrong = !currentValues.companyValue.found || currentValues.companyValue.value !== invoiceConfig.companyName;
  const taxWrong = !currentValues.taxValue.found || currentValues.taxValue.value !== invoiceConfig.taxNo;
  const addressShouldBeCleared = Boolean(currentValues.addressValue?.found && String(currentValues.addressValue.value || '').trim());
  const phoneWrong = Boolean(invoiceConfig.phone && currentValues.phoneValue?.found && currentValues.phoneValue.value !== invoiceConfig.phone);
  const bankNameWrong = Boolean(invoiceConfig.bankName && currentValues.bankNameValue?.found && currentValues.bankNameValue.value !== invoiceConfig.bankName);
  const bankAccountWrong = Boolean(invoiceConfig.bankAccount && currentValues.bankAccountValue?.found && currentValues.bankAccountValue.value !== invoiceConfig.bankAccount);
  const emailRequested = Boolean(invoiceConfig.email) && (
    Boolean(history.hasEmailReason) || requiresEmailReason(currentValues.bodyText)
  );
  const emailWrong = emailRequested && (
    !currentValues.emailValue?.found
    || currentValues.emailValue.value !== invoiceConfig.email
  );
  const shippingWrong = isPaperInvoice && (
    !currentValues.shippingAddressValue?.found
    || !shippingTextMatches(currentValues.shippingAddressValue.value)
  );
  const needsResubmit = Boolean(history.hasWrongTitleReason || history.hasRejectedWrongTitle);

  return {
    repair: companyWrong || taxWrong || addressShouldBeCleared || phoneWrong || bankNameWrong || bankAccountWrong || emailWrong || shippingWrong || needsResubmit,
    isPaperInvoice,
    companyWrong,
    taxWrong,
    addressShouldBeCleared,
    phoneWrong,
    bankNameWrong,
    bankAccountWrong,
    emailRequested,
    emailWrong,
    shippingWrong,
    needsResubmit,
  };
}

async function fillCorrectValues(page, invoiceConfig, history = {}) {
  await clickRadioOrOption(page, ['企业', '单位', '公司']);
  const filledFields = [];
  const formText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

  const profileSelection = await selectSavedInvoiceProfile(page, invoiceConfig.companyName);

  let companyField = await fillByExactRowLabel(page, ['发票抬头'], invoiceConfig.companyName, 'companyName');
  if (!companyField.filled) companyField = await fillByPosition(page, 'companyName', invoiceConfig.companyName);
  filledFields.push(companyField);

  let taxField = await fillByExactRowLabel(page, ['税号', '纳税人识别号', '统一社会信用代码'], invoiceConfig.taxNo, 'taxNo');
  if (!taxField.filled) taxField = await fillByPosition(page, 'taxNo', invoiceConfig.taxNo);
  filledFields.push(taxField);

  await clickRadioOrOption(page, ['展开非必填信息', '更多信息', '展开']);

  const shouldFillEmail = Boolean(invoiceConfig.email) && (
    Boolean(history.hasEmailReason) || requiresEmailReason(formText)
  );

  if (shouldFillEmail) {
    const emailField = await fillByExactRowLabel(page, ['邮箱', '电子邮箱'], invoiceConfig.email, 'email');
    filledFields.push(emailField);
  }

  if (invoiceConfig.phone) {
    let phoneField = await fillByExactRowLabel(page, ['企业电话', '单位电话', '电话', '手机号'], invoiceConfig.phone, 'phone');
    if (!phoneField.filled) phoneField = await fillByPosition(page, 'phone', invoiceConfig.phone);
    filledFields.push(phoneField);
  }

  if (invoiceConfig.bankName) {
    let bankNameField = await fillByExactRowLabel(page, ['开户银行', '开户行'], invoiceConfig.bankName, 'bankName');
    if (!bankNameField.filled) bankNameField = await fillByPosition(page, 'bankName', invoiceConfig.bankName);
    filledFields.push(bankNameField);
  }

  if (invoiceConfig.bankAccount) {
    let bankAccountField = await fillByExactRowLabel(page, ['银行账号', '银行账户', '开户行账号'], invoiceConfig.bankAccount, 'bankAccount');
    if (!bankAccountField.filled) bankAccountField = await fillByPosition(page, 'bankAccount', invoiceConfig.bankAccount);
    filledFields.push(bankAccountField);
  }

  let clearedAddress = await clearByExactRowLabel(page, ['企业地址', '单位地址', '注册地址', '地址'], 'address');
  if (!clearedAddress.cleared) clearedAddress = await clearByPosition(page, 'address');

  let shippingSelection = { selected: false, reason: 'not_required' };
  const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  if (pageText.includes('普通发票-纸质') || pageText.includes('收货地址')) {
    shippingSelection = await selectShippingAddress(page);
  }

  const validation = await inspectFormValues(page);
  return { profileSelection, filledFields, clearedAddress, shippingSelection, validation };
}

async function clickSubmit(page) {
  const submitWords = ['确定', '提交申请', '提交', '确认提交', '保存', '确认换开', '提交开票', '申请开票'];
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
      const text = normalizeSpace(await target.textContent().catch(() => ''));
      if (dangerWords.some(danger => text.includes(danger))) continue;
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;
      await target.click({ timeout: 8000 }).catch(() => null);
      await sleep(1500);
      return { submitted: true, text: word };
    }
  }
  return { submitted: false };
}

function classifyDetailStatus(bodyText) {
  const text = String(bodyText || '');

  if (REISSUE_WORDS.some(word => text.includes(word))) {
    return 'reissuable_now';
  }
  if (DOWNLOAD_WORDS.some(word => text.includes(word))) {
    return 'downloadable_now';
  }
  if (REJECTED_WORDS.some(word => text.includes(word))) {
    return 'rejected';
  }
  if (PROCESSING_WORDS.some(word => text.includes(word))) {
    return 'processing';
  }
  if (APPLY_WORDS.some(word => text.includes(word)) || text.includes('未开票') || text.includes('暂未开票')) {
    return 'apply_available';
  }
  if (text.includes('开票成功') || text.includes('申请成功') || text.includes('提交成功')) {
    return 'submitted';
  }
  if (text.includes('发票') || text.includes('开票')) {
    return 'unknown';
  }
  return 'no_invoice_entry';
}

async function inspectDetail(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const currentShipping = extractShippingSnippet(bodyText);

  return {
    bodyText,
    currentStatus: classifyDetailStatus(bodyText),
    hasModifyEntry: MODIFY_WORDS.some(word => bodyText.includes(word)),
    hasHistoryEntry: HISTORY_WORDS.some(word => bodyText.includes(word)),
    hasApplyEntry: APPLY_WORDS.some(word => bodyText.includes(word)),
    hasReissueEntry: REISSUE_WORDS.some(word => bodyText.includes(word)),
    hasDownloadEntry: DOWNLOAD_WORDS.some(word => bodyText.includes(word)),
    isPaper: bodyText.includes('普通发票-纸质') || bodyText.includes('收货地址') || bodyText.includes('收票地址'),
    currentShipping,
    shippingCorrect: shippingTextMatches(currentShipping),
  };
}

async function inspectHistory(context, page) {
  const originalUrl = page.url();
  const historyResult = await clickTextButton(context, page, HISTORY_WORDS);
  if (!historyResult) {
    return {
      attempted: false,
      opened: false,
      historyText: '',
      hasWrongTitleReason: false,
      hasExpiredReason: false,
      hasRejectedWrongTitle: false,
    };
  }

  const historyPage = historyResult.page;
  const historyText = await historyPage.evaluate(() => document.body.innerText || '').catch(() => '');
  const result = {
    attempted: true,
    opened: true,
    historyUrl: historyPage.url(),
    historyText,
    hasWrongTitleReason: historyText.includes('买家抬头信息输入有误'),
    hasExpiredReason: historyText.includes('订单超过可开票期限') || historyText.includes('超过开票日期'),
    hasRejectedWrongTitle: historyText.includes('买家抬头信息输入有误'),
    hasEmailReason: requiresEmailReason(historyText),
  };

  if (historyResult.openedPopup) {
    await closePageQuietly(historyPage);
  } else if (historyPage === page && page.url() !== originalUrl) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
    await sleep(800);
  }

  return result;
}

async function detectExistingApplication(page, invoiceConfig) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const pending = ['申请中', '商家正在处理', '已提交', '处理中'].some(word => bodyText.includes(word));
  const success = ['已开票', '申请成功', '提交成功', '开票成功', '换开成功'].some(word => bodyText.includes(word));
  const hasCompany = invoiceConfig.companyName && bodyText.includes(invoiceConfig.companyName);
  const hasTaxNo = invoiceConfig.taxNo && bodyText.includes(invoiceConfig.taxNo);

  if (pending || success) {
    return {
      exists: true,
      status: success ? 'submitted' : 'processing',
      hasCompany,
      hasTaxNo,
      reason: success ? '页面显示已提交/成功' : '页面显示申请中/处理中',
      bodyText,
    };
  }

  return { exists: false, status: '', bodyText };
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
    '订单超过可开票期限',
  ];
  const hit = keywords.find(word => bodyText.includes(word));
  return hit
    ? { exceeded: true, keyword: hit, reason: `页面提示${hit}` }
    : { exceeded: false };
}

async function downloadInvoice(context, page, order) {
  ensureDir(DOWNLOAD_DIR);

  const triggerDownload = async () => {
    const clickResult = await clickDownloadTrigger(context, page);
    const clicked = Boolean(clickResult.clickMeta?.clicked);
    const mode = clickResult.clickMeta?.mode || '';
    if (!clicked) {
      return {
        status: 'blocked',
        reason: '未找到可点击下载入口',
        debugTargets: await collectDownloadTargets(page),
      };
    }

    const download = clickResult.download;
    const popup = clickResult.popup;
    try {
      if (!download && popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
        await popup.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
        const popupText = await popup.evaluate(() => document.body.innerText || '').catch(() => '');
        if (DOWNLOAD_WORDS.some(item => popupText.includes(item))) {
          return await downloadInvoice(context, popup, order);
        }
      }

      if (!download) {
        return {
          status: 'blocked',
          reason: '点击下载后未捕获到浏览器下载事件',
          mode,
          openedPopup: Boolean(popup),
          debugTargets: await collectDownloadTargets(page),
        };
      }

      const suggested = download.suggestedFilename();
      const ext = path.extname(suggested) || '.pdf';
      const base = sanitizeFilenamePart(`${order.orderDate || 'unknown_date'}_${order.bizOrderId}_${suggested.replace(ext, '')}`);
      const targetPath = path.join(DOWNLOAD_DIR, `${base}${ext}`);
      await download.saveAs(targetPath);
      return {
        status: 'downloaded',
        filename: path.basename(targetPath),
        path: targetPath,
        mode,
      };
    } finally {
      await closePageQuietly(popup);
    }
  };

  return triggerDownload();
}

async function repairModifyFlow(context, page, order, invoiceConfig, detail, history) {
  const editResult = await clickTextButton(context, page, MODIFY_WORDS);
  if (!editResult) {
    return { status: 'no_modify_entry', reason: '未找到修改申请入口', detail, history };
  }

  const actionPage = editResult.page;
  const originalIsSamePage = actionPage === page && !editResult.openedPopup;

  try {
    await confirmModifyIfNeeded(actionPage);
    const currentValues = await inspectFormValues(actionPage);
    const decision = needsRepair(currentValues, invoiceConfig, history);
    const deadlineExceeded = await detectInvoiceDeadlineExceeded(actionPage);

    if (deadlineExceeded.exceeded && detail.currentStatus === 'rejected') {
      if (originalIsSamePage) {
        await closeModal(actionPage);
      }
      return {
        status: 'expired_deadline',
        reason: deadlineExceeded.reason,
        detail,
        history,
        currentValues,
        decision,
        deadlineExceeded,
      };
    }

    if (!decision.repair) {
      if (originalIsSamePage) {
        await closeModal(actionPage);
      }
      return {
        status: 'already_correct',
        reason: '修改申请页校验通过',
        detail,
        history,
        currentValues,
        decision,
      };
    }

    const fillResult = await fillCorrectValues(actionPage, invoiceConfig, history);
    const postDecision = needsRepair(fillResult.validation, invoiceConfig, history);

    const stillWrongExceptShipping = postDecision.companyWrong
      || postDecision.taxWrong
      || postDecision.addressShouldBeCleared
      || postDecision.phoneWrong
      || postDecision.bankNameWrong
      || postDecision.bankAccountWrong
      || postDecision.emailWrong;
    const shippingSelectionLooksGood = Boolean(fillResult.shippingSelection?.selected && shippingTextMatches(fillResult.shippingSelection.text || ''));

    if (stillWrongExceptShipping || (postDecision.shippingWrong && !shippingSelectionLooksGood)) {
      if (originalIsSamePage) {
        await closeModal(actionPage);
      }
      return {
        status: 'blocked',
        reason: '修正后回读校验仍不匹配',
        detail,
        history,
        currentValues,
        decision,
        fillResult,
        postDecision,
      };
    }

    const submitResult = await clickSubmit(actionPage);
    const afterText = await actionPage.evaluate(() => document.body.innerText || '').catch(() => '');
    let verification = null;
    let finalStatus = submitResult.submitted ? 'repaired' : 'blocked';
    let finalReason = submitResult.submitted ? '已提交修改申请' : '未找到确定/提交按钮';

    if (submitResult.submitted) {
      await page.goto(order.invoiceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
      await sleep(1200);
      const verifyDetail = await inspectDetail(page);
      const verifyHistory = verifyDetail.hasHistoryEntry ? await inspectHistory(context, page) : null;
      const titleVerified = verifyDetail.bodyText.includes(invoiceConfig.companyName) && verifyDetail.bodyText.includes(invoiceConfig.taxNo);
      const paperVerified = !decision.isPaperInvoice
        || verifyDetail.shippingCorrect
        || shippingTextMatches(verifyHistory?.historyText || '');

      verification = {
        detail: verifyDetail,
        history: verifyHistory,
        titleVerified,
        paperVerified,
      };

      if (!titleVerified || !paperVerified) {
        finalStatus = 'blocked';
        finalReason = '提交后复核仍未确认到正确抬头/地址';
      }
    }

    return {
      status: finalStatus,
      reason: finalReason,
      detail,
      history,
      currentValues,
      decision,
      fillResult,
      postDecision,
      submitResult,
      successHint: SUCCESS_HINTS.find(word => afterText.includes(word)) || '',
      verification,
    };
  } finally {
    if (editResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function submitDirectAction(context, page, order, invoiceConfig, words, actionLabel, history = {}) {
  const clickResult = await clickTextButton(context, page, words);
  if (!clickResult) {
    return { status: 'blocked', reason: `未找到${actionLabel}入口` };
  }

  const actionPage = clickResult.page;
  try {
    const existingApplication = await detectExistingApplication(actionPage, invoiceConfig);
    if (existingApplication.exists) {
      return {
        status: existingApplication.status,
        reason: existingApplication.reason,
        existingApplication,
        clickedText: clickResult.clickedText,
      };
    }

    const deadlineExceeded = await detectInvoiceDeadlineExceeded(actionPage);
    if (deadlineExceeded.exceeded) {
      return {
        status: 'expired_deadline',
        reason: deadlineExceeded.reason,
        deadlineExceeded,
        clickedText: clickResult.clickedText,
      };
    }

    const bodyText = await actionPage.evaluate(() => document.body.innerText || '').catch(() => '');
    if (DOWNLOAD_WORDS.some(word => bodyText.includes(word))) {
      const downloadResult = await downloadInvoice(context, actionPage, order);
      return {
        status: downloadResult.status,
        reason: downloadResult.reason || '已直接下载现有发票',
        clickedText: clickResult.clickedText,
        downloadResult,
      };
    }

    const fillResult = await fillCorrectValues(actionPage, invoiceConfig, history);
    const postDecision = needsRepair(fillResult.validation, invoiceConfig, history);
    if (postDecision.companyWrong || postDecision.taxWrong || postDecision.addressShouldBeCleared || postDecision.phoneWrong || postDecision.bankNameWrong || postDecision.bankAccountWrong || postDecision.emailWrong || postDecision.shippingWrong) {
      return {
        status: 'blocked',
        reason: `${actionLabel}表单修正后回读仍不匹配`,
        clickedText: clickResult.clickedText,
        fillResult,
        postDecision,
      };
    }

    const submitResult = await clickSubmit(actionPage);
    const afterText = await actionPage.evaluate(() => document.body.innerText || '').catch(() => '');
    return {
      status: submitResult.submitted ? 'submitted' : 'blocked',
      reason: submitResult.submitted ? `已提交${actionLabel}` : `未找到${actionLabel}的确定/提交按钮`,
      clickedText: clickResult.clickedText,
      fillResult,
      postDecision,
      submitResult,
      successHint: SUCCESS_HINTS.find(word => afterText.includes(word)) || '',
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function auditOneOrder(context, page, order, invoiceConfig) {
  await page.goto(order.invoiceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
  await sleep(1200);
  await waitForInvoiceContent(page).catch(() => null);

  const finalUrl = page.url();
  if (hasLoginUrl(finalUrl)) {
    return {
      ...order,
      status: 'login_required',
      reason: '跳转到登录页，cookies 失效',
      finalUrl,
    };
  }

  const detail = await inspectDetail(page);
  const history = detail.hasHistoryEntry ? await inspectHistory(context, page) : {
    attempted: false,
    opened: false,
      historyText: '',
      hasWrongTitleReason: false,
      hasExpiredReason: false,
      hasRejectedWrongTitle: false,
      hasEmailReason: false,
    };
  const existingDownload = findExistingDownload(order.bizOrderId);

  const baseResult = {
    ...order,
    finalUrl,
    detail,
    history,
    existingDownload,
    checkedAt: new Date().toISOString(),
  };

  if (detail.hasModifyEntry) {
    const modifyResult = await repairModifyFlow(context, page, order, invoiceConfig, detail, history);
    const merged = { ...baseResult, ...modifyResult };

    if (modifyResult.status === 'no_modify_entry' && existingDownload) {
      return {
        ...merged,
        status: 'already_downloaded',
        reason: '修改入口不可用，但本地已存在下载文件',
      };
    }

    if (modifyResult.status === 'no_modify_entry' && detail.hasDownloadEntry && !existingDownload) {
      const downloadResult = await downloadInvoice(context, page, order);
      return {
        ...merged,
        followupDownload: downloadResult,
        status: downloadResult.status,
        reason: downloadResult.reason || '修改入口不可用，已转下载分支',
      };
    }

    if (modifyResult.status === 'already_correct' && detail.hasDownloadEntry && !existingDownload && !detail.hasReissueEntry) {
      const downloadResult = await downloadInvoice(context, page, order);
      return {
        ...merged,
        followupDownload: downloadResult,
        status: downloadResult.status === 'downloaded' ? 'downloaded' : merged.status,
        reason: downloadResult.status === 'downloaded' ? '表单正确，补下发票成功' : merged.reason,
      };
    }

    if (modifyResult.status === 'already_correct' && existingDownload) {
      return {
        ...merged,
        status: 'already_downloaded',
        reason: '表单正确且本地已存在下载文件',
      };
    }

    return merged;
  }

  if (detail.hasReissueEntry) {
    const reissueResult = await submitDirectAction(context, page, order, invoiceConfig, REISSUE_WORDS, '换开申请', history);
    const merged = { ...baseResult, actionResult: reissueResult, status: reissueResult.status, reason: reissueResult.reason };
    if (reissueResult.status === 'expired_deadline' && detail.hasDownloadEntry && !existingDownload) {
      const downloadResult = await downloadInvoice(context, page, order);
      return {
        ...merged,
        fallbackDownload: downloadResult,
        status: downloadResult.status === 'downloaded' ? 'downloaded' : merged.status,
        reason: downloadResult.status === 'downloaded' ? '换开超期，已补下载个人票' : merged.reason,
      };
    }
    return merged;
  }

  if (detail.hasApplyEntry) {
    const applyResult = await submitDirectAction(context, page, order, invoiceConfig, APPLY_WORDS, '开票申请', history);
    return { ...baseResult, actionResult: applyResult, status: applyResult.status, reason: applyResult.reason };
  }

  if (detail.hasDownloadEntry) {
    if (existingDownload) {
      return { ...baseResult, status: 'already_downloaded', reason: '本地已存在下载文件' };
    }
    const downloadResult = await downloadInvoice(context, page, order);
    return { ...baseResult, downloadResult, status: downloadResult.status, reason: downloadResult.reason || '已下载发票' };
  }

  if (detail.currentStatus === 'processing') {
    return { ...baseResult, status: 'processing', reason: '当前仍在申请中/处理中' };
  }

  if (detail.currentStatus === 'rejected') {
    return {
      ...baseResult,
      status: history.hasWrongTitleReason ? 'rejected_pending_manual' : 'blocked',
      reason: history.hasWrongTitleReason ? '已识别为抬头错误拒绝，但当前页无可修入口' : '当前为商家拒绝，未发现可自动修复入口',
    };
  }

  if (existingDownload) {
    return { ...baseResult, status: 'already_downloaded', reason: '当前无动作入口，但本地已有下载文件' };
  }

  return { ...baseResult, status: detail.currentStatus, reason: `当前状态：${detail.currentStatus}` };
}

function buildSummary(results) {
  const summary = {
    totalChecked: results.length,
    repaired: 0,
    submitted: 0,
    downloaded: 0,
    alreadyCorrect: 0,
    alreadyDownloaded: 0,
    processing: 0,
    expiredDeadline: 0,
    blocked: 0,
    rejectedPendingManual: 0,
    noModifyEntry: 0,
    noInvoiceEntry: 0,
    unknown: 0,
    errors: 0,
    loginRequired: 0,
    paperInvoices: 0,
    paperCorrectNow: 0,
    paperRepaired: 0,
    wrongTitleHistoryDetected: 0,
    existingDownloads: 0,
  };

  for (const result of results) {
    if (result.status === 'repaired') summary.repaired++;
    else if (result.status === 'submitted') summary.submitted++;
    else if (result.status === 'downloaded') summary.downloaded++;
    else if (result.status === 'already_correct') summary.alreadyCorrect++;
    else if (result.status === 'already_downloaded') summary.alreadyDownloaded++;
    else if (result.status === 'processing') summary.processing++;
    else if (result.status === 'expired_deadline') summary.expiredDeadline++;
    else if (result.status === 'blocked') summary.blocked++;
    else if (result.status === 'rejected_pending_manual') summary.rejectedPendingManual++;
    else if (result.status === 'no_modify_entry') summary.noModifyEntry++;
    else if (result.status === 'no_invoice_entry') summary.noInvoiceEntry++;
    else if (result.status === 'unknown') summary.unknown++;
    else if (result.status === 'error') summary.errors++;
    else if (result.status === 'login_required') summary.loginRequired++;

    const paperDetected = Boolean(
      result.detail?.isPaper
      || result.currentValues?.bodyText?.includes('普通发票-纸质')
      || result.fillResult?.validation?.bodyText?.includes('普通发票-纸质')
    );
    if (paperDetected) summary.paperInvoices++;

    const shippingCorrect = Boolean(
      result.detail?.shippingCorrect
      || (result.currentValues?.shippingAddressValue?.value && shippingTextMatches(result.currentValues.shippingAddressValue.value))
      || (result.fillResult?.validation?.shippingAddressValue?.value && shippingTextMatches(result.fillResult.validation.shippingAddressValue.value))
    );
    if (paperDetected && shippingCorrect) summary.paperCorrectNow++;
    if (paperDetected && result.status === 'repaired') summary.paperRepaired++;

    if (result.history?.hasWrongTitleReason) summary.wrongTitleHistoryDetected++;
    if (result.existingDownload) summary.existingDownloads++;
  }

  return summary;
}

async function main() {
  const cookies = loadJson(COOKIES_FILE);
  const invoiceConfig = loadJson(CONFIG_FILE);
  configureRequiredShippingNeedles(invoiceConfig);
  const orders = pickOrders();
  const resultsById = loadProgressMap();

  const browser = await chromium.launch({ headless: !hasFlag('headful') });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await closeAuxiliaryPages(context, page);

  try {
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      if (!hasFlag('fresh') && resultsById[order.bizOrderId] && isFinalStatus(resultsById[order.bizOrderId].status)) {
        console.log(`[${i + 1}/${orders.length}] ${order.bizOrderId} -> skip | ${resultsById[order.bizOrderId].status}`);
        continue;
      }

      try {
        const result = await auditOneOrder(context, page, order, invoiceConfig);
        resultsById[order.bizOrderId] = result;
        console.log(`[${i + 1}/${orders.length}] ${order.bizOrderId} -> ${result.status} | ${result.reason || ''}`);
        if (result.status === 'login_required') {
          break;
        }
      } catch (error) {
        resultsById[order.bizOrderId] = {
          ...order,
          status: 'error',
          reason: error.message,
          checkedAt: new Date().toISOString(),
        };
        console.log(`[${i + 1}/${orders.length}] ${order.bizOrderId} -> error | ${error.message}`);
      } finally {
        await closeAuxiliaryPages(context, page);
      }

      const partialResults = orders
        .map(item => resultsById[item.bizOrderId])
        .filter(Boolean);
      saveJson(PROGRESS_FILE, {
        generatedAt: new Date().toISOString(),
        outputFile: OUTPUT_FILE,
        totalOrders: orders.length,
        completed: partialResults.length,
        resultsById,
        summary: buildSummary(partialResults),
      });
    }
  } finally {
    const finalResults = orders
      .map(item => resultsById[item.bizOrderId])
      .filter(Boolean);
    saveJson(OUTPUT_FILE, {
      generatedAt: new Date().toISOString(),
      requiredShippingNeedles: REQUIRED_SHIPPING_NEEDLES,
      summary: buildSummary(finalResults),
      results: finalResults,
    });
    await browser.close().catch(() => null);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
