/**
 * perf.js — 轻量性能埋点（排查打字卡顿 / 预览延迟用）
 *
 * 用法：在 DevTools 控制台执行下面任一句后刷新页面，即可在 Console 看到
 *  - 输入 → 序列化 → 渲染 全链路的耗时（每行显示「距上一阶段」的 + 增量）
 *  - 主线程心跳：若某次心跳间隔远超 250ms，说明主线程当时被长时间阻塞
 *
 *   localStorage.setItem('penedit_perf', '1')   // 开启
 *   localStorage.removeItem('penedit_perf')     // 关闭
 */
let _last = 0;
let _enabled = null;
let _heartbeat = false;

function enabled() {
  if (_enabled === null) {
    try {
      _enabled = localStorage.getItem("penedit_perf") === "1";
    } catch (_) {
      _enabled = false;
    }
  }
  if (_enabled && !_heartbeat) {
    _heartbeat = true;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const gap = now - last;
      last = now;
      // 正常间隔≈250ms；若明显更大，说明两次心跳之间主线程被长时间阻塞
      if (gap > 400) {
        // eslint-disable-next-line no-console
        console.log(`[PERF-HEARTBEAT] 主线程被卡 ${gap.toFixed(0)}ms（正常应≈250ms）`);
      }
    }, 250);
  }
  return _enabled;
}

/** 标记一条时间线的起点（通常在输入事件里调用，重置「上一阶段」基准） */
export function perfReset() {
  if (enabled()) _last = performance.now();
}

/** 打印一个阶段及其与上一阶段的耗时增量 */
export function perfStage(name) {
  if (!enabled()) return;
  const now = performance.now();
  const dt = _last ? (now - _last).toFixed(1) : "0.0";
  // eslint-disable-next-line no-console
  console.log(`[PERF] ${name}  +${dt}ms`);
  _last = now;
}
