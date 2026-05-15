const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const COOKIES_FILE = path.join(ROOT, 'taobao-cookies.json');
const CONFIG_FILE = path.join(ROOT, 'invoice-config.json');
const SOURCE_FILE = path.join(ROOT, 'invoice-status-invoice-page-2026-05-14.json');
const CURRENT_SOURCE_FILE = path.join(ROOT, 'invoice-status-current-2026-05-14.json');
const TODAY = new Date().toISOString().slice(0, 10);
const OUTPUT_FILE = path.join(ROOT, `repair-pending-invoices-${TODAY}.json`);
const HISTORY_WORDS = ['申请历史', '查看申请历史'];
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

function buildRedactionSecrets(invoiceConfig) {
  return [
    invoiceConfig.companyName,
    invoiceConfig.taxNo,
    invoiceConfig.email,
    invoiceConfig.phone,
    invoiceConfig.address,
    invoiceConfig.bankName,
    invoiceConfig.bankAccount,
    invoiceConfig.paperShippingName,
    invoiceConfig.paperShippingPhone,
    invoiceConfig.paperShippingAddress,
  ].filter(Boolean);
}

function redactSensitiveText(value, secrets) {
  let text = String(value || '');
  for (const secret of secrets) {
    const raw = String(secret || '');
    if (!raw) continue;
    text = text.split(raw).join('[REDACTED]');
    const tight = normalizeTight(raw);
    if (tight && tight !== raw) {
      text = text.split(tight).join('[REDACTED]');
    }
  }
  return text;
}

function sanitizeForOutput(value, secrets, key = '') {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeForOutput(item, secrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeForOutput(childValue, secrets, childKey),
      ])
    );
  }
  if (typeof value !== 'string') return value;
  if (key === 'bodyText' || key === 'historyText') {
    return value ? '[REDACTED_FULL_TEXT]' : '';
  }
  if (['value', 'beforeValue', 'afterValue', 'text'].includes(key) && value) {
    return '[REDACTED]';
  }
  return redactSensitiveText(value, secrets);
}

function saveSanitizedJson(file, data, invoiceConfig) {
  saveJson(file, sanitizeForOutput(data, buildRedactionSecrets(invoiceConfig)));
}

function buildInvoiceUrl(orderId, fallbackUrl = '') {
  return fallbackUrl || `https://invoice-ua.taobao.com/detail/pc#/?orderId=${orderId}`;
}

function requiresEmailReason(text) {
  const haystack = String(text || '');
  return EMAIL_REASON_HINTS.some(item => haystack.includes(item));
}

function normalizeTight(text) {
  return String(text || '').replace(/\s+/g, '');
}

function normalizeIdentifier(text) {
  return normalizeTight(text).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function looksLikeTaxNo(value, invoiceConfig) {
  const normalized = normalizeIdentifier(value);
  const configuredTaxNo = normalizeIdentifier(invoiceConfig.taxNo);
  if (!normalized) return false;
  if (configuredTaxNo && normalized === configuredTaxNo) return true;
  return /^[0-9A-Z]{15,20}$/.test(normalized) && /\d{10,}/.test(normalized);
}

function bodyShowsTaxNoAsInvoiceTitle(text, invoiceConfig) {
  const taxNo = normalizeIdentifier(invoiceConfig.taxNo);
  if (!taxNo) return false;
  const compact = normalizeIdentifier(text);
  if (!compact.includes(taxNo)) return false;

  const readable = String(text || '').replace(/\s+/g, '');
  const taxPattern = invoiceConfig.taxNo
    .split('')
    .map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  return new RegExp(`(?:发票|抬头|企业)[^\\n\\r]{0,20}${taxPattern}`).test(readable)
    || readable.includes(`企业-${invoiceConfig.taxNo}`)
    || readable.includes(`发票${invoiceConfig.taxNo}`);
}

function buildRequiredShippingNeedles(invoiceConfig) {
  return [
    invoiceConfig.paperShippingAddress || invoiceConfig.address,
    invoiceConfig.paperShippingName,
    invoiceConfig.paperShippingPhone,
    invoiceConfig.companyName,
  ].filter(Boolean);
}

function shippingNeedlesMatch(text, needles) {
  const normalizedText = normalizeTight(text);
  const normalizedNeedles = needles.map(normalizeTight).filter(Boolean);
  return normalizedNeedles.length > 0
    && normalizedNeedles.every(needle => normalizedText.includes(needle));
}

function isWrongIssuedInvoice(result, invoiceConfig) {
  const haystack = JSON.stringify(result || {});
  const taxNo = invoiceConfig.taxNo || '';
  if (!taxNo) return false;

  const hasModifyEntry = haystack.includes('修改申请');
  const hasWrongTitleInPopup = haystack.includes(`发票抬头： ${taxNo}`) || haystack.includes(`购方税号： ${taxNo}`);
  const hasWrongTitleOnOrderPage = bodyShowsTaxNoAsInvoiceTitle(haystack, invoiceConfig);

  return hasModifyEntry && (hasWrongTitleInPopup || hasWrongTitleOnOrderPage);
}

function pickTrackedOrders() {
  const source = loadJson(SOURCE_FILE);
  const currentSource = loadJson(CURRENT_SOURCE_FILE);
  const invoiceConfig = loadJson(CONFIG_FILE);
  const orderMap = new Map();

  for (const result of source.results || []) {
    if (result.currentStatus !== 'processing') continue;
    orderMap.set(result.bizOrderId, {
      bizOrderId: result.bizOrderId,
      orderDate: result.orderDate,
      platform: result.platform,
      invoiceUrl: buildInvoiceUrl(result.bizOrderId, result.invoiceUrl || result.finalUrl),
      sourceTag: 'processing_queue',
    });
  }

  for (const result of currentSource.results || []) {
    if (!isWrongIssuedInvoice(result, invoiceConfig)) continue;
    orderMap.set(result.bizOrderId, {
      bizOrderId: result.bizOrderId,
      orderDate: result.orderDate,
      platform: result.platform,
      invoiceUrl: buildInvoiceUrl(result.bizOrderId, result.finalUrl || result.invoiceUrl || result.url),
      sourceTag: 'wrong_issued_invoice',
      currentStatus: result.currentStatus,
    });
  }

  let orders = [...orderMap.values()].sort((a, b) => {
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
        invoiceUrl: buildInvoiceUrl(orderId),
        sourceTag: 'manual_order_id',
      }];
  }
  if (Number.isFinite(limit) && limit > 0) {
    orders = orders.slice(0, limit);
  }
  return orders;
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
    const count = Math.min(await locator.count().catch(() => 0), 8);
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

  for (const word of words) {
    const locator = page.getByText(word, { exact: true });
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await target.click({ timeout: 8000 }).catch(() => null);
      const popup = await popupPromise;
      const actionPage = popup || page;
      await actionPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
      await actionPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
      await sleep(1200);
      return { page: actionPage, openedPopup: Boolean(popup), clickedText: word, source: 'text_fallback' };
    }
  }

  return null;
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

async function closeModal(page) {
  const closeTargets = ['取消', '关闭'];
  for (const text of closeTargets) {
    const locator = page.locator('button, a, [role="button"], div[class*="button"], span[class*="button"]').filter({ hasText: text });
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

const FIELD_POSITION = {
  companyName: 0,
  taxNo: 1,
  address: 2,
  phone: 3,
  bankName: 4,
  bankAccount: 5,
};

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
      await target.fill(value, { timeout: 5000 }).catch(() => null);
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

  const optionLocator = page.locator('li, div, span').filter({ hasText: companyName });
  const count = Math.min(await optionLocator.count().catch(() => 0), 10);
  for (let i = 0; i < count; i++) {
    const target = optionLocator.nth(i);
    const text = (await target.textContent().catch(() => '') || '').trim();
    if (!text.includes(companyName)) continue;
    if (!(await target.isVisible().catch(() => false))) continue;
    await target.click({ timeout: 5000 }).catch(() => null);
    await sleep(800);
    return { selected: true, text };
  }

  return { selected: false, reason: 'company_profile_option_not_found' };
}

async function inspectFormValues(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  let companyValue = await readValueByExactRowLabel(page, ['发票抬头'], 'companyName');
  if (!companyValue.found) companyValue = await readValueByPosition(page, 'companyName');

  let taxValue = await readValueByExactRowLabel(page, ['税号', '纳税人识别号', '统一社会信用代码'], 'taxNo');
  if (!taxValue.found) taxValue = await readValueByPosition(page, 'taxNo');

  let addressValue = await readValueByExactRowLabel(page, ['企业地址', '单位地址', '注册地址'], 'address');
  if (!addressValue.found) addressValue = await readValueByPosition(page, 'address');

  const emailValue = await readValueByExactRowLabel(page, ['邮箱', '电子邮箱'], 'email');

  const shippingAddressValue = await page.evaluate(() => {
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
        el,
        text: normalize(el.textContent || el.getAttribute('value') || el.getAttribute('placeholder') || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item =>
        item.rect.left >= targetLabel.rect.right - 12
        && Math.abs((item.rect.top + item.rect.bottom) / 2 - (targetLabel.rect.top + targetLabel.rect.bottom) / 2) <= 40
        && item.rect.width > 120
      );

    const picked = candidates
      .sort((a, b) => (b.rect.width - a.rect.width) || (Math.abs(a.rect.top - targetLabel.rect.top) - Math.abs(b.rect.top - targetLabel.rect.top)))
      .find(item => item.text && item.text !== '请选择');

    return picked ? { found: true, value: picked.text } : { found: false, value: '' };
  }).catch(() => ({ found: false, value: '' }));

  return {
    bodyText,
    companyValue,
    taxValue,
    addressValue,
    emailValue,
    shippingAddressValue,
  };
}

async function inspectHistory(context, page) {
  const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  if (!HISTORY_WORDS.some(word => pageText.includes(word))) {
    return {
      attempted: false,
      opened: false,
      historyText: '',
      hasWrongTitleReason: false,
      hasExpiredReason: false,
      hasEmailReason: false,
    };
  }

  const originalUrl = page.url();
  const historyResult = await clickTextButton(context, page, HISTORY_WORDS);
  if (!historyResult) {
    return {
      attempted: true,
      opened: false,
      historyText: '',
      hasWrongTitleReason: false,
      hasExpiredReason: false,
      hasEmailReason: false,
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

function needsRepair(currentValues, invoiceConfig, history = {}) {
  const isPaperInvoice = currentValues.bodyText?.includes('普通发票-纸质') || currentValues.bodyText?.includes('收货地址');
  const companyLooksLikeTaxNo = looksLikeTaxNo(currentValues.companyValue?.value, invoiceConfig);
  const bodyTitleLooksLikeTaxNo = bodyShowsTaxNoAsInvoiceTitle(currentValues.bodyText, invoiceConfig);
  const companyWrong = !currentValues.companyValue.found
    || currentValues.companyValue.value !== invoiceConfig.companyName
    || companyLooksLikeTaxNo
    || bodyTitleLooksLikeTaxNo;
  const taxWrong = !currentValues.taxValue.found || currentValues.taxValue.value !== invoiceConfig.taxNo;
  const addressLooksWrong = currentValues.addressValue
    && currentValues.addressValue.found
    && currentValues.addressValue.value
    && currentValues.addressValue.value === invoiceConfig.bankAccount;
  const requiredShippingNeedles = buildRequiredShippingNeedles(invoiceConfig);
  const shippingWrong = isPaperInvoice && (
    !currentValues.shippingAddressValue?.found
    || !shippingNeedlesMatch(currentValues.shippingAddressValue.value, requiredShippingNeedles)
  );
  const emailRequested = Boolean(invoiceConfig.email) && (
    Boolean(history.hasEmailReason) || requiresEmailReason(currentValues.bodyText)
  );
  const emailWrong = emailRequested && (
    !currentValues.emailValue?.found
    || currentValues.emailValue.value !== invoiceConfig.email
  );

  return {
    repair: companyWrong || taxWrong || addressLooksWrong || shippingWrong || emailWrong,
    isPaperInvoice,
    companyWrong,
    companyLooksLikeTaxNo,
    bodyTitleLooksLikeTaxNo,
    taxWrong,
    addressLooksWrong,
    shippingWrong,
    emailRequested,
    emailWrong,
    requiredShippingNeedles,
  };
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

async function fillCorrectValues(page, invoiceConfig, history = {}) {
  await clickRadioOrOption(page, ['企业', '单位', '公司']);
  const filledFields = [];
  const reasonText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const shouldFillEmail = Boolean(invoiceConfig.email) && (
    Boolean(history.hasEmailReason) || requiresEmailReason(reasonText)
  );

  const profileSelection = await selectSavedInvoiceProfile(page, invoiceConfig.companyName);

  let companyField = await fillByExactRowLabel(page, ['发票抬头'], invoiceConfig.companyName, 'companyName');
  if (!companyField.filled) companyField = await fillByPosition(page, 'companyName', invoiceConfig.companyName);
  filledFields.push(companyField);

  let taxField = await fillByExactRowLabel(page, ['税号', '纳税人识别号', '统一社会信用代码'], invoiceConfig.taxNo, 'taxNo');
  if (!taxField.filled) taxField = await fillByPosition(page, 'taxNo', invoiceConfig.taxNo);
  filledFields.push(taxField);

  await clickRadioOrOption(page, ['展开非必填信息', '更多信息', '展开']);

  if (shouldFillEmail) {
    const emailField = await fillFirstVisible(page, [
      'input[placeholder*="邮箱"]',
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
    ], invoiceConfig.email, 'email', ['邮箱', '电子邮箱']);
    filledFields.push(emailField);
  }

  if (invoiceConfig.bankName) {
    let bankNameField = await fillByExactRowLabel(page, ['开户银行', '开户行'], invoiceConfig.bankName, 'bankName');
    if (!bankNameField.filled) bankNameField = await fillByPosition(page, 'bankName', invoiceConfig.bankName);
    filledFields.push(bankNameField);
  }
  if (invoiceConfig.bankAccount) {
    let bankAccountField = await fillByExactRowLabel(page, ['银行账号', '银行账户'], invoiceConfig.bankAccount, 'bankAccount');
    if (!bankAccountField.filled) bankAccountField = await fillByPosition(page, 'bankAccount', invoiceConfig.bankAccount);
    filledFields.push(bankAccountField);
  }
  if (invoiceConfig.phone) {
    let phoneField = await fillByExactRowLabel(page, ['企业电话', '单位电话', '电话', '手机号'], invoiceConfig.phone, 'phone');
    if (!phoneField.filled) phoneField = await fillByPosition(page, 'phone', invoiceConfig.phone);
    filledFields.push(phoneField);
  }

  let clearedAddress = await clearByExactRowLabel(page, ['企业地址', '单位地址', '注册地址'], 'address');
  if (!clearedAddress.cleared) clearedAddress = await clearByPosition(page, 'address');

  let shippingSelection = { selected: false, reason: 'not_required' };
  const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  if (pageText.includes('普通发票-纸质') || pageText.includes('收货地址')) {
    shippingSelection = await selectShippingAddress(page, invoiceConfig);
  }

  const validation = await inspectFormValues(page);
  return { profileSelection, filledFields, clearedAddress, shippingSelection, validation };
}

async function selectShippingAddress(page, invoiceConfig) {
  const requiredNeedles = buildRequiredShippingNeedles(invoiceConfig);
  if (requiredNeedles.length === 0) return { selected: false, reason: 'empty_address' };

  const normalizedNeedles = requiredNeedles.map(normalizeTight);

  const directSelection = await page.evaluate(({ normalizedNeedles }) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const candidates = [...document.querySelectorAll('li, div, span, p')]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: (el.textContent || '').replace(/\s+/g, ''),
      }))
      .filter(item => item.text.length > 0);

    const target = candidates.find(item => normalizedNeedles.every(needle => item.text.includes(needle)));
    if (!target) return { selected: false };
    target.el.click();
    return { selected: true, text: target.el.textContent || '' };
  }, { normalizedNeedles }).catch(() => ({ selected: false }));

  if (directSelection.selected) {
    await sleep(800);
    return { selected: true, text: directSelection.text, opened: true, mode: 'direct_visible_option' };
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
        el,
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

  const optionLocator = page.locator('li, div, span, p');
  const count = Math.min(await optionLocator.count().catch(() => 0), 300);
  for (let i = 0; i < count; i++) {
    const target = optionLocator.nth(i);
    const text = (await target.textContent().catch(() => '') || '').trim();
    const normalizedText = text.replace(/\s+/g, '');
    if (!normalizedNeedles.every(needle => normalizedText.includes(needle))) continue;
    if (!(await target.isVisible().catch(() => false))) continue;
    await target.click({ timeout: 5000 }).catch(() => null);
    await sleep(800);
    return { selected: true, text, opened, mode: 'dropdown_option' };
  }

  return {
    selected: false,
    reason: opened ? 'shipping_option_not_found' : 'shipping_dropdown_not_opened',
    requiredNeedles,
  };
}

async function clickSubmit(page) {
  const submitWords = ['确定', '提交申请', '提交', '确认提交', '保存'];
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
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;
      await target.click({ timeout: 8000 }).catch(() => null);
      await sleep(1500);
      return { submitted: true, text: word };
    }
  }
  return { submitted: false };
}

async function processOrder(context, page, order, invoiceConfig) {
  await page.goto(order.invoiceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
  await sleep(1200);

  const history = await inspectHistory(context, page);

  const editResult = await clickTextButton(context, page, ['修改申请']);
  if (!editResult) {
    const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const wrongTitleDetected = bodyShowsTaxNoAsInvoiceTitle(bodyText, invoiceConfig);
    return {
      ...order,
      status: 'no_modify_entry',
      reason: wrongTitleDetected ? '检测到税号被当作发票抬头，但未找到修改申请入口' : '未找到修改申请入口',
      wrongTitleDetected,
      history,
    };
  }

  const actionPage = editResult.page;
  try {
    await confirmModifyIfNeeded(actionPage);
    const currentValues = await inspectFormValues(actionPage);
    const decision = needsRepair(currentValues, invoiceConfig, history);

    if (!decision.repair) {
      if (!hasFlag('force-submit')) {
        await closeModal(actionPage);
        return {
          ...order,
          status: 'already_correct',
          currentValues,
          history,
        };
      }

      const submitResult = await clickSubmit(actionPage);
      const bodyText = await actionPage.evaluate(() => document.body.innerText || '').catch(() => '');
      return {
        ...order,
        status: submitResult.submitted ? 'repaired' : 'blocked',
        reason: submitResult.submitted ? '表单已正确，按要求重新提交申请' : '表单已正确，但未找到确定/提交按钮',
        currentValues,
        history,
        submitResult,
        successHint: ['申请中', '处理中', '提交成功', '申请成功'].find(word => bodyText.includes(word)) || '',
      };
    }

    const fillResult = await fillCorrectValues(actionPage, invoiceConfig, history);
    const requiredShippingNeedles = buildRequiredShippingNeedles(invoiceConfig);
    const paperAddressSatisfied = fillResult.shippingSelection?.selected
      && shippingNeedlesMatch(fillResult.shippingSelection.text, requiredShippingNeedles);
    const stillWrong = !fillResult.validation.companyValue.found
      || fillResult.validation.companyValue.value !== invoiceConfig.companyName
      || !fillResult.validation.taxValue.found
      || fillResult.validation.taxValue.value !== invoiceConfig.taxNo
      || (
        (fillResult.validation.bodyText?.includes('普通发票-纸质') || fillResult.validation.bodyText?.includes('收货地址'))
        && !paperAddressSatisfied
        && (
          !fillResult.validation.shippingAddressValue?.found
          || !shippingNeedlesMatch(fillResult.validation.shippingAddressValue.value, requiredShippingNeedles)
        )
      );
    if (stillWrong) {
      await closeModal(actionPage);
      return {
        ...order,
        status: 'blocked',
        reason: '修正后回读校验仍不匹配',
        currentValues,
        history,
        fillResult,
      };
    }

    const submitResult = await clickSubmit(actionPage);
    const bodyText = await actionPage.evaluate(() => document.body.innerText || '').catch(() => '');
    return {
      ...order,
      status: submitResult.submitted ? 'repaired' : 'blocked',
      reason: submitResult.submitted ? '已提交修改申请' : '未找到确定/提交按钮',
      currentValues,
      history,
      fillResult,
      submitResult,
      successHint: ['申请中', '处理中', '提交成功', '申请成功'].find(word => bodyText.includes(word)) || '',
    };
  } finally {
    if (editResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

function buildSummary(results) {
  const summary = {
    total: results.length,
    repaired: 0,
    alreadyCorrect: 0,
    blocked: 0,
    noModifyEntry: 0,
    errors: 0,
  };

  for (const result of results) {
    if (result.status === 'repaired') summary.repaired++;
    else if (result.status === 'already_correct') summary.alreadyCorrect++;
    else if (result.status === 'blocked') summary.blocked++;
    else if (result.status === 'no_modify_entry') summary.noModifyEntry++;
    else if (result.status === 'error') summary.errors++;
  }

  return summary;
}

async function main() {
  const cookies = loadJson(COOKIES_FILE);
  const invoiceConfig = loadJson(CONFIG_FILE);
  const orders = pickTrackedOrders();

  const browser = await chromium.launch({ headless: !hasFlag('headful') });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: false,
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await closeAuxiliaryPages(context, page);

  const results = [];
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    try {
      const result = await processOrder(context, page, order, invoiceConfig);
      results.push({
        ...result,
        checkedAt: new Date().toISOString(),
      });
      console.log(`[${i + 1}/${orders.length}] ${order.bizOrderId} -> ${result.status} | ${result.reason || ''}`);
    } catch (error) {
      results.push({
        ...order,
        status: 'error',
        reason: error.message,
        checkedAt: new Date().toISOString(),
      });
      console.log(`[${i + 1}/${orders.length}] ${order.bizOrderId} -> error | ${error.message}`);
    } finally {
      await closeAuxiliaryPages(context, page);
    }
  }

  const summary = buildSummary(results);
  saveSanitizedJson(OUTPUT_FILE, {
    generatedAt: new Date().toISOString(),
    summary,
    results,
  }, invoiceConfig);

  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
