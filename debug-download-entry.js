const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const COOKIES_FILE = path.join(ROOT, 'taobao-cookies.json');
const OUTPUT_FILE = path.join(ROOT, 'debug-download-entry.json');

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

async function main() {
  const orderId = getArg('order-id');
  if (!orderId) throw new Error('缺少 --order-id');

  const cookies = loadJson(COOKIES_FILE);
  const browser = await chromium.launch({ headless: !hasFlag('headful') });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    const invoiceUrl = `https://invoice-ua.taobao.com/detail/pc#/?orderId=${orderId}`;
    await page.goto(invoiceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
    await sleep(2000);

    const result = await page.evaluate(() => {
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
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

      const watchWords = ['下载发票', '修改申请', '查看申请历史', '申请历史', '发票操作'];
      const matches = [...document.querySelectorAll('*')]
        .filter(el => isVisible(el))
        .map(el => ({
          tag: el.tagName,
          text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          className: typeof el.className === 'string' ? el.className : '',
          id: el.id || '',
          role: el.getAttribute('role') || '',
          href: el.getAttribute('href') || '',
          onclick: el.getAttribute('onclick') || '',
          cursor: window.getComputedStyle(el).cursor,
          depth: depth(el),
        }))
        .filter(item => item.text && item.text.length <= 160)
        .filter(item => watchWords.some(word => item.text.includes(word)))
        .sort((a, b) => (a.text.length - b.text.length) || (b.depth - a.depth))
        .slice(0, 120);

      return {
        url: location.href,
        bodyText: document.body.innerText || '',
        matches,
      };
    });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      orderId,
      invoiceUrl,
      capturedAt: new Date().toISOString(),
      ...result,
    }, null, 2));

    console.log(`已导出: ${OUTPUT_FILE}`);
    console.log(JSON.stringify({
      orderId,
      matchCount: result.matches.length,
      url: result.url,
      preview: result.matches.slice(0, 10),
    }, null, 2));
  } finally {
    await context.close().catch(() => null);
  }
}

main().catch(error => {
  console.error('❌ 调试失败:', error.message);
  process.exit(1);
});
