const assert = require('assert');
const { classifyChatReply, isLikelyInvoiceHref } = require('./invoice-actions');

const cases = [
  {
    name: 'invoice attachment link',
    snapshot: {
      bodyText: '您好，发票已经开好，请下载附件。',
      frames: [{
        links: [{ href: 'https://example.com/invoice-123.pdf', text: '下载发票' }],
      }],
    },
    category: 'invoice_link_found',
    status: 'can_download',
  },

  {
    name: 'wangwang file card',
    snapshot: {
      bodyText: '示例店铺 [文件] EXAMPLE_COMPANY_NAME.pdf 57.2KB 下载文件',
      frames: [{ links: [] }],
    },
    category: 'invoice_link_found',
    status: 'can_download',
  },
  {
    name: 'seller requests email',
    snapshot: {
      bodyText: '请提供邮箱和发票抬头信息',
      frames: [{ links: [] }],
    },
    category: 'seller_requests_info',
    status: 'manual_required',
  },
  {
    name: 'waiting reply',
    snapshot: {
      bodyText: '您好，请问还在吗？我们会尽快处理，请稍等。',
      frames: [{ links: [] }],
    },
    category: 'waiting_or_no_invoice_reply',
    status: 'waiting',
  },
];

for (const testCase of cases) {
  const actual = classifyChatReply(testCase.snapshot);
  assert.strictEqual(actual.replyCategory, testCase.category, testCase.name);
  assert.strictEqual(actual.status, testCase.status, testCase.name);
}

assert.strictEqual(isLikelyInvoiceHref('https://example.com/a.ofd', ''), true);
assert.strictEqual(isLikelyInvoiceHref('https://example.com/download', '电子发票下载'), true);
assert.strictEqual(isLikelyInvoiceHref('https://example.com/help', '查看帮助'), false);

console.log('✅ chat reply classifier tests passed');
