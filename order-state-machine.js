const ORDER_STATES = Object.freeze({
  PENDING: 'PENDING',
  CHECKING: 'CHECKING',
  CAN_APPLY: 'CAN_APPLY',
  APPLYING: 'APPLYING',
  APPLIED_WAITING: 'APPLIED_WAITING',
  CAN_DOWNLOAD: 'CAN_DOWNLOAD',
  DOWNLOADING: 'DOWNLOADING',
  DOWNLOADED: 'DOWNLOADED',
  NEED_REISSUE: 'NEED_REISSUE',
  REISSUING: 'REISSUING',
  REISSUED: 'REISSUED',
  NEED_CONTACT_SELLER: 'NEED_CONTACT_SELLER',
  CONTACTING_SELLER: 'CONTACTING_SELLER',
  CONTACTED_SELLER: 'CONTACTED_SELLER',
  NEED_PRICE_DIFF_CONFIRM: 'NEED_PRICE_DIFF_CONFIRM',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_FINAL: 'FAILED_FINAL',
  NEED_MANUAL_SECURITY_CHECK: 'NEED_MANUAL_SECURITY_CHECK',
  NEED_MANUAL_PAYMENT_CONFIRM: 'NEED_MANUAL_PAYMENT_CONFIRM',
});

const VALID_STATES = new Set(Object.values(ORDER_STATES));

function nowIso() {
  return new Date().toISOString();
}

function normalizeState(state, fallback = ORDER_STATES.PENDING) {
  return VALID_STATES.has(state) ? state : fallback;
}

function createOrderTrace(initialState = ORDER_STATES.PENDING) {
  return {
    currentState: normalizeState(initialState),
    events: [],
  };
}

function appendStateEvent(trace, event = {}) {
  const nextTrace = trace && Array.isArray(trace.events)
    ? trace
    : createOrderTrace(event.from || ORDER_STATES.PENDING);
  const from = normalizeState(event.from || nextTrace.currentState);
  const to = normalizeState(event.to || event.state || from, from);
  nextTrace.events.push({
    at: event.at || nowIso(),
    from,
    to,
    action: event.action || '',
    reason: event.reason || '',
    category: event.category || '',
    matchedRules: event.matchedRules || [],
    retry: Boolean(event.retry),
  });
  nextTrace.currentState = to;
  return nextTrace;
}

function deriveStateFromClassification(classification, fallback = ORDER_STATES.CHECKING) {
  return normalizeState(classification?.status, fallback);
}

function deriveStateFromExecution(execution = {}, fallback = ORDER_STATES.CHECKING) {
  const status = execution.status || '';
  const action = execution.action || '';
  const reason = `${execution.reason || ''} ${execution.manualReason || ''}`;

  if (execution.state) return normalizeState(execution.state, fallback);
  if (status === 'downloaded' || status === 'file_exists') return ORDER_STATES.DOWNLOADED;
  if (status === 'seller_contacted') return ORDER_STATES.CONTACTED_SELLER;
  if (status === 'chat_waiting_reply') return ORDER_STATES.CONTACTED_SELLER;
  if (status === 'pending') return ORDER_STATES.APPLIED_WAITING;
  if (status === 'submitted') {
    if (action === 'reissue_invoice' || action === 'modify_invoice') return ORDER_STATES.REISSUED;
    return ORDER_STATES.APPLIED_WAITING;
  }
  if (status === 'expired_deadline') return ORDER_STATES.NEED_CONTACT_SELLER;
  if (status === 'manual_required') {
    if (/验证|验证码|滑块|登录|风控|安全/.test(reason)) return ORDER_STATES.NEED_MANUAL_SECURITY_CHECK;
    if (/付款|支付|补差|差价|差额/.test(reason)) return ORDER_STATES.NEED_MANUAL_PAYMENT_CONFIRM;
    return ORDER_STATES.FAILED_FINAL;
  }
  if (status === 'blocked' || status === 'error') return ORDER_STATES.FAILED_RETRYABLE;
  if (status === 'skipped') return fallback;
  return fallback;
}

function isTerminalState(state) {
  return new Set([
    ORDER_STATES.DOWNLOADED,
    ORDER_STATES.CONTACTED_SELLER,
    ORDER_STATES.APPLIED_WAITING,
    ORDER_STATES.REISSUED,
    ORDER_STATES.FAILED_FINAL,
    ORDER_STATES.NEED_MANUAL_SECURITY_CHECK,
    ORDER_STATES.NEED_MANUAL_PAYMENT_CONFIRM,
    ORDER_STATES.NEED_PRICE_DIFF_CONFIRM,
  ]).has(state);
}

module.exports = {
  ORDER_STATES,
  createOrderTrace,
  appendStateEvent,
  deriveStateFromClassification,
  deriveStateFromExecution,
  isTerminalState,
  normalizeState,
};
