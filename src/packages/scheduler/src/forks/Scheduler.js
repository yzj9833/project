/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/* eslint-disable no-var */

import type { PriorityLevel } from "../SchedulerPriorities";

import {
  enableSchedulerDebugging,
  enableProfiling,
  frameYieldMs,
  userBlockingPriorityTimeout,
  lowPriorityTimeout,
  normalPriorityTimeout,
} from "../SchedulerFeatureFlags";

import { push, pop, peek } from "../SchedulerMinHeap";

// TODO: Use symbols?
import {
  ImmediatePriority,
  UserBlockingPriority,
  NormalPriority,
  LowPriority,
  IdlePriority,
} from "../SchedulerPriorities";
import {
  markTaskRun,
  markTaskYield,
  markTaskCompleted,
  markTaskCanceled,
  markTaskErrored,
  markSchedulerSuspended,
  markSchedulerUnsuspended,
  markTaskStart,
  stopLoggingProfilingEvents,
  startLoggingProfilingEvents,
} from "../SchedulerProfiling";

export type Callback = (boolean) => ?Callback;

export opaque type Task = {
  id: number,
  callback: Callback | null,
  priorityLevel: PriorityLevel,
  startTime: number,
  expirationTime: number,
  sortIndex: number,
  isQueued?: boolean,
};

let getCurrentTime: () => number | DOMHighResTimeStamp;
const hasPerformanceNow =
  // $FlowFixMe[method-unbinding]
  typeof performance === "object" && typeof performance.now === "function";

if (hasPerformanceNow) {
  const localPerformance = performance;
  getCurrentTime = () => localPerformance.now();
} else {
  const localDate = Date;
  const initialTime = localDate.now();
  getCurrentTime = () => localDate.now() - initialTime;
}

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Tasks are stored on a min heap
var taskQueue: Array<Task> = [];
var timerQueue: Array<Task> = [];

// Incrementing id counter. Used to maintain insertion order.
var taskIdCounter = 1;

// Pausing the scheduler is useful for debugging.
var isSchedulerPaused = false;

var currentTask = null;
var currentPriorityLevel = NormalPriority;

// This is set while performing work, to prevent re-entrance.
var isPerformingWork = false;

var isHostCallbackScheduled = false;
var isHostTimeoutScheduled = false;

// Capture local references to native APIs, in case a polyfill overrides them.
const localSetTimeout = typeof setTimeout === "function" ? setTimeout : null;
const localClearTimeout =
  typeof clearTimeout === "function" ? clearTimeout : null;
const localSetImmediate =
  typeof setImmediate !== "undefined" ? setImmediate : null; // IE and Node.js + jsdom

function advanceTimers(currentTime: number) {
  // Check for tasks that are no longer delayed and add them to the queue.
  let timer = peek(timerQueue);
  while (timer !== null) {
    if (timer.callback === null) {
      // Timer was cancelled.
      pop(timerQueue);
    } else if (timer.startTime <= currentTime) {
      // Timer fired. Transfer to the task queue.
      pop(timerQueue);
      timer.sortIndex = timer.expirationTime;
      push(taskQueue, timer);
      if (enableProfiling) {
        markTaskStart(timer, currentTime);
        timer.isQueued = true;
      }
    } else {
      // Remaining timers are pending.
      return;
    }
    timer = peek(timerQueue);
  }
}

function handleTimeout(currentTime: number) {
  isHostTimeoutScheduled = false;
  advanceTimers(currentTime);

  if (!isHostCallbackScheduled) {
    if (peek(taskQueue) !== null) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    } else {
      const firstTimer = peek(timerQueue);
      if (firstTimer !== null) {
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
    }
  }
}

function flushWork(initialTime: number) {
  if (enableProfiling) {
    markSchedulerUnsuspended(initialTime);
  }

  // We'll need a host callback the next time work is scheduled.
  isHostCallbackScheduled = false;
  if (isHostTimeoutScheduled) {
    // We scheduled a timeout but it's no longer needed. Cancel it.
    isHostTimeoutScheduled = false;
    cancelHostTimeout();
  }

  isPerformingWork = true;
  const previousPriorityLevel = currentPriorityLevel;
  try {
    if (enableProfiling) {
      try {
        return workLoop(initialTime);
      } catch (error) {
        if (currentTask !== null) {
          const currentTime = getCurrentTime();
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskErrored(currentTask, currentTime);
          // $FlowFixMe[incompatible-use] found when upgrading Flow
          currentTask.isQueued = false;
        }
        throw error;
      }
    } else {
      // No catch in prod code path.
      return workLoop(initialTime);
    }
  } finally {
    currentTask = null;
    currentPriorityLevel = previousPriorityLevel;
    isPerformingWork = false;
    if (enableProfiling) {
      const currentTime = getCurrentTime();
      markSchedulerSuspended(currentTime);
    }
  }
}

function workLoop(initialTime: number) {

  let currentTime = initialTime;
  advanceTimers(currentTime);
  currentTask = peek(taskQueue);
  while (
    currentTask !== null &&
    !(enableSchedulerDebugging && isSchedulerPaused)
  ) {
    if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
      // This currentTask hasn't expired, and we've reached the deadline.
      break;
    }
    // $FlowFixMe[incompatible-use] found when upgrading Flow
    const callback = currentTask.callback;
    if (typeof callback === "function") {
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      currentTask.callback = null;
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      currentPriorityLevel = currentTask.priorityLevel;
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
      if (enableProfiling) {
        // $FlowFixMe[incompatible-call] found when upgrading Flow
        markTaskRun(currentTask, currentTime);
      }
      const continuationCallback = callback(didUserCallbackTimeout);
      currentTime = getCurrentTime();
      if (typeof continuationCallback === "function") {
        // If a continuation is returned, immediately yield to the main thread
        // regardless of how much time is left in the current time slice.
        // $FlowFixMe[incompatible-use] found when upgrading Flow
        currentTask.callback = continuationCallback;
        if (enableProfiling) {
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskYield(currentTask, currentTime);
        }
        advanceTimers(currentTime);
        return true;
      } else {
        if (enableProfiling) {
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskCompleted(currentTask, currentTime);
          // $FlowFixMe[incompatible-use] found when upgrading Flow
          currentTask.isQueued = false;
        }
        if (currentTask === peek(taskQueue)) {
          pop(taskQueue);
        }
        advanceTimers(currentTime);
      }
    } else {
      pop(taskQueue);
    }
    currentTask = peek(taskQueue);
  }
  // Return whether there's additional work
  if (currentTask !== null) {
    return true;
  } else {
    const firstTimer = peek(timerQueue);
    if (firstTimer !== null) {
      requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
    }
    return false;
  }
}

function unstable_runWithPriority<T>(
  priorityLevel: PriorityLevel,
  eventHandler: () => T
): T {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_next<T>(eventHandler: () => T): T {
  var priorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      // Shift down to normal priority
      priorityLevel = NormalPriority;
      break;
    default:
      // Anything lower than normal priority should remain at the current level.
      priorityLevel = currentPriorityLevel;
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_wrapCallback<T: (...Array<mixed>) => mixed>(callback: T): T {
  var parentPriorityLevel = currentPriorityLevel;
  // $FlowFixMe[incompatible-return]
  // $FlowFixMe[missing-this-annot]
  return function () {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    currentPriorityLevel = parentPriorityLevel;

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
    }
  };
}

function unstable_scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: Callback,
  options?: { delay: number }
): Task {
  var currentTime = getCurrentTime();

  var startTime;
  if (typeof options === "object" && options !== null) {
    var delay = options.delay;
    if (typeof delay === "number" && delay > 0) {
      startTime = currentTime + delay;
    } else {
      startTime = currentTime;
    }
  } else {
    startTime = currentTime;
  }

  var timeout;
  switch (priorityLevel) {
    case ImmediatePriority:
      // Times out immediately
      timeout = -1;
      break;
    case UserBlockingPriority:
      // Eventually times out
      timeout = userBlockingPriorityTimeout;
      break;
    case IdlePriority:
      // Never times out
      timeout = maxSigned31BitInt;
      break;
    case LowPriority:
      // Eventually times out
      timeout = lowPriorityTimeout;
      break;
    case NormalPriority:
    default:
      // Eventually times out
      timeout = normalPriorityTimeout;
      break;
  }

  var expirationTime = startTime + timeout;

  var newTask: Task = {
    id: taskIdCounter++,
    callback,
    priorityLevel,
    startTime,
    expirationTime,
    sortIndex: -1,
  };
  if (enableProfiling) {
    newTask.isQueued = false;
  }

  if (startTime > currentTime) {
    // This is a delayed task.
    newTask.sortIndex = startTime;
    push(timerQueue, newTask);
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      // All tasks are delayed, and this is the task with the earliest delay.
      if (isHostTimeoutScheduled) {
        // Cancel an existing timeout.
        cancelHostTimeout();
      } else {
        isHostTimeoutScheduled = true;
      }
      // Schedule a timeout.
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {
    newTask.sortIndex = expirationTime;
    push(taskQueue, newTask);
    if (enableProfiling) {
      markTaskStart(newTask, currentTime);
      newTask.isQueued = true;
    }
    // Schedule a host callback, if needed. If we're already performing work,
    // wait until the next time we yield.
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    }
  }

  return newTask;
}

function unstable_pauseExecution() {
  isSchedulerPaused = true;
}

function unstable_continueExecution() {
  isSchedulerPaused = false;
  if (!isHostCallbackScheduled && !isPerformingWork) {
    isHostCallbackScheduled = true;
    requestHostCallback();
  }
}

function unstable_getFirstCallbackNode(): Task | null {
  return peek(taskQueue);
}

function unstable_cancelCallback(task: Task) {
  if (enableProfiling) {
    if (task.isQueued) {
      const currentTime = getCurrentTime();
      markTaskCanceled(task, currentTime);
      task.isQueued = false;
    }
  }

  // Null out the callback to indicate the task has been canceled. (Can't
  // remove from the queue because you can't remove arbitrary nodes from an
  // array based heap, only the first one.)
  task.callback = null;
}

function unstable_getCurrentPriorityLevel(): PriorityLevel {
  return currentPriorityLevel;
}

let isMessageLoopRunning = false;
let taskTimeoutID: TimeoutID = (-1: any);

// Scheduler periodically yields in case there is other work on the main
// thread, like user events. By default, it yields multiple times per frame.
// It does not attempt to align with frame boundaries, since most tasks don't
// need to be frame aligned; for those that do, use requestAnimationFrame.
let frameInterval = frameYieldMs;
let startTime = -1;

function shouldYieldToHost(): boolean {
  const timeElapsed = getCurrentTime() - startTime;
  if (timeElapsed < frameInterval) {
    // The main thread has only been blocked for a really short amount of time;
    // smaller than a single frame. Don't yield yet.
    return false;
  }
  // Yield now.
  return true;
}

function requestPaint() {}

function forceFrameRate(fps: number) {
  if (fps < 0 || fps > 125) {
    // Using console['error'] to evade Babel and ESLint
    console["error"](
      "forceFrameRate takes a positive int between 0 and 125, " +
        "forcing frame rates higher than 125 fps is not supported"
    );
    return;
  }
  if (fps > 0) {
    frameInterval = Math.floor(1000 / fps);
  } else {
    // reset the framerate
    frameInterval = frameYieldMs;
  }
}

const performWorkUntilDeadline = () => {
  if (isMessageLoopRunning) {
    const currentTime = getCurrentTime();
    // Keep track of the start time so we can measure how long the main thread
    // has been blocked.
    startTime = currentTime;

    // If a scheduler task throws, exit the current browser task so the
    // error can be observed.
    //
    // Intentionally not using a try-catch, since that makes some debugging
    // techniques harder. Instead, if `flushWork` errors, then `hasMoreWork` will
    // remain true, and we'll continue the work loop.
    let hasMoreWork = true;
    try {
      hasMoreWork = flushWork(currentTime);
    } finally {
      if (hasMoreWork) {
        // If there's more work, schedule the next message event at the end
        // of the preceding one.
        schedulePerformWorkUntilDeadline();
      } else {
        isMessageLoopRunning = false;
      }
    }
  }
};

let schedulePerformWorkUntilDeadline;

if (typeof localSetImmediate === "function") {
  // Node.js 和旧版 IE 环境。
  // 有几个原因说明我们优先使用 setImmediate。
  //
  // 与 MessageChannel 不同，它不会阻止 Node.js 进程退出。
  // （即使这是调度器的 DOM 分支，你可能会在混合 Node.js 15+
  // 的情况下到达这里，该版本有 MessageChannel 和 jsdom。）
  // 参考链接: https://github.com/facebook/react/issues/20756
  //
  // 而且，它运行得更早，这是我们想要的语义。
  // 如果其他浏览器也实现了它，使用它会更好。
  // 尽管这两者都不如原生调度的效果好。
  schedulePerformWorkUntilDeadline = () => {
    localSetImmediate(performWorkUntilDeadline);
  };
} else if (typeof MessageChannel !== "undefined") {
  // DOM 和 Worker 环境。
  // 我们优先使用 MessageChannel，因为它避免了 4ms setTimeout 的限制。
  const channel = new MessageChannel(); // 创建一个新的消息通道
  const port = channel.port2; // 获取通道的端口 2
  channel.port1.onmessage = performWorkUntilDeadline; // 监听端口 1 的消息
  schedulePerformWorkUntilDeadline = () => {
    port.postMessage(null); // 向端口 2 发送消息以触发工作
  };
} else {
  // 我们只在非浏览器环境中回退到这里。
  schedulePerformWorkUntilDeadline = () => {
    // 使用 localSetTimeout（尽管可能会是 null），
    // 将 performWorkUntilDeadline 安排到下一个事件循环。
    // $FlowFixMe[not-a-function] nullable value
    localSetTimeout(performWorkUntilDeadline, 0);
  };
}

function requestHostCallback() {
  if (!isMessageLoopRunning) {
    isMessageLoopRunning = true;
    console.log("requestHostCallback...");
    schedulePerformWorkUntilDeadline();
  }
}

function requestHostTimeout(
  callback: (currentTime: number) => void,
  ms: number
) {
  // $FlowFixMe[not-a-function] nullable value
  taskTimeoutID = localSetTimeout(() => {
    callback(getCurrentTime());
  }, ms);
}

function cancelHostTimeout() {
  // $FlowFixMe[not-a-function] nullable value
  localClearTimeout(taskTimeoutID);
  taskTimeoutID = ((-1: any): TimeoutID);
}

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  shouldYieldToHost as unstable_shouldYield,
  requestPaint as unstable_requestPaint,
  unstable_continueExecution,
  unstable_pauseExecution,
  unstable_getFirstCallbackNode,
  getCurrentTime as unstable_now,
  forceFrameRate as unstable_forceFrameRate,
};

export const unstable_Profiling: {
  startLoggingProfilingEvents(): void,
  stopLoggingProfilingEvents(): ArrayBuffer | null,
} | null = enableProfiling
  ? {
      startLoggingProfilingEvents,
      stopLoggingProfilingEvents,
    }
  : null;
