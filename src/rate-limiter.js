import config from './config.js';

const WINDOW_MS = 60_000; // 1-minute sliding window

/**
 * Sliding-window rate limiter. Tracks call timestamps and queues
 * requests that exceed the per-minute limit until a slot opens.
 */
class RateLimiter {
  /**
   * @param {string} name - Identifier for this limiter (e.g. 'claude', 'telegram')
   * @param {number} maxPerMinute - Maximum calls allowed per minute
   */
  constructor(name, maxPerMinute) {
    this.name = name;
    this.maxPerMinute = maxPerMinute;
    /** @type {number[]} Timestamps (ms) of recent calls */
    this._timestamps = [];
    /** @type {Array<{ resolve: () => void }>} Queued waiters */
    this._queue = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._drainTimer = null;
  }

  /**
   * Prune timestamps older than the sliding window.
   */
  _prune() {
    const cutoff = Date.now() - WINDOW_MS;
    while (this._timestamps.length > 0 && this._timestamps[0] <= cutoff) {
      this._timestamps.shift();
    }
  }

  /**
   * Attempt to drain queued waiters whenever a slot becomes available.
   */
  _scheduleDrain() {
    if (this._drainTimer !== null || this._queue.length === 0) {
      return;
    }

    // Determine when the oldest timestamp expires to free a slot
    this._prune();
    if (this._timestamps.length < this.maxPerMinute) {
      // Slot available right now
      this._drain();
      return;
    }

    const waitMs = this._timestamps[0] + WINDOW_MS - Date.now() + 1;
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      this._drain();
    }, Math.max(waitMs, 0));
  }

  /**
   * Release as many queued waiters as there are available slots.
   */
  _drain() {
    this._prune();
    while (this._queue.length > 0 && this._timestamps.length < this.maxPerMinute) {
      this._timestamps.push(Date.now());
      const waiter = this._queue.shift();
      waiter.resolve();
    }
    // If there are still queued items, schedule the next drain
    if (this._queue.length > 0) {
      this._scheduleDrain();
    }
  }

  /**
   * Acquire a rate-limit slot. Resolves immediately if under the limit;
   * otherwise queues and resolves when a slot opens.
   * @returns {Promise<void>}
   */
  acquire() {
    this._prune();

    if (this._timestamps.length < this.maxPerMinute) {
      this._timestamps.push(Date.now());
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this._queue.push({ resolve });
      this._scheduleDrain();
    });
  }

  /**
   * Returns the number of requests currently waiting in the queue.
   * @returns {number}
   */
  queueDepth() {
    return this._queue.length;
  }
}

/**
 * Factory that creates the standard rate limiters from config values.
 * @returns {{ claude: RateLimiter, telegram: RateLimiter }}
 */
function createRateLimiters() {
  return {
    claude: new RateLimiter('claude', config.RATE_LIMIT_CLAUDE),
    telegram: new RateLimiter('telegram', config.RATE_LIMIT_TELEGRAM),
  };
}

export { RateLimiter, createRateLimiters };
export default createRateLimiters;
