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
    // 帧率探针：连续监测每帧耗时。打字/滚动时若出现 >32ms 的帧（掉到 <30fps），
    // 说明渲染管线在卡（GPU 重绘 / 布局抖动）——这类 micro-jank 不会被 250ms 心跳抓到。
    let fLast = performance.now();
    let fMax = 0;
    let fOver32 = 0;
    let fOver50 = 0;
    let fCount = 0;
    function loop(t) {
      const dt = t - fLast;
      fLast = t;
      fCount++;
      if (dt > fMax) fMax = dt;
      if (dt > 32) fOver32++;
      if (dt > 50) fOver50++;
      // 每 1 秒汇总一次
      if (fCount >= 60) {
        if (fOver32 > 0) {
          // eslint-disable-next-line no-console
          console.log(`[PERF-FRAME] 1s 内 ${fCount} 帧，最长 ${fMax.toFixed(0)}ms，>32ms 掉帧 ${fOver32} 次，>50ms 严重掉帧 ${fOver50} 次`);
        }
        fMax = 0; fOver32 = 0; fOver50 = 0; fCount = 0;
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    // longtask 监测：浏览器原生报告「>50ms 的长任务」，直接点名阻塞归属
    // （如 spellcheck / 渲染 / 脚本）。关掉拼写检查后这里应不再出现 >500ms 的脚本长任务。
    if (typeof PerformanceObserver !== "undefined") {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.duration >= 500) {
              let who = "script";
              try {
                const a = e.attribution && e.attribution[0];
                if (a) who = a.name || a.containerType || a.containerSrc || "unknown";
              } catch (_) {}
              // eslint-disable-next-line no-console
              console.log(`[PERF-LONGTASK] 长任务 ${e.duration.toFixed(0)}ms 归属=${who}`);
            }
          }
        });
        obs.observe({ entryTypes: ["longtask"] });
      } catch (_) {}
    }
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

/** 仅在「某步耗时超过 threshold」时才打印，用于揪出预览渲染里偶发的灾难性慢步骤（不刷屏） */
export function perfSlow(name, dtMs, threshold = 50) {
  if (!enabled()) return;
  if (dtMs >= threshold) {
    // eslint-disable-next-line no-console
    console.log(`[PERF-SLOW] ${name} 耗时 ${dtMs.toFixed(0)}ms（阈值 ${threshold}ms）`);
  }
}
