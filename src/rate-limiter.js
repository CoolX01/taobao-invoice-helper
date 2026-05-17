'use strict';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

class RateLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.delayMin=1500]
   * @param {number} [opts.delayMax=3000]
   * @param {number} [opts.batchSize=10]
   * @param {number} [opts.batchPauseMin=5000]
   * @param {number} [opts.batchPauseMax=15000]
   * @param {number} [opts.cooldownDurationMs=300000]
   * @param {number} [opts.cooldownDelayMin=8000]
   * @param {number} [opts.cooldownDelayMax=20000]
   */
  constructor(opts = {}) {
    this.delayMin = opts.delayMin ?? 1500;
    this.delayMax = opts.delayMax ?? 3000;
    this.batchSize = opts.batchSize ?? 10;
    this.batchPauseMin = opts.batchPauseMin ?? 5000;
    this.batchPauseMax = opts.batchPauseMax ?? 15000;
    this.cooldownDurationMs = opts.cooldownDurationMs ?? 300000;
    this.cooldownDelayMin = opts.cooldownDelayMin ?? 8000;
    this.cooldownDelayMax = opts.cooldownDelayMax ?? 20000;

    this._successCount = 0;
    this._consecutiveFailures = 0;
    this._lastVerificationTs = 0;
  }

  /**
   * 根据当前状态计算等待时间并 sleep
   */
  async wait() {
    // 基础等待
    let delay = randomBetween(this.delayMin, this.delayMax);

    // 批次暂停：每处理 batchSize 个成功订单后额外等待
    if (this._successCount > 0 && this._successCount % this.batchSize === 0) {
      delay += randomBetween(this.batchPauseMin, this.batchPauseMax);
    }

    // 冷却期：最近触发过验证码
    const now = Date.now();
    if (this._lastVerificationTs > 0 &&
        (now - this._lastVerificationTs) < this.cooldownDurationMs) {
      delay += randomBetween(this.cooldownDelayMin, this.cooldownDelayMax);
    }

    // 连续失败指数退避
    if (this._consecutiveFailures > 0) {
      const backoff = Math.min(
        this.delayMin * Math.pow(1.5, this._consecutiveFailures),
        60000
      );
      delay += backoff;
    }

    await sleep(Math.round(delay));
  }

  /**
   * 记录一次成功
   */
  recordSuccess() {
    this._successCount++;
    this._consecutiveFailures = 0;
  }

  /**
   * 记录一次触发验证码/风控，进入冷却期
   */
  recordVerification() {
    this._lastVerificationTs = Date.now();
    this._consecutiveFailures++;
  }

  /**
   * 重置计数器
   */
  reset() {
    this._successCount = 0;
    this._consecutiveFailures = 0;
    this._lastVerificationTs = 0;
  }
}

module.exports = { RateLimiter };
