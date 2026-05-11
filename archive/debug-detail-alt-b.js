// 调试：从列表页点击订单，抓取真实详情页URL和结构
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');
const INPUT_FILE = path.join(__dirname, 'invoices-v10.json');

async function main() {
  const sourceData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const unknownOrder = sourceData.orders.find(o => o.invoiceType === 'unknown');
  console.log(`目标订单: ${unknownOrder.orderId}`);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] || await context.newPage();

  // 1. 打开列表页
  console.log('\n=== 打开列表页 ===');
  await page.goto('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await new Promise(r => setTimeout(r, 4000));

  // 关闭弹窗
  try { await page.click('text=知道了', { timeout: 2000 }); } catch (e) {}

  // 2. 查找所有包含订单号的链接
  console.log('\n=== 查找订单链接 ===');
  const allLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href]');
    return [...links].map(a => ({
      text: a.textContent?.trim().slice(0, 60),
      href: a.getAttribute('href'),
    })).filter(l => l.href && l.href.length > 10);
  });
  
  // 筛选可能相关的链接
  const relevantLinks = allLinks.filter(l => 
    l.href.includes('detail') || 
    l.href.includes('order') || 
    l.href.includes('trade') ||
    l.href.includes('invoice') ||
    l.href.includes('bill') ||
    l.text.includes('详情') ||
    l.text.includes('发票') ||
    l.text.includes('查看')
  );
  console.log(`总链接: ${allLinks.length}, 相关链接: ${relevantLinks.length}`);
  relevantLinks.slice(0, 20).forEach(l => console.log(`  ${l.text} → ${l.href}`));

  // 3. 搜索页面中所有可能的订单号出现位置，并找到附近的可点击元素
  console.log('\n=== 订单号附近的可点击元素 ===');
  const clickableNearOrder = await page.evaluate((oid) => {
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.includes(oid)) {
        // 找到包含订单号的文本节点，往上找可点击的父元素
        let el = node.parentElement;
        for (let i = 0; i < 8 && el; i++) {
          const tag = el.tagName;
          const href = el.getAttribute('href') || el.dataset?.href || '';
          const onclick = el.getAttribute('onclick') || '';
          const cls = el.className?.toString?.()?.slice(0, 80) || '';
          
          if (href || onclick || tag === 'A' || tag === 'BUTTON') {
            results.push({ tag, href: href.slice(0, 200), onclick: onclick.slice(0, 100), cls, text: el.textContent?.trim().slice(0, 80) });
            break;
          }
          el = el.parentElement;
        }
      }
    }
    return results;
  }, unknownOrder.orderId);
  clickableNearOrder.forEach(r => console.log(`  <${r.tag}> href="${r.href}" text="${r.text}"`));

  // 4. 尝试点击订单号附近的元素
  console.log('\n=== 尝试点击进入详情 ===');
  if (clickableNearOrder.length > 0) {
    const target = clickableNearOrder[0];
    if (target.href) {
      console.log(`点击链接: ${target.href}`);
      // 监听新页面/新标签打开
      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
        page.click(`a[href="${target.href}"]`, { timeout: 5000 }).catch(() => null),
      ]);
      
      const detailPage = newPage || page;
      await new Promise(r => setTimeout(r, 3000));
      console.log(`详情页URL: ${detailPage.url()}`);
      await detailPage.screenshot({ path: path.join(__dirname, 'debug-click-detail.png'), fullPage: true });

      // 提取详情页文本
      const detailText = await detailPage.evaluate(() => document.body.innerText);
      console.log(`详情页文本长度: ${detailText.length}`);
      console.log(`详情页前500字: ${detailText.slice(0, 500)}`);

      // 搜索发票关键词
      for (const kw of ['发票', '开票', '抬头', '企业', '个人', '公司', '税号']) {
        const idx = detailText.indexOf(kw);
        if (idx >= 0) {
          console.log(`✅ 找到"${kw}": ...${detailText.slice(Math.max(0, idx-40), idx+60)}...`);
        }
      }

      if (newPage) await newPage.close();
    }
  }

  // 5. 尝试另一种方式：在列表页找到每个订单的"更多"或"订单详情"按钮
  console.log('\n=== 查找"订单详情"按钮 ===');
  const detailButtons = await page.evaluate(() => {
    const all = document.querySelectorAll('a, button, span, div');
    return [...all]
      .filter(el => {
        const t = el.textContent?.trim() || '';
        return t === '订单详情' || t === '详情' || t === '查看详情' || t.includes('查看订单');
      })
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim().slice(0, 40),
        href: el.getAttribute('href') || el.dataset?.href || '',
        cls: el.className?.toString?.()?.slice(0, 80) || '',
        parentHref: el.closest('a')?.getAttribute('href') || '',
      }));
  });
  detailButtons.forEach(b => console.log(`  <${b.tag}> text="${b.text}" href="${b.href}" parentHref="${b.parentHref}"`));

  // 6. 检查列表页是否有发票信息（可能需要展开或hover）
  console.log('\n=== 列表页发票信息检查 ===');
  const invoiceOnList = await page.evaluate(() => {
    const body = document.body.innerText;
    const keywords = ['发票', '开票', '抬头', '企业', '个人', '公司'];
    return keywords.map(kw => ({
      keyword: kw,
      found: body.includes(kw),
      count: body.split(kw).length - 1,
    }));
  });
  invoiceOnList.forEach(i => console.log(`  "${i.keyword}": ${i.found ? `✅ (${i.count}次)` : '❌'}`));

  // 7. 检查是否有"申请开票"/"查看发票"按钮
  console.log('\n=== 发票相关按钮 ===');
  const invoiceButtons = await page.evaluate(() => {
    const all = document.querySelectorAll('a, button, span');
    return [...all]
      .filter(el => {
        const t = el.textContent?.trim() || '';
        const h = el.getAttribute('href') || '';
        return t.includes('发票') || t.includes('开票') || h.includes('invoice') || h.includes('bill');
      })
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim().slice(0, 60),
        href: el.getAttribute('href') || '',
      }));
  });
  invoiceButtons.forEach(b => console.log(`  <${b.tag}> text="${b.text}" href="${b.href}"`));

  // 8. 保存列表页HTML供分析
  const listHtml = await page.content();
  fs.writeFileSync(path.join(__dirname, 'debug-list-v2.html'), listHtml, 'utf8');
  console.log('\n已保存 debug-list-v2.html, debug-click-detail.png');

  await context.close();
  console.log('调试完成');
}

main().catch(e => console.error('Error:', e.message));
