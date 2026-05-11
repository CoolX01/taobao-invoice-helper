// 调试：深入分析订单详情页结构，找出发票信息在哪里
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');
const INPUT_FILE = path.join(__dirname, 'invoices-v10.json');

async function main() {
  const sourceData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const unknownOrder = sourceData.orders.find(o => o.invoiceType === 'unknown');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] || await context.newPage();

  // ===== 方案1: 直接URL访问 =====
  console.log('\n===== 方案1: 直接URL =====');
  const url1 = `https://buyertrade.taobao.com/trade/detail/tradeItemDetail.htm?orderId=${unknownOrder.orderId}`;
  console.log('URL:', url1);
  await page.goto(url1, { waitUntil: 'networkidle', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(__dirname, 'debug-url1.png'), fullPage: true });

  // 保存完整HTML
  const html1 = await page.content();
  fs.writeFileSync(path.join(__dirname, 'debug-url1.html'), html1, 'utf8');

  // 搜索所有文本
  const text1 = await page.evaluate(() => document.body.innerText);
  const hasInvoice1 = text1.includes('发票') || text1.includes('开票') || text1.includes('抬头');
  console.log('方案1 - 有发票信息:', hasInvoice1);

  // ===== 方案2: 从列表页点击进入 =====
  console.log('\n===== 方案2: 从列表页点击 =====');
  await page.goto('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await new Promise(r => setTimeout(r, 3000));

  // 关闭弹窗
  try { await page.click('text=知道了', { timeout: 2000 }); await new Promise(r => setTimeout(r, 500)); } catch (e) {}
  await page.screenshot({ path: path.join(__dirname, 'debug-list.png'), fullPage: true });

  // 查找所有链接 - 看看订单详情链接的格式
  const orderLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="detail"], a[href*="order"]');
    return [...links].slice(0, 10).map(a => ({
      text: a.textContent?.trim().slice(0, 50),
      href: a.getAttribute('href'),
    }));
  });
  console.log('订单链接:', JSON.stringify(orderLinks, null, 2));

  // 查找包含"详情"文字的链接
  const detailLinks = await page.evaluate(() => {
    const allLinks = document.querySelectorAll('a');
    return [...allLinks]
      .filter(a => a.textContent?.includes('详情') || a.textContent?.includes('订单') || a.textContent?.includes('查看'))
      .slice(0, 10)
      .map(a => ({
        text: a.textContent?.trim().slice(0, 80),
        href: a.getAttribute('href'),
      }));
  });
  console.log('详情相关链接:', JSON.stringify(detailLinks, null, 2));

  // 查找包含订单号的元素和它附近的链接
  const orderIdContext = await page.evaluate((oid) => {
    const allElements = document.querySelectorAll('*');
    const results = [];
    for (const el of allElements) {
      if (el.textContent?.includes(oid) && el.children.length === 0) {
        // 找到包含订单号的最内层元素，往上找链接
        let parent = el;
        for (let i = 0; i < 5; i++) {
          parent = parent.parentElement;
          if (!parent) break;
          const link = parent.querySelector('a') || (parent.tagName === 'A' ? parent : null);
          if (link) {
            results.push({
              tag: parent.tagName,
              href: link.getAttribute('href'),
              text: parent.textContent?.trim().slice(0, 100),
            });
            break;
          }
        }
      }
    }
    return results.slice(0, 5);
  }, unknownOrder.orderId);
  console.log('订单号附近链接:', JSON.stringify(orderIdContext, null, 2));

  // 保存列表页HTML
  const listHtml = await page.content();
  fs.writeFileSync(path.join(__dirname, 'debug-list.html'), listHtml, 'utf8');
  console.log('\n已保存: debug-url1.html, debug-url1.png, debug-list.html, debug-list.png');

  // ===== 方案3: 试另一种URL格式 =====
  console.log('\n===== 方案3: trade_id格式 =====');
  // 淘宝另一个常见的详情URL
  const url3 = `https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?biz_id=&trade_id=${unknownOrder.orderId}`;
  await page.goto(url3, { waitUntil: 'networkidle', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  const text3 = await page.evaluate(() => document.body.innerText);
  const hasInvoice3 = text3.includes('发票') || text3.includes('开票') || text3.includes('抬头');
  console.log('方案3 - 有发票信息:', hasInvoice3);
  await page.screenshot({ path: path.join(__dirname, 'debug-url3.png'), fullPage: true });

  // 输出方案3的关键文本（搜索发票相关区域）
  if (hasInvoice3) {
    // 输出发票周围文本
    const invoiceContext = await page.evaluate(() => {
      const body = document.body.innerText;
      const keywords = ['发票', '开票', '抬头', '企业', '个人'];
      const results = [];
      for (const kw of keywords) {
        let idx = body.indexOf(kw);
        while (idx !== -1 && results.length < 10) {
          results.push({
            keyword: kw,
            context: body.substring(Math.max(0, idx - 80), Math.min(body.length, idx + 120)),
          });
          idx = body.indexOf(kw, idx + 1);
        }
      }
      return results;
    });
    console.log('发票相关上下文:', JSON.stringify(invoiceContext, null, 2));
  } else {
    // 如果没有发票信息，输出页面中所有包含"发"字的内容
    const faContext = await page.evaluate(() => {
      const body = document.body.innerText;
      const results = [];
      // 输出前500字看看页面是什么
      results.push({ type: 'page_start', text: body.substring(0, 500) });
      // 搜索所有可能的发票相关词
      const words = ['发', '票', '税', 'invoice', '抬头'];
      for (const w of words) {
        const idx = body.indexOf(w);
        if (idx !== -1) {
          results.push({ keyword: w, context: body.substring(Math.max(0, idx - 50), idx + 100) });
        }
      }
      return results;
    });
    console.log('页面内容概览:', JSON.stringify(faContext, null, 2));
  }

  await context.close();
  console.log('\n调试完成');
}

main().catch(e => console.error('Error:', e.message));
