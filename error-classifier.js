const SECURITY_MARKERS = [
  '请扫码登录',
  '扫码登录',
  '验证码',
  '请输入验证码',
  '滑动验证',
  '人机验证',
  '安全验证',
  '请完成验证',
  '请拖动滑块',
  '账号安全',
  '访问受限',
  '风险验证',
];

const ACTION_BY_CANDIDATE_TYPE = {
  apply_invoice: 'apply_invoice',
  download_invoice: 'download_invoice',
  view_invoice: 'inspect_invoice',
  reissue_invoice: 'reissue_invoice',
  modify_invoice: 'modify_invoice',
  contact_seller: 'contact_seller',
};

const ERROR_RULES = [
  {
    id: 'SECURITY_VERIFICATION',
    category: 'security_verification',
    status: 'NEED_MANUAL_SECURITY_CHECK',
    recommendedAction: 'manual_security_check',
    severity: 1000,
    retryable: false,
    manualReason: '登录、验证码、滑块或淘宝风控需要人工完成',
    patterns: SECURITY_MARKERS,
  },
  {
    id: 'DEADLINE_EXCEEDED',
    category: 'deadline_exceeded',
    status: 'NEED_CONTACT_SELLER',
    recommendedAction: 'contact_seller',
    severity: 900,
    retryable: false,
    patterns: [
      '订单超过可开票期限',
      '超过开票日期',
      '已超过开票日期',
      '超过可开票时间',
      '已超过可开票时间',
      '超过开票时间',
      '开票申请已截止',
      '超过申请时效',
      '开票已截止',
      '请联系商家申请',
    ],
  },
  {
    id: 'SELLER_REJECTED',
    category: 'seller_rejected',
    status: 'FAILED_RETRYABLE',
    recommendedAction: 'inspect_rejection_reason',
    severity: 860,
    retryable: true,
    patterns: ['商家拒绝', '卖家拒绝了发票申请', '拒绝了发票申请', '审核不通过', '审核未通过', '申请失败', '拒绝开票'],
  },
  {
    id: 'MISSING_SUPPLEMENT_INFO',
    category: 'missing_supplement_info',
    status: 'FAILED_RETRYABLE',
    recommendedAction: 'modify_invoice',
    severity: 830,
    retryable: true,
    patterns: ['请补充信息', '信息不完整', '信息有误', '请核实发票信息', '资料不完整', '请完善'],
  },
  {
    id: 'MISSING_EMAIL',
    category: 'missing_email',
    status: 'FAILED_RETRYABLE',
    recommendedAction: 'modify_invoice',
    severity: 825,
    retryable: true,
    patterns: ['请提供邮箱', '请提供电子邮箱', '提供电子邮箱', '未提供邮箱', '缺少邮箱'],
  },
  {
    id: 'WRONG_TITLE',
    category: 'wrong_title',
    status: 'NEED_REISSUE',
    recommendedAction: 'modify_or_reissue',
    severity: 820,
    retryable: true,
    patterns: ['抬头信息输入有误', '抬头错误', '发票抬头有误', '抬头不符', '购买方名称错误'],
  },
  {
    id: 'WRONG_TAX_NO',
    category: 'wrong_tax_no',
    status: 'NEED_REISSUE',
    recommendedAction: 'modify_or_reissue',
    severity: 815,
    retryable: true,
    patterns: ['税号错误', '税号有误', '纳税人识别号错误', '税号不正确', '统一社会信用代码错误'],
  },
  {
    id: 'AMOUNT_MISMATCH',
    category: 'amount_mismatch',
    status: 'FAILED_RETRYABLE',
    recommendedAction: 'modify_invoice',
    severity: 805,
    retryable: true,
    patterns: ['金额不符', '金额有误', '开票金额不符', '发票金额不一致', '金额不一致'],
  },
  {
    id: 'INVOICE_TYPE_UNSUPPORTED',
    category: 'invoice_type_unsupported',
    status: 'FAILED_FINAL',
    recommendedAction: 'contact_seller',
    severity: 780,
    retryable: false,
    patterns: ['不支持开具', '无法开具专票', '不能开具专票', '发票类型不支持', '仅支持个人', '仅支持电子普票'],
  },
  {
    id: 'SPECIAL_VAT_INFO_MISSING',
    category: 'special_vat_info_missing',
    status: 'FAILED_RETRYABLE',
    recommendedAction: 'modify_invoice',
    severity: 760,
    retryable: true,
    patterns: ['专票资料缺失', '专用发票资料缺失', '请提供专用发票资料', '一般纳税人证明'],
  },
  {
    id: 'ORDER_CLOSED_REFUNDED',
    category: 'order_closed_or_refunded',
    status: 'FAILED_FINAL',
    recommendedAction: 'skip',
    severity: 740,
    retryable: false,
    patterns: ['交易关闭', '订单已关闭', '已退款', '退款成功', '交易已关闭'],
  },
  {
    id: 'ORDER_NOT_FOUND',
    category: 'order_not_found',
    status: 'FAILED_FINAL',
    recommendedAction: 'skip',
    severity: 730,
    retryable: false,
    patterns: ['订单不存在', '未找到订单', '订单信息不存在', '没有找到相关订单'],
  },
  {
    id: 'PAGE_NOT_READY',
    category: 'page_not_ready',
    status: 'FAILED_RETRYABLE',
    recommendedAction: 'retry',
    severity: 700,
    retryable: true,
    patterns: ['加载中', '正在加载', '网络异常', '系统繁忙', '请稍后再试', '服务异常'],
  },
  {
    id: 'REISSUE_FAILED',
    category: 'reissue_failed',
    status: 'FAILED_RETRYABLE',
    recommendedAction: 'contact_seller',
    severity: 680,
    retryable: true,
    patterns: ['换开失败', '重开失败', '修改发票失败', '换开申请失败'],
  },
  {
    id: 'DOWNLOAD_FAILED',
    category: 'download_failed',
    status: 'FAILED_RETRYABLE',
    recommendedAction: 'retry_download',
    severity: 660,
    retryable: true,
    patterns: ['下载失败', '文件不存在', '下载链接失效', '无法下载'],
  },
  {
    id: 'FILE_EXISTS',
    category: 'file_exists',
    status: 'DOWNLOADED',
    recommendedAction: 'skip_download',
    severity: 640,
    retryable: false,
    patterns: ['文件已存在', '已下载过'],
  },
  {
    id: 'APPLIED_WAITING',
    category: 'applied_waiting',
    status: 'APPLIED_WAITING',
    recommendedAction: 'wait',
    severity: 560,
    retryable: false,
    patterns: ['申请中', '商家正在处理', '处理中', '已提交', '待商家开票'],
  },
  {
    id: 'CAN_DOWNLOAD',
    category: 'can_download',
    status: 'CAN_DOWNLOAD',
    recommendedAction: 'download_invoice',
    severity: 520,
    retryable: false,
    patterns: ['已开票', '开票成功', '下载发票', '发票下载', '查看发票'],
  },
  {
    id: 'CAN_APPLY',
    category: 'can_apply',
    status: 'CAN_APPLY',
    recommendedAction: 'apply_invoice',
    severity: 500,
    retryable: false,
    patterns: ['申请开票', '开具发票', '我要开票', '未开票', '暂未开票'],
  },
  {
    id: 'CAN_REISSUE',
    category: 'can_reissue',
    status: 'CAN_DOWNLOAD',
    recommendedAction: 'reissue_invoice',
    severity: 490,
    retryable: false,
    patterns: ['换开发票', '换开', '重新开票', '重开发票', '修改申请'],
  },
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, '');
}

function normalizeIdentifier(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function looksLikeTaxNo(value, configuredTaxNo = '') {
  const normalized = normalizeIdentifier(value);
  const expected = normalizeIdentifier(configuredTaxNo);
  if (!normalized) return false;
  if (expected && normalized === expected) return true;
  return /^[0-9A-Z]{15,20}$/.test(normalized) && /\d{10,}/.test(normalized);
}

function includesAny(text, words) {
  return words.some(word => text.includes(word));
}

function getVisibleEnabledCandidates(snapshot) {
  return (snapshot.candidates || []).filter(candidate => candidate.visible && !candidate.disabled);
}

function hasCandidate(snapshot, type) {
  return getVisibleEnabledCandidates(snapshot).some(candidate => candidate.type === type);
}

function findCandidateAction(snapshot) {
  const candidates = getVisibleEnabledCandidates(snapshot);
  for (const type of ['download_invoice', 'reissue_invoice', 'modify_invoice', 'apply_invoice', 'contact_seller', 'view_invoice']) {
    if (candidates.some(candidate => candidate.type === type)) return ACTION_BY_CANDIDATE_TYPE[type];
  }
  return '';
}

function findPromptExcerpt(text, patterns) {
  const normalizedLines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (const pattern of patterns) {
    const line = normalizedLines.find(item => item.includes(pattern));
    if (line) return line.slice(0, 240);
  }
  const compact = normalizeText(text);
  for (const pattern of patterns) {
    const index = compact.indexOf(pattern);
    if (index >= 0) return compact.slice(Math.max(0, index - 80), index + pattern.length + 120);
  }
  return '';
}


function getMatchedRules(snapshot) {
  const text = [
    snapshot.text,
    snapshot.popupText,
    snapshot.historyText,
    snapshot.ocrText,
    snapshot.url,
    snapshot.title,
    ...(snapshot.buttons || []),
    ...(snapshot.domHints || []),
  ].filter(Boolean).join('\n');
  const compact = compactText(text);

  return ERROR_RULES
    .map(rule => {
      const matchedPatterns = (rule.patterns || []).filter(pattern => compact.includes(compactText(pattern)));
      if (matchedPatterns.length === 0) return null;
      return {
        id: rule.id,
        category: rule.category,
        status: rule.status,
        recommendedAction: rule.recommendedAction,
        retryable: rule.retryable,
        requiresPaymentConfirm: Boolean(rule.requiresPaymentConfirm),
        manualReason: rule.manualReason || '',
        severity: rule.severity || 0,
        matchedPatterns,
        rawPrompt: findPromptExcerpt(text, matchedPatterns),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.severity - left.severity);
}

function deriveInvoiceInfoRule(snapshot, context) {
  const invoiceInfo = snapshot.invoiceInfo || {};
  const invoiceConfig = context.invoiceConfig || {};
  const text = String(snapshot.text || '');
  const hasReissueOrModify = hasCandidate(snapshot, 'modify_invoice') || hasCandidate(snapshot, 'reissue_invoice');
  const hasCompany = invoiceConfig.companyName ? text.includes(invoiceConfig.companyName) : false;
  const hasTaxNo = invoiceConfig.taxNo ? text.includes(invoiceConfig.taxNo) : false;
  const title = invoiceInfo.invoiceTitle || '';

  if (invoiceInfo.invoiceType === 'wrong_company_title' || looksLikeTaxNo(title, invoiceConfig.taxNo)) {
    return {
      id: 'WRONG_TITLE_TAXNO_AS_TITLE',
      category: 'wrong_title',
      status: 'NEED_REISSUE',
      recommendedAction: hasReissueOrModify ? 'modify_or_reissue' : 'contact_seller',
      retryable: true,
      requiresPaymentConfirm: false,
      severity: 850,
      matchedPatterns: ['发票抬头像税号'],
      rawPrompt: title,
    };
  }

  if (invoiceInfo.invoiceType === 'personal') {
    return {
      id: 'PERSONAL_INVOICE_NEEDS_REISSUE',
      category: 'invoice_info_mismatch',
      status: 'NEED_REISSUE',
      recommendedAction: hasReissueOrModify ? 'reissue_invoice' : 'contact_seller',
      retryable: true,
      requiresPaymentConfirm: false,
      severity: 810,
      matchedPatterns: ['个人发票'],
      rawPrompt: title,
    };
  }

  if (invoiceInfo.invoiceType === 'company' && invoiceConfig.companyName && invoiceConfig.taxNo && (!hasCompany || !hasTaxNo)) {
    return {
      id: 'COMPANY_INVOICE_INFO_MISMATCH',
      category: 'invoice_info_mismatch',
      status: 'NEED_REISSUE',
      recommendedAction: hasReissueOrModify ? 'modify_or_reissue' : 'contact_seller',
      retryable: true,
      requiresPaymentConfirm: false,
      severity: 800,
      matchedPatterns: ['发票信息不符合配置'],
      rawPrompt: invoiceInfo.invoiceTitle || '',
    };
  }

  return null;
}

function refineActionForCurrentPage(rule, snapshot) {
  if (!rule) return rule;
  const refined = { ...rule };

  if (['wrong_title', 'wrong_tax_no', 'invoice_info_mismatch'].includes(refined.category)) {
    if (hasCandidate(snapshot, 'modify_invoice')) refined.recommendedAction = 'modify_invoice';
    else if (hasCandidate(snapshot, 'reissue_invoice')) refined.recommendedAction = 'reissue_invoice';
    else refined.recommendedAction = 'contact_seller';
  }

  if (['missing_email', 'missing_supplement_info', 'amount_mismatch', 'reissue_failed'].includes(refined.category)) {
    if (hasCandidate(snapshot, 'modify_invoice')) refined.recommendedAction = 'modify_invoice';
    else if (hasCandidate(snapshot, 'reissue_invoice')) refined.recommendedAction = 'reissue_invoice';
    else refined.recommendedAction = 'contact_seller';
  }

  if (refined.category === 'seller_rejected') {
    if (hasCandidate(snapshot, 'modify_invoice')) refined.recommendedAction = 'inspect_rejection_reason';
    else refined.recommendedAction = 'contact_seller';
  }

  return refined;
}

function classifyInvoicePage(snapshot = {}, context = {}) {
  const matchedRules = getMatchedRules(snapshot);
  const invoiceRule = deriveInvoiceInfoRule(snapshot, context);
  if (invoiceRule) {
    matchedRules.push(invoiceRule);
    matchedRules.sort((left, right) => (right.severity || 0) - (left.severity || 0));
  }

  let primary = refineActionForCurrentPage(matchedRules[0], snapshot);
  if (!primary) {
    const candidateAction = findCandidateAction(snapshot);
    if (candidateAction) {
      const statusByAction = {
        apply_invoice: 'CAN_APPLY',
        download_invoice: 'CAN_DOWNLOAD',
        inspect_invoice: 'CAN_DOWNLOAD',
        reissue_invoice: 'CAN_DOWNLOAD',
        modify_invoice: 'NEED_REISSUE',
        contact_seller: 'NEED_CONTACT_SELLER',
      };
      primary = {
        id: `CANDIDATE_${candidateAction.toUpperCase()}`,
        category: candidateAction,
        status: statusByAction[candidateAction] || 'CHECKING',
        recommendedAction: candidateAction,
        retryable: false,
        requiresPaymentConfirm: false,
        matchedPatterns: [candidateAction],
        rawPrompt: '',
      };
    }
  }

  if (!primary && snapshot.invoiceInfo?.invoiceType === 'no_invoice_info') {
    primary = {
      id: 'NO_INVOICE_ENTRY',
      category: 'no_action',
      status: 'FAILED_FINAL',
      recommendedAction: 'skip',
      retryable: false,
      requiresPaymentConfirm: false,
      matchedPatterns: ['页面无发票信息'],
      rawPrompt: snapshot.invoiceInfo.invoiceTitle || '页面无发票信息',
    };
  }

  if (!primary) {
    primary = {
      id: 'UNKNOWN_ERROR',
      category: 'unknown_error',
      status: 'FAILED_RETRYABLE',
      recommendedAction: 'save_snapshot',
      retryable: true,
      requiresPaymentConfirm: false,
      matchedPatterns: [],
      rawPrompt: normalizeText(snapshot.text || snapshot.title || snapshot.url).slice(0, 240),
    };
  }

  return {
    category: primary.category,
    status: primary.status,
    recommendedAction: primary.recommendedAction,
    retryable: Boolean(primary.retryable),
    requiresPaymentConfirm: Boolean(primary.requiresPaymentConfirm),
    manualReason: primary.manualReason || '',
    matchedRules: matchedRules.map(rule => ({
      id: rule.id,
      category: rule.category,
      status: rule.status,
      recommendedAction: rule.recommendedAction,
      matchedPatterns: rule.matchedPatterns || [],
      rawPrompt: rule.rawPrompt || '',
    })),
    rawPrompt: primary.rawPrompt || '',
  };
}

function classifyPageErrorText(text) {
  const classification = classifyInvoicePage({ text });
  const hits = classification.matchedRules.map(rule => ({
    type: rule.category,
    matched: rule.matchedPatterns?.[0] || rule.id,
    ruleId: rule.id,
  }));
  return {
    hits,
    hasRetryableError: hits.some(hit => [
      'wrong_title',
      'wrong_tax_no',
      'missing_email',
      'missing_supplement_info',
      'amount_mismatch',
    ].includes(hit.type)),
    hasExpiredError: hits.some(hit => hit.type === 'deadline_exceeded'),
    hasVerificationError: hits.some(hit => hit.type === 'security_verification'),
    primaryReason: hits[0]?.matched || '',
    classification,
  };
}

module.exports = {
  ERROR_RULES,
  SECURITY_MARKERS,
  classifyInvoicePage,
  classifyPageErrorText,
  normalizeText,
  normalizeIdentifier,
  looksLikeTaxNo,
};
