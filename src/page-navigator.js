'use strict';

const { log } = require('./logger');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的页面导航
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.timeout=60000]
 * @param {number} [options.retryDelayBase=3000]
 * @param {string} [options.waitUntil='domcontentloaded']
 */
async function gotoWithRetry(page, url, options = {}) {
  const {
    maxRetries = 3,
    timeout = 60000,
    retryDelayBase = 3000,
    waitUntil = 'domcontentloaded',
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return;
    } catch (err) {
      lastError = err;
      log('warn', null, 'gotoWithRetry', `⚠️ 导航失败 (${attempt}/${maxRetries}): ${err.message}`, {
        url,
        attempt,
        maxRetries,
      });

      if (attempt < maxRetries) {
        const delay = retryDelayBase * attempt;
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * 等待页面内容就绪（轮询 body 文本是否包含关键词）
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {string[]} [options.keywords=[]]
 * @param {number} [options.timeout=15000]
 * @param {number} [options.pollInterval=500]
 */
async function waitForContentReady(page, options = {}) {
  const {
    keywords = [],
    timeout = 15000,
    pollInterval = 500,
  } = options;

  if (keywords.length === 0) {
    return;
  }

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const text = await page.evaluate(() => document.body.innerText || '');
      const found = keywords.some(kw => text.includes(kw));
      if (found) {
        return;
      }
    } catch (_) {
      // 页面可能还在加载，忽略错误继续轮询
    }
    await sleep(pollInterval);
  }

  // 超时静默返回
}

/**
 * 给任意 async 函数加超时保护
 * @param {() => Promise<T>} fn
 * @param {number} timeoutMs
 * @param {T} fallbackValue
 * @returns {Promise<T>}
 * @template T
 */
async function withPageTimeout(fn, timeoutMs, fallbackValue) {
  let timer;
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { gotoWithRetry, waitForContentReady, withPageTimeout };
