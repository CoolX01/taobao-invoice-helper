const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const COOKIES_FILE = path.join(ROOT, 'taobao-cookies.json');
const SOURCE_FILE = path.join(ROOT, 'invoice-action-2025-2026-execute.json');
const OUTPUT_FILE = path.join(ROOT, 'invoice-status-invoice-page-2026-05-14.json');

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
      previousStatus: result.execution.status,
      invoiceUrl: `https://invoice-ua.taobao.com/detail/pc#/?orderId=${result.bizOrderId}`,
    }));
}

async function collectCandidates(page) {
  const words = ['下载发票', '发票下载', '换开发票', '换开', '申请中', '处理中', '查看申请历史', '提交成功', '开票成功'];
  return await page.evaluate((words) => {
    const text = document.body.innerText || '';
    return words.filter(word => text.includes(word));
  }, words);
}

function classify(text) {
  if (['申请中', '商家正在处理', '已提交', '处理中', '查看申请历史'].some(word => text.includes(word))) {
    return { status: 'processing', reason: '页面显示申请中/处理中' };
  }
  if (text.includes('下载发票') || text.includes('发票下载')) {
    return { status: 'downloadable_now', reason: '页面显示下载发票' };
  }
  if (text.includes('开票成功') || text.includes('提交成功') || text.includes('申请成功')) {
    return { status: 'submitted', reason: '页面显示提交/开票成功' };
  }
  if (text.includes('换开发票') || text.includes('换开')) {
    return { status: 'reissuable_now', reason: '页面显示换开入口' };
  }
  if (text.includes('申请开票') || text.includes('开具发票') || text.includes('我要开票')) {
    return { status: 'apply_available', reason: '页面显示申请开票入口' };
  }
  return { status: 'unknown', reason: '页面未识别到明确发票状态' };
}

function buildSummary(results) {
  const summary = {
    totalTracked: results.length,
    downloadableNow: 0,
    processing: 0,
    submitted: 0,
    reissuableNow: 0,
    applyAvailable: 0,
    unknown: 0,
    errors: 0,
    loginRequired: 0,
  };

  for (const result of results) {
    if (result.currentStatus === 'downloadable_now') summary.downloadableNow++;
    else if (result.currentStatus === 'processing') summary.processing++;
    else if (result.currentStatus === 'submitted') summary.submitted++;
    else if (result.currentStatus === 'reissuable_now') summary.reissuableNow++;
    else if (result.currentStatus === 'apply_available') summary.applyAvailable++;
    else if (result.currentStatus === 'unknown') summary.unknown++;
    else if (result.currentStatus === 'login_required') summary.loginRequired++;
    else if (result.currentStatus === 'error') summary.errors++;
  }

  return summary;
}

async function main() {
  const orders = pickTrackedOrders();
  const cookies = loadJson(COOKIES_FILE);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: false,
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  const results = [];
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    try {
      await page.goto(order.invoiceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
      await page.waitForTimeout(1500);
      const finalUrl = page.url();
      if (/login\.taobao\.com|passport/.test(finalUrl)) {
        const result = {
          ...order,
          currentStatus: 'login_required',
          reason: '跳到登录页',
          finalUrl,
          checkedAt: new Date().toISOString(),
        };
        results.push(result);
        console.log(`[${i + 1}/${orders.length}] ${order.bizOrderId} -> ${result.currentStatus} | ${result.reason}`);
        break;
      }

      const bodyText = await page.evaluate(() => document.body.innerText || '');
      const hints = await collectCandidates(page);
      const status = classify(bodyText);
      const result = {
        ...order,
        currentStatus: status.status,
        reason: status.reason,
        finalUrl,
        hints,
        checkedAt: new Date().toISOString(),
      };
      results.push(result);
      console.log(`[${i + 1}/${orders.length}] ${order.bizOrderId} -> ${result.currentStatus} | ${result.reason}`);
    } catch (error) {
      const result = {
        ...order,
        currentStatus: 'error',
        reason: error.message,
        checkedAt: new Date().toISOString(),
      };
      results.push(result);
      console.log(`[${i + 1}/${orders.length}] ${order.bizOrderId} -> error | ${error.message}`);
    }
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
