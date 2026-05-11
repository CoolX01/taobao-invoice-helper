// v13.0 - 淘宝发票详情检查（优化版）
// 特性：持久化浏览器 + 断点续传 + 节流防风控 + 只查未知订单
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');
const INPUT_FILE = path.join(__dirname, 'invoices-v10.json');
const PROGRESS_FILE = path.join(__dirname, 'invoices-progress.json');
const OUTPUT_FILE = path.join(__dirname, 'invoices-final.json');
const DETAIL_URL = 'https://buyertrade.taobao.com/trade/detail/tradeItemDetail.htm';

// 节流配置
const DELAY_MIN = 2000;  // 最小间隔 2秒
const DELAY_MAX = 4000;  // 最大间隔 4秒
const PAGE_TIMEOUT = 20000;  // 详情页加载超时 20秒
const BATCH_SIZE = 20;   // 每批回到列表页刷新session
const MAX_RETRIES = 2;   // 单个订单最大重试次数

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  return sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
}

// 加载已有进度（断点续传）
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch (e) {
      console.log('⚠️  进度文件损坏，从头开始');
    }
  }
  return null;
}

// 保存进度
function saveProgress(orders, stats) {
  const data = {
    lastUpdate: new Date().toISOString(),
    stats,
    orders,
  };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 从详情页提取发票信息
async function extractInvoiceFromDetail(page, orderId) {
  const url = `${DETAIL_URL}?orderId=${orderId}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(1500);  // 等待动态内容加载

    const info = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';

      // 多层匹配策略
      // 1. 明确的企业发票
      if (/发票抬头.*(公司|有限|企业|集团)|发票类型.*企业|抬头类型.*企业/.test(bodyText)) {
        const titleMatch = bodyText.match(/发票抬头[：:]\s*(.+?)[\n\r]/);
        return { invoiceType: 'company', invoiceTitle: titleMatch ? `企业-${titleMatch[1].trim()}` : '企业', confidence: 'high' };
      }
      if (/发票抬头.*企业|发票类型.*企业|抬头类型.*企业/.test(bodyText)) {
        // 尝试提取具体抬头
        const titleMatch = bodyText.match(/发票抬头[：:]\s*(.+?)[\n\r]/);
        return { invoiceType: 'company', invoiceTitle: titleMatch ? `企业-${titleMatch[1].trim()}` : '企业', confidence: 'high' };
      }

      // 2. 明确的个人发票
      if (/发票抬头.*个人|发票类型.*个人|抬头类型.*个人/.test(bodyText)) {
        return { invoiceType: 'personal', invoiceTitle: '个人', confidence: 'high' };
      }
      if (bodyText.includes('个人') && !bodyText.includes('企业')) {
        // 检查是否在发票相关区域
        const invoiceArea = bodyText.match(/发票[\s\S]{0,200}个人/);
        if (invoiceArea) {
          return { invoiceType: 'personal', invoiceTitle: '个人', confidence: 'medium' };
        }
      }

      // 3. 未开票 / 申请开票
      if (bodyText.includes('申请开票') || bodyText.includes('暂未开票') || bodyText.includes('未开票')) {
        return { invoiceType: 'no_invoice', invoiceTitle: '未开票', confidence: 'high' };
      }

      // 4. 有发票但不确定类型
      if (bodyText.includes('发票') && bodyText.includes('查看发票')) {
        return { invoiceType: 'has_invoice_unknown', invoiceTitle: '有发票-类型未确定', confidence: 'low' };
      }

      // 5. 完全没发票相关信息
      return { invoiceType: 'unknown', invoiceTitle: '', confidence: 'none' };
    });

    return info;
  } catch (e) {
    return { invoiceType: 'error', invoiceTitle: `访问失败: ${e.message.slice(0, 50)}`, confidence: 'none' };
  }
}

// ========== 主函数 ==========
async function main() {
  console.log('='.repeat(60));
  console.log('🔍 淘宝发票详情检查 v13.0（优化版）');
  console.log('   持久化浏览器 | 断点续传 | 节流防风控');
  console.log('='.repeat(60));

  // 1. 加载源数据
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ 找不到源数据: ${INPUT_FILE}`);
    process.exit(1);
  }
  const sourceData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const sourceOrders = sourceData.orders;
  console.log(`\n📂 源数据: ${sourceOrders.length} 个订单`);

  // 2. 加载已有进度（断点续传）
  const progress = loadProgress();
  let orders, stats;

  if (progress && progress.orders) {
    orders = progress.orders;
    stats = progress.stats;
    const checked = stats.company + stats.personal + stats.noInvoice + stats.hasInvoiceUnknown + stats.stillUnknown + stats.errors;
    console.log(`\n📂 恢复进度: 已检查 ${checked}/${stats.total} 个`);
    console.log(`   ✅公司=${stats.company} ❌个人=${stats.personal} 📭未开票=${stats.noInvoice} ❓未知=${stats.stillUnknown} ⚠️错误=${stats.errors}`);
  } else {
    // 只检查未知订单，已识别的直接保留
    orders = sourceOrders.map(o => ({ ...o }));
    stats = {
      total: orders.filter(o => o.invoiceType === 'unknown').length,
      checked: 0,
      company: orders.filter(o => o.invoiceType === 'company').length,
      personal: orders.filter(o => o.invoiceType === 'personal').length,
      noInvoice: 0,
      hasInvoiceUnknown: 0,
      stillUnknown: 0,
      errors: 0,
      skipped: orders.filter(o => o.invoiceType !== 'unknown').length,
    };
    console.log(`\n🎯 需要检查: ${stats.total} 个未知订单（跳过 ${stats.skipped} 个已识别）`);
  }

  // 3. 启动持久化浏览器
  console.log('\n🌐 启动浏览器（持久化模式）...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    slowMo: 200,
  });

  const page = context.pages()[0] || await context.newPage();

  // 4. 先访问订单列表页验证登录
  console.log('📄 验证登录状态...');
  await page.goto('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await sleep(3000);

  let currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('havanaone')) {
    console.log('\n⚠️  需要登录！请在浏览器中扫码登录...');
    try {
      await page.waitForFunction(
        () => !location.href.includes('login.taobao.com') && !location.href.includes('havanaone'),
        { timeout: 180000 }
      );
      console.log('✅ 登录成功！');
      await page.goto('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', {
        waitUntil: 'domcontentloaded', timeout: 60000,
      });
      await sleep(2000);
    } catch (e) {
      console.error('❌ 登录超时，退出');
      await context.close();
      process.exit(1);
    }
  } else {
    console.log('✅ 已登录');
  }

  // 关闭弹窗
  try { await page.click('text=知道了', { timeout: 2000 }); await sleep(500); } catch (e) {}

  // 5. 开始逐个检查
  const unknownOrders = orders.filter(o => o.invoiceType === 'unknown');
  const startIndex = progress ? unknownOrders.findIndex(o => !o._checked) : 0;
  const startIdx = Math.max(0, startIndex);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 开始检查（从第 ${startIdx + 1} 个开始，共 ${unknownOrders.length} 个）`);
  console.log(`   间隔: ${DELAY_MIN/1000}-${DELAY_MAX/1000}秒 | 超时: ${PAGE_TIMEOUT/1000}秒 | 每批回列表: ${BATCH_SIZE}`);
  console.log('='.repeat(60));

  let batchCount = 0;

  for (let i = startIdx; i < unknownOrders.length; i++) {
    const order = unknownOrders[i];

    // 已检查过则跳过
    if (order._checked) continue;

    // 每批回到列表页刷新session
    if (batchCount > 0 && batchCount % BATCH_SIZE === 0) {
      console.log(`\n🔄 刷新session（已检查 ${batchCount} 个）...`);
      await page.goto('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await sleep(2000);
      try { await page.click('text=知道了', { timeout: 2000 }); await sleep(500); } catch (e) {}
    }

    // 重试逻辑
    let info = null;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      info = await extractInvoiceFromDetail(page, order.orderId);

      if (info.invoiceType !== 'error') break;

      if (retry < MAX_RETRIES) {
        console.log(`   ⚠️  重试 ${retry + 1}/${MAX_RETRIES}...`);
        await sleep(3000);
      }
    }

    // 更新订单信息
    order.invoiceType = info.invoiceType;
    order.invoiceTitle = info.invoiceTitle;
    order.confidence = info.confidence;
    order._checked = true;

    // 更新统计
    stats.checked++;
    switch (info.invoiceType) {
      case 'company': stats.company++; break;
      case 'personal': stats.personal++; break;
      case 'no_invoice': stats.noInvoice++; break;
      case 'has_invoice_unknown': stats.hasInvoiceUnknown++; break;
      case 'error': stats.errors++; break;
      default: stats.stillUnknown++; break;
    }

    const icon = info.invoiceType === 'company' ? '🏢' :
                 info.invoiceType === 'personal' ? '👤' :
                 info.invoiceType === 'no_invoice' ? '📭' :
                 info.invoiceType === 'error' ? '⚠️' : '❓';

    const pct = ((stats.checked / stats.total) * 100).toFixed(1);
    console.log(`  [${stats.checked}/${stats.total} ${pct}%] ${icon} ${order.orderId} → ${info.invoiceTitle || '未识别'}`);

    // 每个订单后保存进度
    saveProgress(orders, stats);
    batchCount++;

    // 节流
    await randomDelay();
  }

  // 6. 合并结果 & 输出
  console.log('\n' + '='.repeat(60));
  console.log('📊 检查完成！最终统计');
  console.log('='.repeat(60));

  const finalCompany = orders.filter(o => o.invoiceType === 'company');
  const finalPersonal = orders.filter(o => o.invoiceType === 'personal');
  const finalNoInvoice = orders.filter(o => o.invoiceType === 'no_invoice');
  const finalUnknown = orders.filter(o => o.invoiceType === 'unknown' || o.invoiceType === 'has_invoice_unknown');
  const finalErrors = orders.filter(o => o.invoiceType === 'error');

  console.log(`\n  🏢 公司发票：${finalCompany.length} 个`);
  console.log(`  👤 个人发票：${finalPersonal.length} 个`);
  console.log(`  📭 未开票：${finalNoInvoice.length} 个`);
  console.log(`  ❓ 未识别：${finalUnknown.length} 个`);
  console.log(`  ⚠️  访问失败：${finalErrors.length} 个`);
  console.log(`  📋 总计：${orders.length} 个`);

  // 输出公司发票订单列表
  if (finalCompany.length > 0) {
    console.log('\n🏢 公司发票订单:');
    finalCompany.forEach(o => console.log(`   ${o.orderId} | ${o.invoiceTitle}`));
  }

  // 输出个人发票订单列表
  if (finalPersonal.length > 0) {
    console.log('\n👤 个人发票订单（需换开）:');
    finalPersonal.forEach(o => console.log(`   ${o.orderId} | ${o.invoiceTitle}`));
  }

  // 保存最终结果
  const result = {
    extractTime: new Date().toISOString(),
    version: '13.0',
    sourceVersion: '10.0',
    platform: 'taobao',
    totalOrders: orders.length,
    companyCount: finalCompany.length,
    personalCount: finalPersonal.length,
    noInvoiceCount: finalNoInvoice.length,
    unknownCount: finalUnknown.length,
    errorCount: finalErrors.length,
    companyOrders: finalCompany.map(o => ({ orderId: o.orderId, invoiceTitle: o.invoiceTitle })),
    personalOrders: finalPersonal.map(o => ({ orderId: o.orderId, invoiceTitle: o.invoiceTitle })),
    orders: orders.map(o => {
      const { _checked, confidence, ...rest } = o;
      return { ...rest, confidence };
    }),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n💾 最终结果已保存: ${OUTPUT_FILE}`);

  // 不关闭浏览器，方便后续检查
  console.log('\n✅ 浏览器保持打开，手动关闭即可');
  console.log('   按 Ctrl+C 退出\n');

  await new Promise(() => {});
}

main().catch(e => {
  console.error('❌ 致命错误:', e.message);
  process.exit(1);
});
