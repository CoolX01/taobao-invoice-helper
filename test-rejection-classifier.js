const assert = require('assert');
const { classifyRejectedInvoiceHandling } = require('./invoice-audit-report');

const cases = [
  {
    name: 'email requested through wangwang',
    historyText: [
      '卖家拒绝了发票申请',
      '拒绝类型：与买家协商一致延迟开具',
      '拒绝原因：亲，电子发票需要邮箱，请提供邮箱到旺旺 进行开票！',
    ].join('\n'),
    hasModifyEntry: true,
    expected: 'contact_seller',
  },
  {
    name: 'online customer service requested',
    historyText: [
      '卖家拒绝了发票申请',
      '拒绝类型：其他',
      '拒绝原因：发票，电子发票请联系我们在线客服，谢谢',
    ].join('\n'),
    hasModifyEntry: true,
    expected: 'contact_seller',
  },
  {
    name: 'wrong title can be modified',
    historyText: [
      '卖家拒绝了发票申请',
      '拒绝类型：买家抬头信息输入有误',
      '拒绝原因：请核实发票信息并提供电子邮箱后再开具',
    ].join('\n'),
    hasModifyEntry: true,
    expected: 'modify_invoice',
  },
  {
    name: 'wrong title without modify contacts seller',
    historyText: [
      '卖家拒绝了发票申请',
      '拒绝类型：买家抬头信息输入有误',
      '拒绝原因：请核实发票信息后再开具',
    ].join('\n'),
    hasModifyEntry: false,
    expected: 'contact_seller',
  },
  {
    name: 'already issued invoice needs manual confirmation',
    historyText: [
      '卖家拒绝了发票申请',
      '拒绝类型：其他',
      '拒绝原因：已开示例发票号码电子发票',
    ].join('\n'),
    hasModifyEntry: true,
    expected: 'manual_required',
  },
  {
    name: 'small-scale seller asks for customer service',
    historyText: [
      '卖家拒绝了发票申请',
      '拒绝类型：买家抬头信息输入有误',
      '拒绝原因：小规模公司开具不了增值税发票，请联系客服开电子版普票发邮箱。',
    ].join('\n'),
    hasModifyEntry: true,
    expected: 'contact_seller',
  },
];

for (const testCase of cases) {
  const result = classifyRejectedInvoiceHandling({
    detailText: '商家拒绝 请根据拒绝理由，修改申请或咨询商家',
    historyText: testCase.historyText,
    hasModifyEntry: testCase.hasModifyEntry,
    historyOpened: true,
  });
  assert.strictEqual(result.action, testCase.expected, `${testCase.name}: ${result.reason}`);
}

console.log(`rejection classifier ok: ${cases.length} cases`);
