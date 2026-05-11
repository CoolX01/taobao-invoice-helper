// 调试开票/换开表单结构：只点击进入表单并导出控件信息，不提交。
process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');
const PLAN_FILE = path.join(__dirname, 'invoice-action-2026-plan.json');
const OUTPUT_FILE = path.join(__dirname, 'debug-invoice-form.json');
const SCREENSHOT_FILE = path.join(__dirname, 'debug-invoice-form.png');

const APPLY_WORDS = ['申请开票', '开具发票', '我要开票'];
const REISSUE_WORDS = ['换开发票', '换开', '重新开票', '重开发票'];

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clickByWords(context, page, words) {
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
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;

      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await target.click({ timeout: 8000 });
      const popup = await popupPromise;
      const actionPage = popup || page;
      await actionPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
      await actionPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
      await sleep(2000);
      return { actionPage, clickedText: word, openedPopup: Boolean(popup) };
    }
  }

  throw new Error(`没有找到入口: ${words.join('/')}`);
}

async function main() {
  const action = getArg('action', 'apply');
  const orderId = getArg('order-id');
  const planFile = getArg('plan-file', PLAN_FILE);

  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const sourceList = Array.isArray(plan.results)
    ? plan.results
    : Array.isArray(plan.mappings)
      ? plan.mappings
      : [];
  const target = orderId
    ? sourceList.find(item => item.bizOrderId === orderId)
    : sourceList.find(item => item.actionPlan?.action === (action === 'reissue' ? 'reissue_invoice' : 'apply_invoice'));

  if (!target) {
    throw new Error('计划文件中找不到目标订单');
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    slowMo: 150,
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await sleep(1500);

    const clickResult = await clickByWords(context, page, action === 'reissue' ? REISSUE_WORDS : APPLY_WORDS);
    const actionPage = clickResult.actionPage;

    const controls = await actionPage.evaluate(() => {
      function pickAttrs(el) {
        const attrs = {};
        for (const name of ['name', 'id', 'placeholder', 'type', 'value', 'aria-label', 'role', 'class']) {
          const value = el.getAttribute(name);
          if (value) attrs[name] = value.slice(0, 160);
        }
        return attrs;
      }

      const controlSelector = 'input, textarea, select, button, a, [role="button"], [role="radio"], label';
      return [...document.querySelectorAll(controlSelector)].map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          index,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          attrs: pickAttrs(el),
          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          nearText: (el.closest('label, div, form, section')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        };
      }).filter(item => item.visible || item.tag === 'input' || item.tag === 'textarea' || item.tag === 'select');
    });

    const result = {
      target: {
        bizOrderId: target.bizOrderId,
        orderDate: target.orderDate,
        platform: target.platform,
        detailUrl: target.url,
      },
      clicked: {
        text: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
        formUrl: actionPage.url(),
      },
      controls,
      capturedAt: new Date().toISOString(),
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');
    await actionPage.screenshot({ path: SCREENSHOT_FILE, fullPage: true }).catch(() => null);
    console.log(`已导出: ${OUTPUT_FILE}`);
    console.log(`截图: ${SCREENSHOT_FILE}`);
  } finally {
    await context.close().catch(() => null);
  }
}

main().catch(error => {
  console.error('❌ 调试失败:', error.message);
  process.exit(1);
});
