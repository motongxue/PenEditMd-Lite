/**
 * perf.js — 轻量性能埋点（排查打字卡顿 / 预览延迟用）
 *
 * 用法一（控制台手动开）：
 *   localStorage.setItem('penedit_perf', '1')   // 开启（仅 Console）
 *   localStorage.removeItem('penedit_perf')     // 关闭
 *
 * 用法二（自动开 + 写文件，调试版用）：把下方 AUTO 置 true，
 * 探针会在应用启动即运行，并把所有 [PERF*] 行同时写到
 *   <用户数据>/penedit-perf.log
 * 这样无需开 DevTools，用户打字后 AI 直接读该文件即可定位卡点。
 * 调试完把 AUTO 改回 false 即可关闭。
 */
let _last = 0;
let _enabled = null;
let _heartbeat = false;
let _lastStage = "(none)"; // 最后一个 perfStage / perfMark 名称：心跳/ping 检测到阻塞时打印，定位冻结紧跟哪步

// ⚠️ 调试打字卡顿时临时置 true；定位完改回 false 再构建。
const AUTO = false;

/** 写一行到 Console，并（若可用）通过主进程 IPC 落盘到 penedit-perf.log */
function emit(line) {
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    if (typeof window !== "undefined" && window.api && window.api.debugLog) {
      window.api.debugLog(line, "penedit-perf.log");
    }
  } catch (_) {}
}

/** 仅更新「最后阶段」标记，不打印（供心跳/ping 在阻塞时归因，又不刷屏） */
export function perfMark(name) {
  if (!enabled()) return;
  _lastStage = name;
}


function enabled() {
  if (_enabled === null) {
    if (AUTO) _enabled = true;
    else {
      try {
        _enabled = localStorage.getItem("penedit_perf") === "1";
      } catch (_) {
        _enabled = false;
      }
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
        emit(`[PERF-HEARTBEAT] 主线程被卡 ${gap.toFixed(0)}ms（正常应≈250ms）← 阻塞前最后阶段: ${_lastStage}`);
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
          emit(`[PERF-FRAME] 1s 内 ${fCount} 帧，最长 ${fMax.toFixed(0)}ms，>32ms 掉帧 ${fOver32} 次，>50ms 严重掉帧 ${fOver50} 次`);
        }
        fMax = 0; fOver32 = 0; fOver50 = 0; fCount = 0;
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    // longtask 监测：浏览器原生报告「>=50ms 的长任务」，直接点名阻塞归属
    // （如 spellcheck / 渲染 / 脚本）。门槛降到 80ms，便于抓到打字时那一下 ~100ms 掉帧的归属。
    if (typeof PerformanceObserver !== "undefined") {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.duration >= 80) {
              let who = "script";
              try {
                const a = e.attribution && e.attribution[0];
                if (a) who = a.name || a.containerType || a.containerSrc || "unknown";
              } catch (_) {}
              // eslint-disable-next-line no-console
              emit(`[PERF-LONGTASK] 长任务 ${e.duration.toFixed(0)}ms 归属=${who}`);
            }
          }
        });
        obs.observe({ entryTypes: ["longtask"] });
      } catch (_) {}
    }
    // MessageChannel 心跳探针：0 延迟宏任务循环，测量「发出→接收」的间隔。
    // 它会被任何主线程阻塞延迟——包括 IME 组词处理（这类输入处理 Chromium 的 longtask 不报告，
    // 所以单独用这个探针兜底）。>200ms 即判定阻塞，打印延迟与阻塞前最后阶段。
    if (typeof MessageChannel !== "undefined") {
      try {
        const ch = new MessageChannel();
        let pingT = 0;
        ch.port2.onmessage = () => {
          const dt = performance.now() - pingT;
          if (dt > 200) {
            emit(`[PERF-PING] 主线程阻塞 ${dt.toFixed(0)}ms ← 阻塞前最后阶段: ${_lastStage}`);
          }
          pingT = performance.now();
          ch.port1.postMessage(0);
        };
        pingT = performance.now();
        ch.port1.postMessage(0);
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
  _lastStage = name; // 记下最后阶段，心跳阻塞时打印，用于定位冻结紧跟哪步
  // eslint-disable-next-line no-console
  console.log(`[PERF] ${name}  +${dt}ms`);
  _last = now;
}

/** 仅在「某步耗时超过 threshold」时才打印，用于揪出预览渲染里偶发的灾难性慢步骤（不刷屏） */
export function perfSlow(name, dtMs, threshold = 50) {
  if (!enabled()) return;
  if (dtMs >= threshold) {
    emit(`[PERF-SLOW] ${name} 耗时 ${dtMs.toFixed(0)}ms（阈值 ${threshold}ms）`);
  }
}

/** 打印某步的【真实自耗时】（由调用方用 performance.now() 包围测量），
 *  不受「上一条日志间隔」污染——[PERF]* +Xms 的间隔数字常把空闲/节流时间算进某步，
 *  误区：看 scrollSync +3351ms 以为滚动同步慢，其实只是中间空闲了 3 秒。
 *  用本函数打出来的 self=+Xms 才是该步真正干活的时间。 */
export function perfSelf(name, dtMs) {
  if (!enabled()) return;
  _lastStage = name;
  const dt = dtMs.toFixed(1);
  emit(`[PERF] ${name} self=+${dt}ms`);
}

// 调试版：自动开启探针（AUTO=true 时），并在启动时打一行会话标记，便于读日志时区分每次运行。
if (AUTO) {
  enabled();
  emit(`[PERF] === 性能探针已启动 (AUTO) @ ${new Date().toISOString()} ===`);
}
