process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');
const LIST_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const OUTPUT_FILE = path.join(__dirname, 'debug-order-list.json');
const SCREENSHOT_DIR = path.join(__dirname, 'debug-order-list-shots');
const LOGIN_URL_MARKERS = [
  'login',
  'havanaone',
  'havanone',
  'passport.taobao.com',
  'login.taobao.com',
  'havanalogin',
];

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function isLoginOrVerifyUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return LOGIN_URL_MARKERS.some(marker => normalized.includes(marker));
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureLoggedIn(page) {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  if (!isLoginOrVerifyUrl(page.url())) return;

  console.log('需要登录，请在浏览器完成扫码...');
  await page.waitForFunction(
    markers => !markers.some(marker => location.href.toLowerCase().includes(marker)),
    LOGIN_URL_MARKERS,
    { timeout: 180000 }
  );
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
}

async function snapshotPage(page, pageNumber) {
  await page.waitForSelector('body', { timeout: 20000 });
  await sleep(1500);
  try { await page.click('text=知道了', { timeout: 1500 }); } catch {}

  const data = await page.evaluate(() => {
    function cleanText(value, max = 240) {
      return (value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const links = [...document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]')];
    const orders = [];
    const seen = new Set();

    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/bizOrderId=(\d+)/) || href.match(/biz_order_id=(\d+)/);
      const bizOrderId = match?.[1] || '';
      if (!bizOrderId || seen.has(bizOrderId)) continue;
      seen.add(bizOrderId);

      const container = link.closest('[id^="shopOrderContainer_"]') || link.closest('.trade-order-main') || link.closest('.trade-container') || link.parentElement;
      const text = cleanText(container?.innerText || '');
      const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
      orders.push({
        bizOrderId,
        date,
        text,
        href: new URL(href.startsWith('//') ? `https:${href}` : href, location.href).href,
      });
    }

    const activeLike = [...document.querySelectorAll('a, button, li, span, div, input, label')]
      .filter(el => isVisible(el))
      .map(el => ({
        text: cleanText(el.textContent || '', 120),
        className: typeof el.className === 'string' ? el.className : '',
        ariaCurrent: el.getAttribute('aria-current') || '',
        ariaSelected: el.getAttribute('aria-selected') || '',
        checked: el.getAttribute('checked') || '',
      }))
      .filter(item => item.text)
      .filter(item =>
        /active|current|selected|checked|on|highlight/i.test(item.className) ||
        item.ariaCurrent || item.ariaSelected || item.checked
      )
      .slice(0, 80);

    const paginationText = [...document.querySelectorAll('a, span, button')]
      .filter(el => isVisible(el))
      .map(el => cleanText(el.textContent || '', 40))
      .filter(text => /^[0-9]+$/.test(text) || text.includes('下一页') || text.includes('上一页') || text.includes('共') || text.includes('页'))
      .slice(0, 40);

    return {
      title: document.title,
      url: location.href,
      bodyTop: cleanText(document.body.innerText || '', 1200),
      activeLike,
      paginationText,
      orders,
      orderCount: orders.length,
    };
  });

  return { pageNumber, ...data };
}

async function main() {
  const pages = Number.parseInt(getArg('pages', '3'), 10) || 3;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 960 },
    slowMo: 150,
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    await ensureLoggedIn(page);

    const snapshots = [];
    for (let currentPage = 1; currentPage <= pages; currentPage++) {
      const snapshot = await snapshotPage(page, currentPage);
      snapshots.push(snapshot);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `page-${currentPage}.png`),
        fullPage: true,
      }).catch(() => null);

      if (currentPage >= pages) break;
      const before = snapshot.orders.map(item => item.bizOrderId).sort().join(',');
      try {
        await page.click('text=下一页', { timeout: 3000 });
        await page.waitForFunction(previousIds => {
          const ids = [...document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]')]
            .map(link => {
              const href = link.getAttribute('href') || '';
              const match = href.match(/bizOrderId=(\d+)/) || href.match(/biz_order_id=(\d+)/);
              return match?.[1] || '';
            })
            .filter(Boolean);
          return ids.length > 0 && [...new Set(ids)].sort().join(',') !== previousIds;
        }, before, { timeout: 10000 });
      } catch {
        break;
      }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      capturedAt: new Date().toISOString(),
      snapshots,
    }, null, 2), 'utf8');
    console.log(`已导出: ${OUTPUT_FILE}`);
    console.log(`截图目录: ${SCREENSHOT_DIR}`);
  } finally {
    await context.close().catch(() => null);
  }
}

main().catch(error => {
  console.error('❌ 调试失败:', error.message);
  process.exit(1);
});
