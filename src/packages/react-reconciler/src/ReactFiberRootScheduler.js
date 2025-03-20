/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { FiberRoot } from "./ReactInternalTypes";
import type { Lane, Lanes } from "./ReactFiberLane";
import type { PriorityLevel } from "scheduler/src/SchedulerPriorities";
import type { BatchConfigTransition } from "./ReactFiberTracingMarkerComponent";

import {
  disableLegacyMode,
  enableDeferRootSchedulingToMicrotask,
  disableSchedulerTimeoutInWorkLoop,
  enableProfilerTimer,
  enableProfilerNestedUpdatePhase,
} from "shared/ReactFeatureFlags";
import {
  NoLane,
  NoLanes,
  SyncLane,
  getHighestPriorityLane,
  getNextLanes,
  includesSyncLane,
  markStarvedLanesAsExpired,
  claimNextTransitionLane,
  getNextLanesToFlushSync,
} from "./ReactFiberLane";
import {
  CommitContext,
  NoContext,
  RenderContext,
  flushPassiveEffects,
  getExecutionContext,
  getWorkInProgressRoot,
  getWorkInProgressRootRenderLanes,
  isWorkLoopSuspendedOnData,
  performWorkOnRoot,
} from "./ReactFiberWorkLoop";
import { LegacyRoot } from "./ReactRootTags";
import {
  ImmediatePriority as ImmediateSchedulerPriority,
  UserBlockingPriority as UserBlockingSchedulerPriority,
  NormalPriority as NormalSchedulerPriority,
  IdlePriority as IdleSchedulerPriority,
  cancelCallback as Scheduler_cancelCallback,
  scheduleCallback as Scheduler_scheduleCallback,
  now,
} from "./Scheduler";
import {
  DiscreteEventPriority,
  ContinuousEventPriority,
  DefaultEventPriority,
  IdleEventPriority,
  lanesToEventPriority,
} from "./ReactEventPriorities";
import {
  supportsMicrotasks,
  scheduleMicrotask,
  shouldAttemptEagerTransition,
} from "./ReactFiberConfig";

import ReactSharedInternals from "shared/ReactSharedInternals";
import {
  resetNestedUpdateFlag,
  syncNestedUpdateFlag,
} from "./ReactProfilerTimer";

// A linked list of all the roots with pending work. In an idiomatic app,
// there's only a single root, but we do support multi root apps, hence this
// extra complexity. But this module is optimized for the single root case.
let firstScheduledRoot: FiberRoot | null = null;
let lastScheduledRoot: FiberRoot | null = null;

// Used to prevent redundant mircotasks from being scheduled.
let didScheduleMicrotask: boolean = false;
// `act` "microtasks" are scheduled on the `act` queue instead of an actual
// microtask, so we have to dedupe those separately. This wouldn't be an issue
// if we required all `act` calls to be awaited, which we might in the future.
let didScheduleMicrotask_act: boolean = false;

// Used to quickly bail out of flushSync if there's no sync work to do.
let mightHavePendingSyncWork: boolean = false;

let isFlushingWork: boolean = false;

let currentEventTransitionLane: Lane = NoLane;

export function ensureRootIsScheduled(root: FiberRoot): void {
  //  任何节点调度都会执行
  //  1、确保一个待处理的微任务处理调度
  //  2.在scheduleTaskForRootDuringMicrotask之前，大部分都不会调用
  // Add the root to the schedule
  if (root === lastScheduledRoot || root.next !== null) {
    // Fast path. This root is already scheduled.
  } else {
    if (lastScheduledRoot === null) {
      //  当前调度跟上一次调度都是root
      firstScheduledRoot = lastScheduledRoot = root;
    } else {
      lastScheduledRoot.next = root;
      lastScheduledRoot = root;
    }
  }

  // Any time a root received an update, we set this to true until the next time
  // we process the schedule. If it's false, then we can quickly exit flushSync
  // without consulting the schedule.
  mightHavePendingSyncWork = true;

  // At the end of the current event, go through each of the roots and ensure
  // there's a task scheduled for each one at the correct priority.
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    // We're inside an `act` scope.
    if (!didScheduleMicrotask_act) {
      didScheduleMicrotask_act = true;
      scheduleImmediateTask(processRootScheduleInMicrotask);
    }
  } else {
    if (!didScheduleMicrotask) {
      didScheduleMicrotask = true;
      scheduleImmediateTask(processRootScheduleInMicrotask);
    }
  }
  //  不启用延迟到微任务的特性。直接调度。目前一直为true
  if (!enableDeferRootSchedulingToMicrotask) {
    // While this flag is disabled, we schedule the render task immediately
    // instead of waiting a microtask.
    // TODO: We need to land enableDeferRootSchedulingToMicrotask ASAP to
    // unblock additional features we have planned.
    scheduleTaskForRootDuringMicrotask(root, now());
  }

  if (
    __DEV__ &&
    !disableLegacyMode &&
    ReactSharedInternals.isBatchingLegacy &&
    root.tag === LegacyRoot
  ) {
    // Special `act` case: Record whenever a legacy update is scheduled.
    ReactSharedInternals.didScheduleLegacyUpdate = true;
  }
}

export function flushSyncWorkOnAllRoots() {
  // This is allowed to be called synchronously, but the caller should check
  // the execution context first.
  flushSyncWorkAcrossRoots_impl(NoLanes, false);
}

export function flushSyncWorkOnLegacyRootsOnly() {
  // This is allowed to be called synchronously, but the caller should check
  // the execution context first.
  if (!disableLegacyMode) {
    flushSyncWorkAcrossRoots_impl(NoLanes, true);
  }
}

function flushSyncWorkAcrossRoots_impl(
  syncTransitionLanes, // 需要被同步处理的 transition lanes
  onlyLegacy // 是否仅处理 legacy（老旧模式）的 root
) {
  if (isFlushingWork) {
    // 防止函数重入（reentrancy），如果已经在处理工作，则直接返回。
    // 这种防御性检查确保不会在嵌套调用时多次执行刷新。
    return;
  }

  if (!mightHavePendingSyncWork) {
    // 快速路径：如果没有同步工作需要处理，直接返回。
    return;
  }

  // 初始化标志，用于记录是否有实际的工作被执行。
  let didPerformSomeWork;
  isFlushingWork = true; // 标记当前正在处理同步工作。

  // 开始执行同步工作，确保所有需要处理的 root 都被刷新。
  do {
    didPerformSomeWork = false; // 重置标志，开始一轮工作。
    let root = firstScheduledRoot; // 从调度队列中的第一个 root 开始处理。
    while (root !== null) {
      // 如果只处理 legacy 模式并且该 root 不是 legacy 模式的，跳过该 root。
      if (onlyLegacy && (disableLegacyMode || root.tag !== LegacyRoot)) {
        // 跳过非 legacy 模式的 root。
      } else {
        // 如果 syncTransitionLanes 存在，则尝试处理对应的同步工作。
        if (syncTransitionLanes !== NoLanes) {
          const nextLanes = getNextLanesToFlushSync(root, syncTransitionLanes);
          if (nextLanes !== NoLanes) {
            // 如果这个 root 有需要同步刷新的工作，执行该工作。
            didPerformSomeWork = true; // 标记为已执行工作。
            performSyncWorkOnRoot(root, nextLanes); // 执行同步工作。
          }
        } else {
          // 如果没有 syncTransitionLanes，检查是否有同步工作。
          const workInProgressRoot = getWorkInProgressRoot(); // 获取当前正在工作的 root。
          const workInProgressRootRenderLanes =
            getWorkInProgressRootRenderLanes(); // 获取当前渲染中的 lanes。
          const nextLanes = getNextLanes(
            root,
            // 如果 root 是当前的工作 root，则使用它的 lanes；否则不使用 lanes。
            root === workInProgressRoot
              ? workInProgressRootRenderLanes
              : NoLanes
          );
          if (includesSyncLane(nextLanes)) {
            // 如果这个 root 有同步工作的 lane，执行该工作。
            didPerformSomeWork = true; // 标记为已执行工作。
            performSyncWorkOnRoot(root, nextLanes); // 执行同步工作。
          }
        }
      }
      // 移动到下一个 root 继续检查。
      root = root.next;
    }
  } while (didPerformSomeWork);
  // 只要有工作执行过，就会继续执行循环，直到没有同步工作为止。

  isFlushingWork = false; // 处理完成后，重置标记。
}
//  在微任务中处理根节点的调度
function processRootScheduleInMicrotask() {
  // 此函数总是在微任务中调用，不能同步调用。
  didScheduleMicrotask = false; // 关闭微任务的调度锁
  mightHavePendingSyncWork = false;// 初始化可能存在同步工作的标识

  /**  过渡任务紧急处理区start   **/  
  let syncTransitionLanes = NoLanes; // 重置 Transition 任务的优先级。
  if (currentEventTransitionLane !== NoLane) {
    // 检查当前事件中是否有正在进行的 Transition（异步更新）。
    if (shouldAttemptEagerTransition()) {
      // 如果条件允许，我们会尝试将 Transition 工作同步渲染。
      // 例如：在 popstate（浏览器回退/前进）事件中，我们会尝试同步渲染以保留页面滚动位置。
      syncTransitionLanes = currentEventTransitionLane;
    }
    currentEventTransitionLane = NoLane; // 处理完后，清空当前的 Transition。
  }
  /**  过渡任务紧急处理区end   **/  

  const currentTime = now(); // 获取当前时间，用于调度任务。
  let prev = null; // 记录链表中的前一个 root。
  let root = firstScheduledRoot; // 从链表的第一个 root 开始迭代调度。
  //  while循环多根节点，并处理
  while (root !== null) {
    const next = root.next; // 提前保存下一个root的引用，防止修改链表导致丢失
    //  提取当前root下的待处理任务通道集合
    const nextLanes = scheduleTaskForRootDuringMicrotask(root, currentTime);
    // 计算当前 root 在本次微任务中的需要处理的工作（Lanes）。

    if (nextLanes === NoLane) {
      // 该root没有待处理的任务了。进入下一个root循环
      root.next = null;
      if (prev === null) {
        // 如果 prev 为 null，说明当前 root 是第一个节点，将链表头更新为下一个 root。
        firstScheduledRoot = next;
      } else {
        // 否则，将前一个 root 的 next 指向下一个 root，跳过当前 root。
        prev.next = next;
      }
      if (next === null) {
        // 如果 next 为 null，说明当前 root 是最后一个节点，更新链表的尾部。
        lastScheduledRoot = prev;
      }
    } else {
      // 如果 root 仍然有工作需要处理，将其保留在调度链表中。
      prev = root;

      // 这是一个快速路径优化，目的是尽早退出 `flushSyncWorkOnAllRoots`。
      // 判断紧急transition任务或者同步任务
      if (
        syncTransitionLanes !== NoLanes || // 如果有同步 Transition 工作，就标记同步工作存在。
        includesSyncLane(nextLanes) // 否则，检查是否有同步的 lanes。
      ) {
        mightHavePendingSyncWork = true; // 标记当前可能存在同步工作。
      }
    }
    root = next; // 移动到下一个 root 继续遍历。
  }

  // 在微任务的末尾，刷新所有待处理的同步工作。
  // 必须放在最后执行，因为这些工作涉及实际的渲染操作，可能会抛出错误。
  flushSyncWorkAcrossRoots_impl(syncTransitionLanes, false);
}

function scheduleTaskForRootDuringMicrotask(root: FiberRoot,currentTime: number): Lane {
  // 调用场景：微任务内部调用，或者渲染最后。不会同步执行React的任务中

  //  标记过期任务，解决饥饿问题
  markStarvedLanesAsExpired(root, currentTime);

  // 确认下一个要处理的优先级通道
  const workInProgressRoot = getWorkInProgressRoot();
  const workInProgressRootRenderLanes = getWorkInProgressRootRenderLanes();
  const nextLanes = getNextLanes(
    root,
    root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes
  );

  const existingCallbackNode = root.callbackNode;
  if (
    nextLanes === NoLanes ||//  没有任务
    (root === workInProgressRoot && isWorkLoopSuspendedOnData()) ||// 当前root处于suspense刮起阶段
    root.cancelPendingCommit !== null// 提交阶段报错/高优先级打断等
  ) {
    //  
    //  取消调度
    // Fast path: There's nothing to work on.
    if (existingCallbackNode !== null) {
      cancelCallback(existingCallbackNode);
    }
    root.callbackNode = null;
    root.callbackPriority = NoLane;
    return NoLane;
  }

  // 处理同步任务
  if (includesSyncLane(nextLanes)) {
    // Synchronous work is always flushed at the end of the microtask, so we
    // don't need to schedule an additional task.
    if (existingCallbackNode !== null) {
      cancelCallback(existingCallbackNode);
    }
    root.callbackPriority = SyncLane;
    root.callbackNode = null;
    return SyncLane;
  } else {
    // 异步任务，获取任务通道中最高优先级
    const existingCallbackPriority = root.callbackPriority;
    const newCallbackPriority = getHighestPriorityLane(nextLanes);
    // 判断已存在调度任务情况下，是否取消任务
    if (
      newCallbackPriority === existingCallbackPriority &&
      !(
        __DEV__ &&
        ReactSharedInternals.actQueue !== null &&
        existingCallbackNode !== fakeActCallbackNode
      )
    ) {
      // 相同优先级，复用现有的任务
      return newCallbackPriority;
    } else {
      //  取消旧任务调度
      cancelCallback(existingCallbackNode);
    }
    // 转换优先级
    let schedulerPriorityLevel;
    switch (lanesToEventPriority(nextLanes)) {
      case DiscreteEventPriority:
        schedulerPriorityLevel = ImmediateSchedulerPriority;
        break;
      case ContinuousEventPriority:
        schedulerPriorityLevel = UserBlockingSchedulerPriority;
        break;
      case DefaultEventPriority:
        schedulerPriorityLevel = NormalSchedulerPriority;
        break;
      case IdleEventPriority:
        schedulerPriorityLevel = IdleSchedulerPriority;
        break;
      default:
        schedulerPriorityLevel = NormalSchedulerPriority;
        break;
    }
    //  调度任务
    const newCallbackNode = scheduleCallback(
      schedulerPriorityLevel,
      performWorkOnRootViaSchedulerTask.bind(null, root)
    );

    root.callbackPriority = newCallbackPriority;
    root.callbackNode = newCallbackNode;
    return newCallbackPriority;
  }
}

type RenderTaskFn = (didTimeout: boolean) => RenderTaskFn | null;

function performWorkOnRootViaSchedulerTask(// 这是通过Scheduler（以及未来的postTask）调度并发任务的入口点。
  root: FiberRoot,
  didTimeout: boolean
): RenderTaskFn | null {

   // 在决定使用哪条线之前刷掉所有的被动效果，以防他们安排了额外的工作
  const originalCallbackNode = root.callbackNode;// 起始的node。留存FiberRootNode
  //  开始渲染前，执行可能存在的useEffect。有可能触发一些新的更新导致任务root的优先级变更了。确保数据准确
  const didFlushPassiveEffects = flushPassiveEffects();

  // 如果被动效果触发了新的更新，可能导致当前任务被取消
  if (didFlushPassiveEffects) {
    if (root.callbackNode !== originalCallbackNode) {// 触发了任务
      // 不需要执行ensureRootIsScheduled。
      // 高优先级任务会替换root.callbackNode。没必要调用ensureRootIsScheduled
      return null;
    } else {
      // 当前任务未被取消，继续执行。说明优先级一致
    }
  }

  /*
    TODO: [调度优化] 避免重复计算 lanes 并与 postTask 对齐
    - 现状: 因在微任务中调度回调(scheduleTaskForRootDuringMicrotask)，可能造成：
      * 同一浏览器任务中的早期更新未处理
      * 导致 getNextLanes 重复计算
    - 短期方案: 将 getNextLanes 结果暂存至 root 对象
    - 长期方案: 改用 postTask API（当可用时）以解决：
      * Scheduler 批量回调导致的微任务介入延迟
      * 浏览器任务队列与 React 调度器的时序对齐
  */


  //   获取当前正在处理的根节点及其渲染通道。跟scheduleTaskForRootDuringMicrotask的一致，优化见注释
  const workInProgressRoot = getWorkInProgressRoot();// 获取当前正在渲染的根节
  const workInProgressRootRenderLanes = getWorkInProgressRootRenderLanes();// 当前渲染所使用的优先级通道lanes
  //  计算接下来需要处理的任务通道
  const lanes = getNextLanes(
    root,
    root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes
  );
  if (lanes === NoLanes) {
    return null;
  }

  //  一个防御性的校验。仍存在未知bug导致Scheduler超时，强制同步
  const forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout;
 
   // 进入工作循环，执行实际渲染工作
  performWorkOnRoot(root, lanes, forceSync);

  // 重新评估任务状态并调度：
  // 1. 处理未完成的遗留工作（时间切片中断）
  // 2. 响应渲染期间产生的新更新
  // 3. 可能取消当前任务或调度新优先级任务
  scheduleTaskForRootDuringMicrotask(root, now());

  if (root.callbackNode === originalCallbackNode) {
   // 
    return performWorkOnRootViaSchedulerTask.bind(null, root);
  }
  return null;
}

function performSyncWorkOnRoot(root: FiberRoot, lanes: Lanes) {
  // 这是同步任务的入口点，这些任务不通过 Scheduler 处理。

  // 刷新被动效果，并检查是否有被动效果被执行
  const didFlushPassiveEffects = flushPassiveEffects();
  if (didFlushPassiveEffects) {
    // 如果被动效果已被刷新，退出到根调度器的外部工作循环，
    // 以便重新计算优先级。
    return null; // 退出当前函数，不进行进一步的处理
  }

  // 如果启用了性能分析器计时器和嵌套更新阶段，更新嵌套更新标志
  if (enableProfilerTimer && enableProfilerNestedUpdatePhase) {
    syncNestedUpdateFlag();
  }

  // 强制同步渲染
  const forceSync = true;

  // 执行根节点的工作，使用强制同步标志
  performWorkOnRoot(root, lanes, forceSync);
}

const fakeActCallbackNode = {};

function scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: RenderTaskFn
) {
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    // Special case: We're inside an `act` scope (a testing utility).
    // Instead of scheduling work in the host environment, add it to a
    // fake internal queue that's managed by the `act` implementation.
    ReactSharedInternals.actQueue.push(callback);
    return fakeActCallbackNode;
  } else {
    // console.log('test123:异步调用',priorityLevel,callback)
    return Scheduler_scheduleCallback(priorityLevel, callback);
  }
}

function cancelCallback(callbackNode: mixed) {
  if (__DEV__ && callbackNode === fakeActCallbackNode) {
    // Special `act` case: check if this is the fake callback node used by
    // the `act` implementation.
  } else if (callbackNode !== null) {
    Scheduler_cancelCallback(callbackNode);
  }
}

function scheduleImmediateTask(cb: () => mixed) {
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    // Special case: Inside an `act` scope, we push microtasks to the fake `act`
    // callback queue. This is because we currently support calling `act`
    // without awaiting the result. The plan is to deprecate that, and require
    // that you always await the result so that the microtasks have a chance to
    // run. But it hasn't happened yet.
    ReactSharedInternals.actQueue.push(() => {
      cb();
      return null;
    });
  }

  // TODO: Can we land supportsMicrotasks? Which environments don't support it?
  // Alternatively, can we move this check to the host config?
  if (supportsMicrotasks) {
    scheduleMicrotask(() => {
      // 在Safari中，添加iframe会强制微任务运行。
      // https://github.com/facebook/react/issues/22459我们不支持在渲染或提交过程中运行回调，
      // 因此我们需要对此进行检查。
      const executionContext = getExecutionContext();
      if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
        // Note that this would still prematurely flush the callbacks
        // if this happens outside render or commit phase (e.g. in an event).

        // Intentionally using a macrotask instead of a microtask here. This is
        // wrong semantically but it prevents an infinite loop. The bug is
        // Safari's, not ours, so we just do our best to not crash even though
        // the behavior isn't completely correct.
        Scheduler_scheduleCallback(ImmediateSchedulerPriority, cb);
        return;
      }
      cb();
    });
  } else {
    // If microtasks are not supported, use Scheduler.
    Scheduler_scheduleCallback(ImmediateSchedulerPriority, cb);
  }
}

export function requestTransitionLane(
  // This argument isn't used, it's only here to encourage the caller to
  // check that it's inside a transition before calling this function.
  // TODO: Make this non-nullable. Requires a tweak to useOptimistic.
  transition: BatchConfigTransition | null
): Lane {
  // The algorithm for assigning an update to a lane should be stable for all
  // updates at the same priority within the same event. To do this, the
  // inputs to the algorithm must be the same.
  //
  // The trick we use is to cache the first of each of these inputs within an
  // event. Then reset the cached values once we can be sure the event is
  // over. Our heuristic for that is whenever we enter a concurrent work loop.
  if (currentEventTransitionLane === NoLane) {
    // All transitions within the same event are assigned the same lane.
    currentEventTransitionLane = claimNextTransitionLane();
  }
  return currentEventTransitionLane;
}

export function didCurrentEventScheduleTransition(): boolean {
  return currentEventTransitionLane !== NoLane;
}
