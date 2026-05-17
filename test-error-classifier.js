const assert = require('assert');
const { classifyInvoicePage } = require('./error-classifier');

const invoiceConfig = {
  companyName: 'EXAMPLE_COMPANY_NAME',
  taxNo: 'EXAMPLE_TAX_NO',
};

const cases = [
  {
    name: 'can apply',
    snapshot: { text: '该订单暂未开票 申请开票', candidates: [{ type: 'apply_invoice', visible: true, disabled: false }] },
    expectedStatus: 'CAN_APPLY',
    expectedAction: 'apply_invoice',
  },
  {
    name: 'can download',
    snapshot: { text: '已开票 下载发票', candidates: [{ type: 'download_invoice', visible: true, disabled: false }] },
    expectedStatus: 'CAN_DOWNLOAD',
    expectedAction: 'download_invoice',
  },
  {
    name: 'personal invoice should reissue',
    snapshot: { text: '发票抬头 个人', invoiceInfo: { invoiceType: 'personal', invoiceTitle: '个人' }, candidates: [{ type: 'reissue_invoice', visible: true, disabled: false }] },
    expectedStatus: 'NEED_REISSUE',
    expectedAction: 'reissue_invoice',
  },
  {
    name: 'wrong tax title should modify',
    snapshot: { text: '发票抬头 EXAMPLE_TAX_NO', invoiceInfo: { invoiceType: 'wrong_company_title', invoiceTitle: 'EXAMPLE_TAX_NO' }, candidates: [{ type: 'modify_invoice', visible: true, disabled: false }] },
    expectedStatus: 'NEED_REISSUE',
    expectedAction: 'modify_invoice',
  },
  {
    name: 'deadline contact seller',
    snapshot: { text: '订单超过可开票期限，请联系商家申请' },
    expectedStatus: 'NEED_CONTACT_SELLER',
    expectedAction: 'contact_seller',
  },
  {
    name: 'seller rejected',
    snapshot: { text: '卖家拒绝了发票申请 拒绝原因：买家抬头信息输入有误', candidates: [{ type: 'modify_invoice', visible: true, disabled: false }] },
    expectedStatus: 'FAILED_RETRYABLE',
    expectedAction: 'inspect_rejection_reason',
  },
  {
    name: 'missing email',
    snapshot: { text: '拒绝原因：未提供邮箱，请提供电子邮箱', candidates: [{ type: 'modify_invoice', visible: true, disabled: false }] },
    expectedStatus: 'FAILED_RETRYABLE',
    expectedAction: 'modify_invoice',
  },

  {
    name: 'order refunded',
    snapshot: { text: '交易关闭 已退款，无法申请发票' },
    expectedStatus: 'FAILED_FINAL',
    expectedAction: 'skip',
  },
  {
    name: 'security check',
    snapshot: { text: '请完成安全验证 拖动滑块' },
    expectedStatus: 'NEED_MANUAL_SECURITY_CHECK',
    expectedAction: 'manual_security_check',
  },
];

for (const testCase of cases) {
  const result = classifyInvoicePage(testCase.snapshot, { invoiceConfig });
  assert.strictEqual(result.status, testCase.expectedStatus, `${testCase.name}: status ${JSON.stringify(result)}`);
  assert.strictEqual(result.recommendedAction, testCase.expectedAction, `${testCase.name}: action ${JSON.stringify(result)}`);
}


console.log(`error classifier ok: ${cases.length} cases`);
