// v11.0 - 增强版：进入订单详情页检查发票类型
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ORDER_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const COOKIE_FILE = path.join(__dirname, 'taobao-cookies.json');
const INPUT_FILE = path.join(__dirname, 'invoices-v10.json'); // v10的结果
const OUTPUT_FILE = path.join(__dirname, 'invoices-v11.json');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=' .repeat(60));
  console.log('🔍 淘宝发票详情检测 v11.0');
  console.log('📋 目标：进入每个订单详情，确认公司/个人发票类型');
  console.log('='.repeat(60));

  // 读取v10结果
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ 找不到输入文件: ${INPUT_FILE}`);
    process.exit(1);
  }
  
  const v10Data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const orders = v10Data.orders;
  
  console.log(`\n📊 输入数据: ${orders.length} 个订单`);
  console.log(`   - 公司发票: ${v10Data.companyCount} 个`);
  console.log(`   - 未识别: ${v10Data.unknownCount} 个`);
  
  // 启动浏览器
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  
  // 加载cookie
  if (fs.existsSync(COOKIE_FILE)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    await context.addCookies(cookies);
    console.log('\n✅ Cookie已加载');
  }

  const page = await context.newPage();
  await page.goto(ORDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  // 只处理"未知"的订单（减少请求次数）
  const unknownOrders = orders.filter(o => o.invoiceType === 'unknown');
  console.log(`\n🔍 需要检查 ${unknownOrders.length} 个未识别订单...`);

  let checkedCount = 0;
  let companyFound = 0;
  let personalFound = 0;

  for (let i = 0; i < unknownOrders.length; i++) {
    const order = unknownOrders[i];
    
    // 每20个订单刷新一次页面，避免session过期
    if (checkedCount > 0 && checkedCount % 20 === 0) {
      console.log('\n🔄 刷新页面...');
      await page.goto(ORDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
    }

    // 构建订单详情URL
    const detailUrl = `https://buyertrade.taobao.com/trade/detail/tradeItemDetail.htm?orderId=${order.orderId}`;
    
    try {
      // 打开详情页
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(1000);

      // 提取发票信息
      const invoiceInfo = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        
        let invoiceType = 'unknown';
        let invoiceTitle = '';
        
        if (bodyText.includes('企业') || bodyText.includes('公司') || bodyText.includes('有限') || bodyText.includes('集团')) {
          invoiceType = 'company';
          invoiceTitle = '企业';
        } else if (bodyText.includes('个人') && !bodyText.includes('企业')) {
          invoiceType = 'personal';
          invoiceTitle = '个人-个人';
        } else if (bodyText.includes('申请开票')) {
          invoiceType = 'personal'; // 默认未开票为个人
          invoiceTitle = '待开票-可能是个人';
        }
        
        return { invoiceType, invoiceTitle };
      });

      // 更新订单信息
      order.invoiceType = invoiceInfo.invoiceType;
      order.invoiceTitle = invoiceInfo.invoiceTitle;
      order.needsReissue = invoiceInfo.invoiceType === 'personal' || 
                           invoiceInfo.invoiceType === 'unknown';
      
      if (invoiceInfo.invoiceType === 'company') companyFound++;
      if (invoiceInfo.invoiceType === 'personal') personalFound++;

      const icon = invoiceInfo.invoiceType === 'company' ? '✅' : 
                   invoiceInfo.invoiceType === 'personal' ? '❌' : '❓';
      
      console.log(`  [${i + 1}/${unknownOrders.length}] ${icon} ${order.orderId} → ${invoiceInfo.invoiceTitle}`);

    } catch (e) {
      console.log(`  [${i + 1}/${unknownOrders.length}] ⚠️ ${order.orderId} → 访问失败`);
    }
    
    checkedCount++;

    // 控制请求频率
    await sleep(500);
  }

  // 统计最终结果
  const finalCompany = orders.filter(o => o.invoiceType === 'company').length;
  const finalPersonal = orders.filter(o => o.invoiceType === 'personal').length;
  const finalUnknown = orders.filter(o => o.invoiceType === 'unknown').length;

  console.log('\n' + '='.repeat(60));
  console.log('📊 最终统计结果');
  console.log('='.repeat(60));
  console.log(`\n✅ 公司发票：${finalCompany} 个`);
  console.log(`❌ 个人发票：${finalPersonal} 个`);
  console.log(`❓ 仍未识别：${finalUnknown} 个`);
  console.log(`📋 总计：${orders.length} 个`);

  // 保存结果
  const result = {
    ...v10Data,
    version: '11.0',
    checkTime: new Date().toISOString(),
    totalCompany: finalCompany,
    totalPersonal: finalPersonal,
    totalUnknown: finalUnknown,
    companyOrders: orders.filter(o => o.invoiceType === 'company'),
    personalOrders: orders.filter(o => o.invoiceType === 'personal'),
    orders,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n💾 结果已保存到: ${OUTPUT_FILE}`);
  
  await browser.close();
}

main().catch(console.error);
