const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const COOKIES_FILE = path.join(ROOT, 'taobao-cookies.json');
const SOURCE_FILE = path.join(ROOT, 'invoice-action-2025-2026-execute.json');
const OUTPUT_FILE = path.join(ROOT, 'invoice-status-current-2026-05-14.json');
const LIST_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';

const ACTION_WORDS = [
  { type: 'download', words: ['下载发票', '发票下载', '下载'] },
  { type: 'apply', words: ['申请开票', '开具发票', '我要开票'] },
  { type: 'reissue', words: ['换开发票', '换开', '重新开票', '重开发票'] },
  { type: 'view', words: ['查看发票'] },
];

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pickTrackedOrders() {
  const source = loadJson(SOURCE_FILE);
  return (source.results || [])
    .filter(result => ['submitted', 'pending'].includes(result.execution?.status))
    .map(result => ({
      bizOrderId: result.bizOrderId,
      orderDate: result.orderDate,
      platform: result.platform,
      url: result.url,
      previousStatus: result.execution.status,
    }));
}

async function collectCandidates(page) {
  return await page.evaluate((actionWords) => {
    const nodes = Array.from(document.querySelectorAll('a, button, div, span'));
    const out = [];
    for (const node of nodes) {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      for (const group of actionWords) {
        for (const word of group.words) {
          if (text.includes(word)) {
            out.push({
              type: group.type,
              text,
            });
            break;
          }
        }
      }
    }
    return out;
  }, ACTION_WORDS);
}

async function clickFirstAction(context, page, type) {
  const group = ACTION_WORDS.find(item => item.type === type);
  if (!group) return null;

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
      await target.click({ timeout: 8000 }).catch(() => null);
      const popup = await popupPromise;
      const actionPage = popup || page;
      await actionPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
      await actionPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
      await actionPage.waitForTimeout(1200);
      return { page: actionPage, openedPopup: Boolean(popup), clickedText: word };
    }
  }

  return null;
}

async function closePageQuietly(page) {
  if (!page || page.isClosed()) return;
  await page.close({ runBeforeUnload: false }).catch(() => null);
}

function classifyStatus(bodyText, candidates, finalUrl) {
  if (/login\.taobao\.com|passport/.test(finalUrl)) {
    return { status: 'login_required', reason: '跳转到登录页' };
  }

  const text = bodyText || '';
  const types = new Set(candidates.map(item => item.type));

  if (types.has('download')) {
    return { status: 'downloadable_now', reason: '页面已出现下载发票入口' };
  }
  if (['申请中', '商家正在处理', '已提交', '处理中', '查看申请历史'].some(word => text.includes(word))) {
    return { status: 'processing', reason: '页面显示申请中/处理中' };
  }
  if (text.includes('开票成功')) {
    return { status: 'submitted', reason: '页面显示开票成功' };
  }
  if (types.has('reissue')) {
    return { status: 'reissuable_now', reason: '页面出现换开入口' };
  }
  if (types.has('apply')) {
    return { status: 'apply_available', reason: '页面仍显示申请开票入口' };
  }
  if (types.has('view')) {
    return { status: 'view_only', reason: '页面只有查看发票入口' };
  }
  return { status: 'no_invoice_entry', reason: '页面未发现可用发票入口' };
}

async function inspectInnerStatus(context, page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  const candidates = await collectCandidates(page);
  const status = classifyStatus(bodyText, candidates, page.url());
  return { ...status, candidates, finalUrl: page.url() };
}

async function inspectOne(context, page, order) {
  try {
    await page.goto(order.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
    await page.locator('body').waitFor({ timeout: 5000 }).catch(() => null);
    try { await page.click('text=知道了', { timeout: 1200 }); } catch {}
    await page.waitForTimeout(1200);

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const candidates = await collectCandidates(page);
    let status = classifyStatus(bodyText, candidates, page.url());
    let popupStatus = null;

    if (candidates.some(candidate => candidate.type === 'apply')) {
      const clickResult = await clickFirstAction(context, page, 'apply');
      if (clickResult) {
        try {
          popupStatus = await inspectInnerStatus(context, clickResult.page);
          status = popupStatus;
        } finally {
          if (clickResult.openedPopup) {
            await closePageQuietly(clickResult.page);
          }
        }
      }
    } else if (candidates.some(candidate => candidate.type === 'view')) {
      const clickResult = await clickFirstAction(context, page, 'view');
      if (clickResult) {
        try {
          popupStatus = await inspectInnerStatus(context, clickResult.page);
          status = popupStatus;
        } finally {
          if (clickResult.openedPopup) {
            await closePageQuietly(clickResult.page);
          }
        }
      }
    }

    return {
      ...order,
      finalUrl: status.finalUrl || page.url(),
      currentStatus: status.status,
      reason: status.reason,
      candidates,
      popupStatus,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ...order,
      currentStatus: 'error',
      reason: error.message,
      checkedAt: new Date().toISOString(),
    };
  }
}

function buildSummary(results) {
  const summary = {
    totalTracked: results.length,
    downloadableNow: 0,
    processing: 0,
    submitted: 0,
    reissuableNow: 0,
    applyAvailable: 0,
    viewOnly: 0,
    noInvoiceEntry: 0,
    loginRequired: 0,
    errors: 0,
  };

  for (const result of results) {
    if (result.currentStatus === 'downloadable_now') summary.downloadableNow++;
    else if (result.currentStatus === 'processing') summary.processing++;
    else if (result.currentStatus === 'submitted') summary.submitted++;
    else if (result.currentStatus === 'reissuable_now') summary.reissuableNow++;
    else if (result.currentStatus === 'apply_available') summary.applyAvailable++;
    else if (result.currentStatus === 'view_only') summary.viewOnly++;
    else if (result.currentStatus === 'no_invoice_entry') summary.noInvoiceEntry++;
    else if (result.currentStatus === 'login_required') summary.loginRequired++;
    else if (result.currentStatus === 'error') summary.errors++;
  }

  return summary;
}

async function main() {
  const orders = pickTrackedOrders();
  const cookies = loadJson(COOKIES_FILE);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: false,
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  if (/login\.taobao\.com|passport/.test(page.url())) {
    throw new Error('Cookies 已失效，访问订单列表仍跳到登录页');
  }

  const results = [];
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const result = await inspectOne(context, page, order);
    results.push(result);
    console.log(`[${i + 1}/${orders.length}] ${order.bizOrderId} -> ${result.currentStatus} | ${result.reason}`);
  }

  const summary = buildSummary(results);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary,
    results,
  }, null, 2));

  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
