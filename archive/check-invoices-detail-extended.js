// v14.0 - 淘宝发票详情检查（修复版）
// 修复：使用正确的bizOrderId + 正确的详情页URL格式
// 特性：持久化浏览器 + 断点续传 + 节流防风控
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');
const INPUT_FILE = path.join(__dirname, 'invoices-v10.json');
const PROGRESS_FILE = path.join(__dirname, 'invoices-progress-v14.json');
const OUTPUT_FILE = path.join(__dirname, 'invoices-final.json');
const LIST_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';

const DELAY_MIN = 2000;
const DELAY_MAX = 4000;
const PAGE_TIMEOUT = 25000;
const BATCH_REFRESH = 15;  // 每查15个订单回到列表页刷新session

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  return sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
}

// 加载/保存进度
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch (e) {}
  }
  return null;
}

function saveProgress(data) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ========== 第一步：从列表页提取 bizOrderId 映射 ==========
async function extractBizOrderIds(context, page) {
  console.log('\n📋 第一步：从列表页提取 bizOrderId 映射...');

  const allMappings = [];
  let currentPage = 1;
  const maxPages = 8;

  while (currentPage <= maxPages) {
    console.log(`  第 ${currentPage} 页...`);
    await page.waitForSelector('body', { timeout: 15000 });
    await sleep(2000);

    // 关闭弹窗
    try { await page.click('text=知道了', { timeout: 2000 }); await sleep(500); } catch (e) {}

    // 从链接中提取 bizOrderId 映射
    const mappings = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]');

      const seen = new Set();
      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        let bizOrderId = null;
        let platform = null;

        // 天猫格式
        const tmallMatch = href.match(/bizOrderId=(\d+)/);
        if (tmallMatch) {
          bizOrderId = tmallMatch[1];
          platform = 'tmall';
        }

        // 淘宝格式
        const taobaoMatch = href.match(/biz_order_id=(\d+)/);
        if (taobaoMatch) {
          bizOrderId = taobaoMatch[1];
          platform = 'taobao';
        }

        if (bizOrderId && !seen.has(bizOrderId)) {
          seen.add(bizOrderId);
          results.push({ bizOrderId, platform, url: href.startsWith('//') ? 'https:' + href : href });
        }
      });

      return results;
    });

    console.log(`    找到 ${mappings.length} 个 bizOrderId`);
    allMappings.push(...mappings);

    // 翻页
    if (currentPage < maxPages) {
      try {
        await page.click('text=下一页', { timeout: 3000 });
        await sleep(3500);
      } catch (e) {
        console.log('    未找到下一页，停止');
        break;
      }
    }
    currentPage++;
  }

  // 去重
  const seen = new Set();
  const unique = allMappings.filter(m => {
    if (seen.has(m.bizOrderId)) return false;
    seen.add(m.bizOrderId);
    return true;
  });

  console.log(`  总计: ${unique.length} 个唯一 bizOrderId（天猫: ${unique.filter(m => m.platform === 'tmall').length}, 淘宝: ${unique.filter(m => m.platform === 'taobao').length}）`);
  return unique;
}

// ========== 第二步：访问详情页提取发票信息 ==========
async function extractInvoiceFromDetail(page, mapping) {
  const url = mapping.url;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(2000);

    // 关闭可能出现的弹窗
    try { await page.click('text=知道了', { timeout: 1500 }); } catch (e) {}

    const info = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';

      // 1. 明确的公司发票
      if (/发票抬头.*(公司|有限|企业|集团)|发票类型.*(企业|增值税)|抬头类型.*企业/.test(bodyText)) {
        const titleMatch = bodyText.match(/发票抬头[：:\s]*([^\n\r]{2,40})/);
        return { invoiceType: 'company', invoiceTitle: titleMatch ? `企业-${titleMatch[1].trim()}` : '企业', confidence: 'high' };
      }

      // 2. 发票抬头区域
      const titleMatch = bodyText.match(/发票抬头[：:\s]*([^\n\r]{2,40})/);
      if (titleMatch) {
        const title = titleMatch[1].trim();
        if (title.includes('企业') || title.includes('公司') || title.includes('有限') || title.includes('集团')) {
          return { invoiceType: 'company', invoiceTitle: `企业-${title}`, confidence: 'high' };
        }
        if (title.includes('个人')) {
          return { invoiceType: 'personal', invoiceTitle: `个人-${title}`, confidence: 'high' };
        }
      }

      // 3. 发票类型区域
      const typeMatch = bodyText.match(/发票类型[：:\s]*([^\n\r]{2,20})/);
      if (typeMatch) {
        const type = typeMatch[1].trim();
        if (type.includes('企业') || type.includes('公司') || type.includes('增值税')) {
          return { invoiceType: 'company', invoiceTitle: type, confidence: 'high' };
        }
        if (type.includes('个人')) {
          return { invoiceType: 'personal', invoiceTitle: type, confidence: 'high' };
        }
      }

      // 4. 在发票区域搜索关键词
      // 找"发票"附近200字的上下文
      const invoiceAreas = [];
      let idx = 0;
      while ((idx = bodyText.indexOf('发票', idx)) !== -1) {
        invoiceAreas.push(bodyText.substring(Math.max(0, idx - 50), Math.min(bodyText.length, idx + 150)));
        idx++;
        if (invoiceAreas.length >= 5) break;
      }

      const invoiceText = invoiceAreas.join(' ');
      if (invoiceText.includes('企业') || invoiceText.includes('公司') || invoiceText.includes('公司')) {
        return { invoiceType: 'company', invoiceTitle: '企业发票（从上下文推断）', confidence: 'medium' };
      }
      if (invoiceText.includes('个人')) {
        return { invoiceType: 'personal', invoiceTitle: '个人发票', confidence: 'medium' };
      }

      // 5. 检查是否"申请开票"（未开票）
      if (bodyText.includes('申请开票') || bodyText.includes('暂未开票') || bodyText.includes('未开票')) {
        return { invoiceType: 'no_invoice', invoiceTitle: '未开票', confidence: 'high' };
      }

      // 6. 有"查看发票"但类型未定
      if (bodyText.includes('查看发票') || bodyText.includes('发票详情')) {
        return { invoiceType: 'has_invoice_unknown', invoiceTitle: '有发票-类型未确定', confidence: 'low' };
      }

      // 7. 页面上没有发票信息
      return { invoiceType: 'no_invoice_info', invoiceTitle: '页面无发票信息', confidence: 'none' };
    });

    // 附加：如果还是未确定，把发票区域文本也保存下来供人工判断
    if (info.confidence === 'none' || info.confidence === 'low') {
      const invoiceSnippets = await page.evaluate(() => {
        const body = document.body.innerText;
        const results = [];
        for (const kw of ['发票', '开票', '抬头', '税号']) {
          let i = 0;
          while ((i = body.indexOf(kw, i)) !== -1) {
            results.push(body.substring(Math.max(0, i - 30), Math.min(body.length, i + 80)));
            i++;
            if (results.length >= 8) break;
          }
        }
        return results;
      });
      info.invoiceSnippets = invoiceSnippets;
    }

    return info;
  } catch (e) {
    return { invoiceType: 'error', invoiceTitle: `访问失败: ${e.message.slice(0, 80)}`, confidence: 'none' };
  }
}

// ========== 主函数 ==========
async function main() {
  console.log('='.repeat(60));
  console.log('🔍 淘宝发票详情检查 v14.0（修复版）');
  console.log('   正确的 bizOrderId + 详情页URL + 断点续传');
  console.log('='.repeat(60));

  // 加载源数据
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ 找不到源数据: ${INPUT_FILE}`);
    process.exit(1);
  }
  const sourceData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`\n📂 源数据: ${sourceData.orders.length} 个订单`);

  // 加载进度
  const progress = loadProgress();
  let bizOrderMappings, stats, checkedSet;

  if (progress && progress.bizOrderMappings) {
    bizOrderMappings = progress.bizOrderMappings;
    stats = progress.stats;
    checkedSet = new Set(progress.checkedBizIds || []);
    console.log(`📂 恢复进度: 已检查 ${checkedSet.size}/${bizOrderMappings.length}`);
  } else {
    bizOrderMappings = null;
    stats = { total: 0, checked: 0, company: 0, personal: 0, noInvoice: 0, hasInvoiceUnknown: 0, noInvoiceInfo: 0, errors: 0 };
    checkedSet = new Set();
  }

  // 启动浏览器
  console.log('\n🌐 启动浏览器...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    slowMo: 200,
  });

  const page = context.pages()[0] || await context.newPage();

  // 访问列表页验证登录
  console.log('📄 验证登录...');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  let currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('havanaone')) {
    console.log('\n⚠️  需要登录！请在浏览器中扫码...');
    try {
      await page.waitForFunction(
        () => !location.href.includes('login.taobao.com') && !location.href.includes('havanaone'),
        { timeout: 180000 }
      );
      console.log('✅ 登录成功！');
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
    } catch (e) {
      console.error('❌ 登录超时');
      await context.close();
      process.exit(1);
    }
  } else {
    console.log('✅ 已登录');
  }

  // 第一步：提取 bizOrderId 映射（如果没有进度或映射为空）
  if (!bizOrderMappings) {
    bizOrderMappings = await extractBizOrderIds(context, page);
    stats.total = bizOrderMappings.length;

    // 保存映射
    saveProgress({ bizOrderMappings, stats, checkedBizIds: [] });
  }

  // 第二步：逐个访问详情页
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 开始检查详情页（共 ${bizOrderMappings.length} 个）`);
  console.log('='.repeat(60));

  let batchCount = 0;
  const results = progress?.results || {};

  for (let i = 0; i < bizOrderMappings.length; i++) {
    const mapping = bizOrderMappings[i];

    if (checkedSet.has(mapping.bizOrderId)) continue;

    // 每批回到列表页刷新session
    if (batchCount > 0 && batchCount % BATCH_REFRESH === 0) {
      console.log(`\n🔄 刷新session（已检查 ${batchCount} 个）...`);
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      try { await page.click('text=知道了', { timeout: 2000 }); } catch (e) {}
    }

    // 访问详情页
    const info = await extractInvoiceFromDetail(page, mapping);

    // 更新统计
    stats.checked++;
    switch (info.invoiceType) {
      case 'company': stats.company++; break;
      case 'personal': stats.personal++; break;
      case 'no_invoice': stats.noInvoice++; break;
      case 'has_invoice_unknown': stats.hasInvoiceUnknown++; break;
      case 'no_invoice_info': stats.noInvoiceInfo++; break;
      case 'error': stats.errors++; break;
    }

    checkedSet.add(mapping.bizOrderId);
    results[mapping.bizOrderId] = {
      ...info,
      platform: mapping.platform,
      checkedAt: new Date().toISOString(),
    };

    const icon = info.invoiceType === 'company' ? '🏢' :
                 info.invoiceType === 'personal' ? '👤' :
                 info.invoiceType === 'no_invoice' ? '📭' :
                 info.invoiceType === 'error' ? '⚠️' : '❓';

    const pct = ((stats.checked / stats.total) * 100).toFixed(1);
    console.log(`  [${stats.checked}/${stats.total} ${pct}%] ${icon} ${mapping.bizOrderId} (${mapping.platform}) → ${info.invoiceTitle || info.invoiceType}`);

    // 保存进度
    saveProgress({
      bizOrderMappings,
      stats,
      checkedBizIds: [...checkedSet],
      results,
    });

    batchCount++;
    await randomDelay();
  }

  // 输出最终统计
  console.log('\n' + '='.repeat(60));
  console.log('📊 检查完成！');
  console.log('='.repeat(60));
  console.log(`  🏢 公司发票：${stats.company}`);
  console.log(`  👤 个人发票：${stats.personal}`);
  console.log(`  📭 未开票：${stats.noInvoice}`);
  console.log(`  ❓ 有发票类型未知：${stats.hasInvoiceUnknown}`);
  console.log(`  📄 页面无发票信息：${stats.noInvoiceInfo}`);
  console.log(`  ⚠️  访问失败：${stats.errors}`);
  console.log(`  📋 总计：${stats.total}`);

  // 生成最终结果
  const finalResult = {
    extractTime: new Date().toISOString(),
    version: '14.0',
    platform: 'taobao',
    stats,
    companyOrders: Object.entries(results).filter(([, v]) => v.invoiceType === 'company').map(([k, v]) => ({ bizOrderId: k, ...v })),
    personalOrders: Object.entries(results).filter(([, v]) => v.invoiceType === 'personal').map(([k, v]) => ({ bizOrderId: k, ...v })),
    noInvoiceOrders: Object.entries(results).filter(([, v]) => v.invoiceType === 'no_invoice').map(([k, v]) => ({ bizOrderId: k, ...v })),
    results,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalResult, null, 2), 'utf8');
  console.log(`\n💾 最终结果: ${OUTPUT_FILE}`);

  console.log('\n✅ 浏览器保持打开，手动关闭即可');
  await new Promise(() => {});
}

main().catch(e => {
  console.error('❌ 致命错误:', e.message);
  process.exit(1);
});
