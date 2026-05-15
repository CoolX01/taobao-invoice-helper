const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const COOKIES_FILE = path.join(ROOT, 'taobao-cookies.json');
const OUTPUT_FILE = path.join(ROOT, 'inspect-invoice-history.json');

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  return null;
}

async function closePageQuietly(page) {
  if (!page || page.isClosed()) return;
  await page.close({ runBeforeUnload: false }).catch(() => null);
}

async function main() {
  const orderId = getArg('order-id');
  if (!orderId) throw new Error('缺少 --order-id');

  const cookies = loadJson(COOKIES_FILE);
  const browser = await chromium.launch({ headless: !hasFlag('headful') });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: false,
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    const invoiceUrl = `https://invoice-ua.taobao.com/detail/pc#/?orderId=${orderId}`;
    await page.goto(invoiceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
    await sleep(1200);

    const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const historyResult = await clickTextButton(context, page, ['申请历史']);

    let historyText = '';
    let historyUrl = '';
    if (historyResult) {
      const historyPage = historyResult.page;
      historyText = await historyPage.evaluate(() => document.body.innerText || '').catch(() => '');
      historyUrl = historyPage.url();
      if (historyResult.openedPopup) {
        await closePageQuietly(historyPage);
      }
    }

    const result = {
      orderId,
      invoiceUrl,
      bodyText,
      historyUrl,
      historyText,
      hasWrongTitleReason: historyText.includes('买家抬头信息输入有误'),
      hasExpiredReason: bodyText.includes('订单超过可开票期限') || historyText.includes('订单超过可开票期限'),
      capturedAt: new Date().toISOString(),
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    console.log(`已导出: ${OUTPUT_FILE}`);
    console.log(JSON.stringify({
      orderId: result.orderId,
      hasWrongTitleReason: result.hasWrongTitleReason,
      hasExpiredReason: result.hasExpiredReason,
      historyUrl: result.historyUrl,
    }, null, 2));
  } finally {
    await context.close().catch(() => null);
  }
}

main().catch(error => {
  console.error('❌ 检查失败:', error.message);
  process.exit(1);
});
