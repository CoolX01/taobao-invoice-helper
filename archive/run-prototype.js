// v12.0 - 淘宝发票提取（持久化浏览器模式）
// 使用 Persistent Context，复用同一个浏览器窗口和登录状态
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 配置
const ORDER_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const USER_DATA_DIR = path.join(__dirname, '.playwright-browser'); // 浏览器数据目录（持久化）
const RESULT_FILE = path.join(__dirname, 'invoices-v12.json');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 提取当前页面的订单信息  
async function extractOrders(page, pageNum) {
  const orders = await page.evaluate(() => {
    const results = [];
    const bodyText = document.body.innerText;
    
    const orderIdMatches = bodyText.match(/\d{18}/g);
    
    if (!orderIdMatches || orderIdMatches.length === 0) {
      return results;
    }
    
    const uniqueOrderIds = [...new Set(orderIdMatches)];
    
    uniqueOrderIds.forEach((orderId, index) => {
      const pos = bodyText.indexOf(orderId);
      const start = Math.max(0, pos - 300);
      const end = Math.min(bodyText.length, pos + 300);
      const contextText = bodyText.substring(start, end);
      
      let invoiceType = 'unknown';
      let invoiceTitle = '';
      
      if (contextText.includes('企业') || contextText.includes('公司') || contextText.includes('有限') || contextText.includes('集团')) {
        invoiceType = 'company';
        invoiceTitle = '企业';
      } else if (contextText.includes('个人')) {
        invoiceType = 'personal';
        invoiceTitle = '个人-个人';
      }
      
      results.push({
        index: index + 1,
        orderId,
        orderNumber: orderId,
        invoiceType,
        invoiceTitle,
        needsReissue: invoiceType === 'personal',
      });
    });
    
    return results;
  });
  
  return orders.map(o => ({ ...o, page: pageNum }));
}

// 主函数
async function main() {
  console.log('=' .repeat(60));
  console.log('🛒 淘宝发票提取工具 v12.0 (持久化模式)');
  console.log(`📂 浏览器数据: ${USER_DATA_DIR}`);
  console.log('='.repeat(60));

  // 确保用户数据目录存在
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    console.log('\n📁 首次运行，创建新的浏览器配置文件');
  }

  // 使用 Persistent Context - 复用同一个浏览器窗口！
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    slowMo: 300,
  });

  const page = context.pages()[0] || await context.newPage();
  
  try {
    // 打开订单页面
    console.log('\n📄 打开淘宝订单页面...');
    await page.goto(ORDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // 检查是否需要登录
    await sleep(3000);
    let currentUrl = page.url();
    
    if (currentUrl.includes('login') || currentUrl.includes('havanaone')) {
      console.log('\n⚠️  需要登录');
      console.log('   请在浏览器中完成扫码或密码登录...');
      
      try {
        await page.waitForFunction(
          () => !location.href.includes('login.taobao.com') && !location.href.includes('havanaone'),
          { timeout: 180000 }
        );
        console.log('   ✅ 登录成功！');
      } catch (e) {
        throw new Error('登录超时，请重试');
      }
      
      // 登录后重新进入订单页面
      await page.goto(ORDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
    } else {
      console.log('   ✅ 已登录，直接访问订单页面');
    }
    
    // 开始提取
    console.log('\n' + '='.repeat(60));
    console.log('📊 开始提取订单数据...');
    console.log('='.repeat(60));
    
    const allOrders = [];
    let currentPage = 1;
    const maxPages = 8;
    
    while (currentPage <= maxPages) {
      console.log(`\n📄 第 ${currentPage}/${maxPages} 页...`);
      
      try {
        await page.waitForSelector('body', { timeout: 15000 });
        await sleep(1500);
        
        // 关闭弹窗
        try {
          await page.click('text=知道了', { timeout: 2000 }).catch(() => {});
          await sleep(500);
        } catch (e) {}
      } catch (e) {
        console.log(`   ⚠️  页面加载超时，尝试继续`);
      }
      
      // 提取当前页订单
      const orders = await extractOrders(page, currentPage);
      
      // 分页去重检测
      if (currentPage > 1 && orders.length > 0 && allOrders.length > 0) {
        const lastPageIds = allOrders.slice(-orders.length).map(o => o.orderId);
        const currentPageIds = orders.map(o => o.orderId);
        const isSame = JSON.stringify(lastPageIds.sort()) === JSON.stringify(currentPageIds.sort());
        if (isSame) {
          console.log(`   ⚠️  订单与上一页相同，停止翻页`);
          break;
        }
      }
      
      console.log(`   找到 ${orders.length} 个订单`);
      
      orders.forEach(order => {
        const icon = order.invoiceType === 'company' ? '✅' : 
                     order.invoiceType === 'personal' ? '❌' : '❓';
        console.log(`   ${icon} ${order.orderId} | ${order.invoiceTitle || '未识别'}`);
      });
      
      allOrders.push(...orders);
      
      // 点击下一页
      if (currentPage < maxPages) {
        let foundNext = false;
        
        try {
          await page.click('text=下一页', { timeout: 3000 });
          foundNext = true;
          console.log(`   ➡️  点击"下一页"`);
        } catch (e) {}
        
        if (!foundNext) {
          console.log(`   ⏹️  未找到下一页按钮，停止`);
          break;
        }
        
        await sleep(3500);
      }
      
      currentPage++;
    }
    
    // 输出统计
    console.log('\n' + '='.repeat(60));
    console.log('📊 提取完成！');
    console.log('='.repeat(60));
    
    const companyOrders = allOrders.filter(o => o.invoiceType === 'company');
    const personalOrders = allOrders.filter(o => o.invoiceType === 'personal');
    const unknownOrders = allOrders.filter(o => o.invoiceType === 'unknown');
    
    console.log(`\n✅ 公司发票：${companyOrders.length} 个`);
    console.log(`❌ 个人发票：${personalOrders.length} 个`);
    console.log(`❓ 未识别：${unknownOrders.length} 个`);
    console.log(`📋 总计：${allOrders.length} 个订单`);
    
    const orderIds = allOrders.map(o => o.orderId).filter(Boolean);
    const uniqueIds = [...new Set(orderIds)];
    console.log(`\n🔍 去重检查：${orderIds.length} / ${uniqueIds.length} (${orderIds.length !== uniqueIds.length ? '⚠️有重复' : '✅无重复'})`);
    
    // 保存结果
    const result = {
      extractTime: new Date().toISOString(),
      version: '12.0',
      platform: 'taobao',
      totalOrders: allOrders.length,
      companyCount: companyOrders.length,
      personalCount: personalOrders.length,
      unknownCount: unknownOrders.length,
      hasDuplicate: orderIds.length !== uniqueIds.length,
      orders: allOrders,
    };
    
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
    console.log(`\n💾 结果已保存到：${RESULT_FILE}`);
    
    // 不关闭浏览器！保持打开状态方便后续调试
    console.log('\n✅ 完成！浏览器窗口保持打开，可继续调试');
    console.log('   按 Ctrl+C 或关闭窗口退出\n');
    
    // 保持进程运行，不自动关闭浏览器
    await new Promise(() => {}); // 永久等待
    
  } catch (error) {
    console.error('❌ 错误:', error.message);
    await page.screenshot({ path: 'error-screenshot.png' }).catch(() => {});
  } finally {
    // 注意：这里不关闭浏览器！
    // 用户手动关闭浏览器窗口即可
    // await context.close();
  }
}

main();
