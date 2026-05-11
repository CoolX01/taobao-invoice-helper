// 调试：用UTF-8正确编码输出列表页发票信息
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] || await context.newPage();

  await page.goto('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await new Promise(r => setTimeout(r, 4000));

  try { await page.click('text=知道了', { timeout: 2000 }); } catch (e) {}

  // 把结果写入文件而不是控制台，避免编码问题
  const result = await page.evaluate(() => {
    const output = {};

    // 1. 找到所有订单卡片
    const cards = document.querySelectorAll('[class*="trade-container"]');
    output.cardCount = cards.length;

    output.cards = [];
    cards.forEach((card, i) => {
      if (i >= 3) return; // 只看前3个

      const text = card.innerText;

      // 提取订单号
      const orderIds = text.match(/\d{18}/g) || [];

      // 查找发票/开票相关
      const hasKaipiao = text.includes('开票');
      const hasFapiao = text.includes('发票');
      const hasQiye = text.includes('企业');
      const hasGeren = text.includes('个人');
      const hasCompanyKeyword = text.includes('公司');

      // 找所有链接
      const links = [...card.querySelectorAll('a[href]')].map(a => ({
        text: a.textContent?.trim().slice(0, 40),
        href: a.getAttribute('href')?.slice(0, 120),
      })).filter(l => l.href && l.href.length > 5);

      // 找所有按钮文本
      const buttons = [...card.querySelectorAll('a, button, span[class*="btn"]')].map(
        el => el.textContent?.trim()
      ).filter(t => t && t.length > 1 && t.length < 20);

      // 提取订单号行附近的文本
      const lines = text.split('\n').filter(l => l.trim());
      const orderIdLine = lines.findIndex(l => /\d{18}/.test(l));

      output.cards.push({
        index: i + 1,
        orderIds,
        hasKaipiao,
        hasFapiao,
        hasQiye,
        hasGeren,
        hasCompanyKeyword,
        buttons: [...new Set(buttons)],
        detailLinks: links.filter(l => l.href.includes('detail') || l.href.includes('order')),
        orderLineText: orderIdLine >= 0 ? lines[orderIdLine] : '',
        // 订单号后面5行
        nextLines: orderIdLine >= 0 ? lines.slice(orderIdLine + 1, orderIdLine + 6) : [],
      });
    });

    // 2. 全局搜索 - 整个页面的开票/发票出现位置
    const body = document.body.innerText;
    output.globalSearch = {};
    for (const kw of ['开票', '发票', '企业', '个人', '公司', '抬头']) {
      const positions = [];
      let idx = 0;
      while ((idx = body.indexOf(kw, idx)) !== -1) {
        positions.push(body.substring(Math.max(0, idx - 60), Math.min(body.length, idx + 80)));
        idx++;
        if (positions.length >= 5) break;
      }
      output.globalSearch[kw] = positions;
    }

    // 3. bizOrderId映射（从链接中提取）
    const bizOrderLinks = [...document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]')].map(a => ({
      text: a.textContent?.trim().slice(0, 30),
      href: a.getAttribute('href'),
    }));
    output.bizOrderLinks = bizOrderLinks;

    return output;
  });

  // 写入文件
  fs.writeFileSync(path.join(__dirname, 'debug-result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log('结果已保存到 debug-result.json');
  console.log('卡片数量:', result.cardCount);

  await context.close();
}

main().catch(e => console.error('Error:', e.message));
