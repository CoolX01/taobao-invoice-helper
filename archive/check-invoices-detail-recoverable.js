// v15.2 - 淘宝发票详情检查（保守识别 + 可恢复进度 + 安全测试入口）
// 改进：登录检测、SIGINT保存、失败项重试、测试模式统计、保守发票类型判断
// 解决中文乱码
process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ========== 命令行参数解析 ==========
function parseArgs() {
  const args = {
    test: null,      // 测试模式：处理前 N 个订单
    output: null,     // 输出文件
    progress: null,   // 进度文件
    input: null,       // 输入文件
    fresh: false,      // 忽略已有进度
    retryUncertain: false, // 重跑低置信/无信息记录
    closeOnFinish: false   // 完成后关闭浏览器，便于自动化测试
  };
  
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      if (arg === '--fresh') {
        args.fresh = true;
        continue;
      }
      if (arg === '--retry-uncertain') {
        args.retryUncertain = true;
        continue;
      }
      if (arg === '--close-on-finish') {
        args.closeOnFinish = true;
        continue;
      }
      const [key, value] = arg.slice(2).split('=');
      if (key === 'test') {
        args.test = parseInt(value) || null;
      } else if (key === 'output') {
        args.output = value;
      } else if (key === 'progress') {
        args.progress = value;
      } else if (key === 'input') {
        args.input = value;
      }
    }
  }
  
  return args;
}

const cliArgs = parseArgs();

// ========== 配置（集中管理，消除魔法数字）==========
function safeRelativePath(value, fallback) {
  if (!value) return fallback;
  if (path.isAbsolute(value) || value.includes('..')) {
    throw new Error(`不允许使用项目目录外的路径: ${value}`);
  }
  return path.join(__dirname, value);
}

const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');
const INPUT_FILE = safeRelativePath(cliArgs.input, path.join(__dirname, 'invoices-v10.json'));
const PROGRESS_FILE = safeRelativePath(cliArgs.progress, path.join(__dirname, 'invoices-progress-v15.json'));
const OUTPUT_FILE = safeRelativePath(cliArgs.output, path.join(__dirname, 'invoices-final-v15.json'));
const LIST_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';

const CONFIG = {
  delayMin: 2000,
  delayMax: 4000,
  pageTimeout: 60000,  // 增加到60秒
  batchRefresh: 15,
  gotoTimeout: 90000,   // 增加到90秒
  listWaitTimeout: 20000,
  detailWaitTimeout: 30000,
  loginWaitTimeout: 180000,
  maxRetries: 3,  // 新增：最大重试次数
};

const LOGIN_URL_MARKERS = [
  'login',
  'havanaone',
  'havanone',
  'passport.taobao.com',
  'login.taobao.com',
  'havanalogin',
];
const STATS_KEYS = ['company', 'personal', 'noInvoice', 'hasInvoiceUnknown', 'noInvoiceInfo', 'errors'];
const RETRYABLE_TYPES = new Set(['error']);
const UNCERTAIN_TYPES = new Set(['has_invoice_unknown', 'no_invoice_info']);

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  const { delayMin, delayMax } = CONFIG;
  return sleep(delayMin + Math.random() * (delayMax - delayMin));
}

function createEmptyStats(total = 0) {
  return {
    total,
    checked: 0,
    company: 0,
    personal: 0,
    noInvoice: 0,
    hasInvoiceUnknown: 0,
    noInvoiceInfo: 0,
    errors: 0,
  };
}

function isLoginOrVerifyUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return LOGIN_URL_MARKERS.some(marker => normalized.includes(marker));
}

function isRetryableResult(result) {
  if (!result) return true;
  if (RETRYABLE_TYPES.has(result.invoiceType)) return true;
  if (cliArgs.retryUncertain && UNCERTAIN_TYPES.has(result.invoiceType)) return true;
  return false;
}

function countStats(results, mappings) {
  const stats = createEmptyStats(mappings.length);
  const validIds = new Set(mappings.map(m => m.bizOrderId));
  for (const [bizOrderId, result] of Object.entries(results)) {
    if (!validIds.has(bizOrderId) || isRetryableResult(result)) continue;
    stats.checked++;
    switch (result.invoiceType) {
      case 'company': stats.company++; break;
      case 'personal': stats.personal++; break;
      case 'no_invoice': stats.noInvoice++; break;
      case 'has_invoice_unknown': stats.hasInvoiceUnknown++; break;
      case 'no_invoice_info': stats.noInvoiceInfo++; break;
      case 'error': stats.errors++; break;
    }
  }
  return stats;
}

// ========== 进度管理（修复：安全访问）==========
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      // 校验数据结构
      if (data && typeof data === 'object') {
        return data;
      }
    } catch (e) {
      console.error('⚠️  进度文件损坏，从头开始', e.message);
    }
  }
  return null;
}

function saveProgress(data) {
  try {
    const tmpFile = `${PROGRESS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpFile, PROGRESS_FILE);
  } catch (e) {
    console.error('⚠️  保存进度失败:', e.message);
  }
}

// ========== 第一步：从列表页提取 bizOrderId 映射 ==========
async function extractBizOrderIds(context, page) {
  console.log('\n📋 第一步：从列表页提取 bizOrderId 映射...');

  const allMappings = [];
  let currentPage = 1;
  const maxPages = 8;

  while (currentPage <= maxPages) {
    console.log(`  第 ${currentPage} 页...`);
    await page.waitForSelector('body', { timeout: CONFIG.listWaitTimeout });
    await sleep(2000);

    try { await page.click('text=知道了', { timeout: 2000 }); await sleep(500); } catch (e) {}

    const mappings = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]');
      const seen = new Set();
      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        let bizOrderId = null;
        let platform = null;
        const tmallMatch = href.match(/bizOrderId=(\d+)/);
        if (tmallMatch) {
          bizOrderId = tmallMatch[1];
          platform = 'tmall';
        }
        const taobaoMatch = href.match(/biz_order_id=(\d+)/);
        if (taobaoMatch) {
          bizOrderId = taobaoMatch[1];
          platform = 'taobao';
        }
        if (bizOrderId && !seen.has(bizOrderId)) {
          seen.add(bizOrderId);
          const absoluteUrl = new URL(href.startsWith('//') ? `https:${href}` : href, location.href).href;
          results.push({ bizOrderId, platform, url: absoluteUrl });
        }
      });
      return results;
    });

    console.log(`    找到 ${mappings.length} 个 bizOrderId`);
    allMappings.push(...mappings);

    if (currentPage < maxPages) {
      try {
        const beforeIds = mappings.map(m => m.bizOrderId).sort().join(',');
        await page.click('text=下一页', { timeout: 3000 });
        await page.waitForFunction((previousIds) => {
          const links = document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]');
          const ids = [];
          links.forEach(link => {
            const href = link.getAttribute('href') || '';
            const match = href.match(/bizOrderId=(\d+)/) || href.match(/biz_order_id=(\d+)/);
            if (match) ids.push(match[1]);
          });
          return ids.length > 0 && [...new Set(ids)].sort().join(',') !== previousIds;
        }, beforeIds, { timeout: 10000 }).catch(() => null);
        await sleep(1000);
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

// ========== 第二步：访问详情页提取发票信息（改进检测逻辑）==========
async function extractInvoiceFromDetail(page, mapping) {
  let lastError = null;
  
  // 添加重试逻辑
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      // 改进1：使用 networkidle 等待异步内容加载
      await page.goto(mapping.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
      await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
      await sleep(2000);
      lastError = null;
      break;  // 成功则跳出重试循环
    } catch (e) {
      lastError = e;
      if (attempt < CONFIG.maxRetries) {
        console.log(`    重试 ${attempt}/${CONFIG.maxRetries}...`);
        await sleep(3000 * attempt);  // 递增延迟
      }
    }
  }
  
  if (lastError) {
    return { invoiceType: 'error', error: `页面加载失败(重试${CONFIG.maxRetries}次): ${lastError.message}` };
  }
  
  try {
    // 关闭弹窗
    try { await page.click('text=知道了', { timeout: 1500 }); } catch (e) {}

    // 改进2：尝试点击"查看发票"按钮（发票信息可能在展开区域）
    try {
      await page.click('text=查看发票', { timeout: 2000 });
      await sleep(1500);
    } catch (e) {}
    try {
      await page.click('text=发票详情', { timeout: 1000 });
      await sleep(1000);
    } catch (e) {}

    const info = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const normalizedText = bodyText.replace(/\s+/g, ' ');
      const companyTitleKeywords = ['公司', '有限', '企业', '集团', '中心', '工作室', '事务所', '研究院', '学校', '大学', '医院', '银行'];

      function matchField(labels, maxLen) {
        for (const label of labels) {
          const pattern = new RegExp(`${label}[：:\\s]*([^\\n\\r]{1,${maxLen}})`);
          const match = bodyText.match(pattern);
          if (match && match[1]) return match[1].trim();
        }
        return '';
      }

      function classifyTitle(title) {
        if (!title) return null;
        if (/^(个人|个人用户|个人消费者)$/.test(title) || title.includes('个人')) {
          return { invoiceType: 'personal', invoiceTitle: `个人-${title}`, confidence: 'high', evidence: 'invoice_title' };
        }
        if (companyTitleKeywords.some(keyword => title.includes(keyword)) || title.length >= 6) {
          return { invoiceType: 'company', invoiceTitle: `企业-${title}`, confidence: 'high', evidence: 'invoice_title_keyword' };
        }
        return null;
      }

      // 1. 明确发票字段：只信任抬头/购买方等字段，不把卖家或店铺公司名当成发票抬头。
      const title = matchField(['发票抬头', '抬头名称', '购买方名称', '购方名称', '购买方', '抬头'], 60);
      const titleInfo = classifyTitle(title);
      if (titleInfo) {
        return titleInfo;
      }

      // 2. 发票类型字段只用于识别个人/企业类型，不用于确认目标公司抬头。
      const type = matchField(['抬头类型', '发票类型', '发票性质'], 30);
      if (type.includes('个人')) {
        return { invoiceType: 'personal', invoiceTitle: `个人-${type}`, confidence: 'high', evidence: 'invoice_type' };
      }
      if (type.includes('企业') || type.includes('单位')) {
        return { invoiceType: 'has_invoice_unknown', invoiceTitle: `企业类型-${type}`, confidence: 'low', evidence: 'invoice_type_without_title' };
      }

      // 3. 未开票状态优先识别，但不默认当个人票。
      if (bodyText.includes('申请开票') || bodyText.includes('暂未开票') || bodyText.includes('未开票')) {
        return { invoiceType: 'no_invoice', invoiceTitle: '未开票', confidence: 'high', evidence: 'apply_invoice_text' };
      }

      // 4. 关键词上下文只作为低置信证据，不能直接判公司/个人。
      const invoiceKeywords = ['发票', '开票', '抬头', '税号', '纳税人', '增值税'];
      let invoiceText = '';
      for (const kw of invoiceKeywords) {
        let idx = 0;
        while ((idx = bodyText.indexOf(kw, idx)) !== -1) {
          invoiceText += bodyText.substring(Math.max(0, idx - 80), Math.min(bodyText.length, idx + 200)) + ' ';
          idx++;
          if (invoiceText.length > 2000) break; // 防止过大
        }
      }

      if (invoiceText.length > 0 || normalizedText.includes('查看发票') || normalizedText.includes('发票详情')) {
        return {
          invoiceType: 'has_invoice_unknown',
          invoiceTitle: '有发票信息-类型需人工确认',
          confidence: 'low',
          evidence: 'invoice_context',
        };
      }

      // 5. 页面上没有发票信息
      return { invoiceType: 'no_invoice_info', invoiceTitle: '页面无发票信息', confidence: 'none', evidence: 'no_invoice_text' };
    });

    // 附加：保存关键词上下文供人工判断
    if (info.confidence === 'none' || info.confidence === 'low') {
      const snippets = await page.evaluate(() => {
        const body = document.body.innerText;
        const results = [];
        const keywords = ['发票', '开票', '抬头', '税号', '纳税人', '增值税'];
        for (const kw of keywords) {
          let i = 0;
          while ((i = body.indexOf(kw, i)) !== -1) {
            results.push(body.substring(Math.max(0, i - 50), Math.min(body.length, i + 100)));
            i++;
            if (results.length >= 10) break;
          }
          if (results.length >= 10) break;
        }
        return results;
      });
      info.snippets = snippets;
    }

    return info;
  } catch (e) {
    return { invoiceType: 'error', invoiceTitle: `访问失败: ${e.message.slice(0, 80)}`, confidence: 'none' };
  }
}

// ========== 主函数 ==========
async function main() {
  console.log('='.repeat(60));
  console.log('🔍 淘宝发票详情检查 v15.2（保守识别 + 可恢复进度）');
  console.log('='.repeat(60));

  // 加载源数据
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ 找不到源数据: ${INPUT_FILE}`);
    process.exit(1);
  }
  const sourceData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`\n📂 源数据: ${sourceData.orders.length} 个订单`);

  // 加载进度（修复：安全访问）
  const progress = cliArgs.fresh ? null : loadProgress();
  let bizOrderMappings, stats, checkedSet;
  let results = (progress && progress.results && typeof progress.results === 'object') ? progress.results : {};

  if (progress && Array.isArray(progress.bizOrderMappings)) {
    bizOrderMappings = progress.bizOrderMappings;
    checkedSet = new Set(
      (Array.isArray(progress.checkedBizIds) ? progress.checkedBizIds : [])
        .filter(id => !isRetryableResult(results[id]))
    );
    stats = countStats(results, bizOrderMappings);
    console.log(`📂 恢复进度: 已确认 ${checkedSet.size}/${bizOrderMappings.length}，失败项会自动重试`);
  } else {
    bizOrderMappings = null;
    stats = createEmptyStats();
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

  // 改进4：SIGINT 处理（Ctrl+C 时保存进度并退出）
  let exiting = false;
  process.on('SIGINT', async () => {
    if (exiting) {
      console.log('\n强制退出...');
      await context.close();
      process.exit(1);
    }
    exiting = true;
    console.log('\n\n⚠️  收到退出信号，正在保存进度...');
    saveProgress({
      bizOrderMappings,
      stats,
      checkedBizIds: [...checkedSet],
      results,
    });
    await context.close();
    console.log('进度已保存，退出。');
    process.exit(0);
  });

  // 访问列表页验证登录
  console.log('📄 验证登录...');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeout });
  await sleep(3000);

  let currentUrl = page.url();
  if (isLoginOrVerifyUrl(currentUrl)) {
    console.log('\n⚠️  需要登录！请在浏览器中扫码...');
    try {
      await page.waitForFunction(
        (markers) => !markers.some(marker => location.href.toLowerCase().includes(marker)),
        LOGIN_URL_MARKERS,
        { timeout: CONFIG.loginWaitTimeout }
      );
      console.log('✅ 登录成功！');
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeout });
      await sleep(2000);
    } catch (e) {
      console.error('❌ 登录超时');
      await context.close();
      process.exit(1);
    }
  } else {
    console.log('✅ 已登录');
  }

  // 第一步：提取 bizOrderId 映射
  if (!bizOrderMappings) {
    bizOrderMappings = await extractBizOrderIds(context, page);
    stats.total = bizOrderMappings.length;
    saveProgress({ version: '15.2', bizOrderMappings, stats, checkedBizIds: [], results });
  }

  // 第二步：逐个访问详情页
  // 测试模式：仅处理前 N 个订单
  if (cliArgs.test && cliArgs.test > 0) {
    console.log(`\n⚠️  测试模式：仅处理前 ${cliArgs.test} 个订单`);
    bizOrderMappings = bizOrderMappings.slice(0, cliArgs.test);
    const testIds = new Set(bizOrderMappings.map(m => m.bizOrderId));
    results = Object.fromEntries(Object.entries(results).filter(([id]) => testIds.has(id)));
    checkedSet = new Set([...checkedSet].filter(id => testIds.has(id)));
  }
  stats = countStats(results, bizOrderMappings);
  for (const key of STATS_KEYS) {
    if (typeof stats[key] !== 'number') stats[key] = 0;
  }

  console.log('\n' + '='.repeat(60));
  console.log(`🚀 开始检查详情页（共 ${bizOrderMappings.length} 个）`);
  console.log('='.repeat(60));

  let batchCount = 0;

  for (let i = 0; i < bizOrderMappings.length; i++) {
    if (exiting) break;  // 响应 SIGINT

    const mapping = bizOrderMappings[i];
    if (checkedSet.has(mapping.bizOrderId)) continue;

    // 每批回到列表页刷新session
    if (batchCount > 0 && batchCount % CONFIG.batchRefresh === 0) {
      console.log(`\n🔄 刷新session（已检查 ${batchCount} 个）...`);
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeout });
      await sleep(2000);
      try { await page.click('text=知道了', { timeout: 2000 }); } catch (e) {}
    }

    // 访问详情页
    const info = await extractInvoiceFromDetail(page, mapping);

    // 更新统计
    stats = countStats(results, bizOrderMappings);
    switch (info.invoiceType) {
      case 'company': stats.company++; break;
      case 'personal': stats.personal++; break;
      case 'no_invoice': stats.noInvoice++; break;
      case 'has_invoice_unknown': stats.hasInvoiceUnknown++; break;
      case 'no_invoice_info': stats.noInvoiceInfo++; break;
      case 'error': stats.errors++; break;
    }
    stats.checked++;

    results[mapping.bizOrderId] = {
      ...info,
      platform: mapping.platform,
      checkedAt: new Date().toISOString(),
    };
    if (!isRetryableResult(results[mapping.bizOrderId])) {
      checkedSet.add(mapping.bizOrderId);
    } else {
      checkedSet.delete(mapping.bizOrderId);
    }

    const icon = info.invoiceType === 'company' ? '🏢' :
                   info.invoiceType === 'personal' ? '👤' :
                   info.invoiceType === 'no_invoice' ? '📭' :
                   info.invoiceType === 'error' ? '⚠️' : '❓';

    const pct = ((stats.checked / stats.total) * 100).toFixed(1);
    console.log(`  [${stats.checked}/${stats.total} ${pct}%] ${icon} ${mapping.bizOrderId} (${mapping.platform}) → ${info.invoiceTitle || info.invoiceType}`);

    // 保存进度
    saveProgress({
      version: '15.2',
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
    version: '15.2',
    platform: 'taobao',
    stats,
    companyOrders: Object.entries(results).filter(([, v]) => v.invoiceType === 'company').map(([k, v]) => ({ bizOrderId: k, ...v })),
    personalOrders: Object.entries(results).filter(([, v]) => v.invoiceType === 'personal').map(([k, v]) => ({ bizOrderId: k, ...v })),
    noInvoiceOrders: Object.entries(results).filter(([, v]) => v.invoiceType === 'no_invoice').map(([k, v]) => ({ bizOrderId: k, ...v })),
    results,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalResult, null, 2), 'utf8');
  console.log(`\n💾 最终结果: ${OUTPUT_FILE}`);

  if (cliArgs.closeOnFinish) {
    await context.close();
    console.log('\n✅ 完成，浏览器已关闭');
  } else {
    console.log('\n✅ 浏览器保持打开，手动关闭即可');
    await new Promise(() => {});
  }
}

main().catch(e => {
  console.error('❌ 致命错误:', e.message);
  process.exit(1);
});
