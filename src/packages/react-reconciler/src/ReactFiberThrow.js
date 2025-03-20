/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber, FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';
import type {CapturedValue} from './ReactCapturedValue';
import type {Update} from './ReactFiberClassUpdateQueue';
import type {Wakeable} from 'shared/ReactTypes';
import type {OffscreenQueue} from './ReactFiberActivityComponent';
import type {RetryQueue} from './ReactFiberSuspenseComponent';

import getComponentNameFromFiber from 'react-reconciler/src/getComponentNameFromFiber';
import {
  ClassComponent,
  HostRoot,
  IncompleteClassComponent,
  IncompleteFunctionComponent,
  FunctionComponent,
  ForwardRef,
  SimpleMemoComponent,
  SuspenseComponent,
  OffscreenComponent,
} from './ReactWorkTags';
import {
  DidCapture,
  Incomplete,
  NoFlags,
  ShouldCapture,
  LifecycleEffectMask,
  ForceUpdateForLegacySuspense,
  ForceClientRender,
  ScheduleRetry,
} from './ReactFiberFlags';
import {NoMode, ConcurrentMode, DebugTracingMode} from './ReactTypeOfMode';
import {
  enableDebugTracing,
  enableLazyContextPropagation,
  enableUpdaterTracking,
  enablePostpone,
  disableLegacyMode,
} from 'shared/ReactFeatureFlags';
import {createCapturedValueAtFiber} from './ReactCapturedValue';
import {
  enqueueCapturedUpdate,
  createUpdate,
  CaptureUpdate,
  ForceUpdate,
  enqueueUpdate,
} from './ReactFiberClassUpdateQueue';
import {markFailedErrorBoundaryForHotReloading} from './ReactFiberHotReloading';
import {
  getShellBoundary,
  getSuspenseHandler,
} from './ReactFiberSuspenseContext';
import {
  renderDidError,
  queueConcurrentError,
  renderDidSuspendDelayIfPossible,
  markLegacyErrorBoundaryAsFailed,
  isAlreadyFailedLegacyErrorBoundary,
  attachPingListener,
  restorePendingUpdaters,
  renderDidSuspend,
} from './ReactFiberWorkLoop';
import {propagateParentContextChangesToDeferredTree} from './ReactFiberNewContext';
import {logUncaughtError, logCaughtError} from './ReactFiberErrorLogger';
import {logComponentSuspended} from './DebugTracing';
import {isDevToolsPresent} from './ReactFiberDevToolsHook';
import {
  SyncLane,
  includesSomeLane,
  mergeLanes,
  pickArbitraryLane,
} from './ReactFiberLane';
import {
  getIsHydrating,
  markDidThrowWhileHydratingDEV,
  queueHydrationError,
  HydrationMismatchException,
} from './ReactFiberHydrationContext';
import {ConcurrentRoot} from './ReactRootTags';
import {noopSuspenseyCommitThenable} from './ReactFiberThenable';
import {REACT_POSTPONE_TYPE} from 'shared/ReactSymbols';
import {runWithFiberInDEV} from './ReactCurrentFiber';
import {callComponentDidCatchInDEV} from './ReactFiberCallUserSpace';

function createRootErrorUpdate(
  root: FiberRoot,
  errorInfo: CapturedValue<mixed>,
  lane: Lane,
): Update<mixed> {
  const update = createUpdate(lane);
  // Unmount the root by rendering null.
  update.tag = CaptureUpdate;
  // Caution: React DevTools currently depends on this property
  // being called "element".
  update.payload = {element: null};
  update.callback = () => {
    if (__DEV__) {
      runWithFiberInDEV(errorInfo.source, logUncaughtError, root, errorInfo);
    } else {
      logUncaughtError(root, errorInfo);
    }
  };
  return update;
}

function createClassErrorUpdate(lane: Lane): Update<mixed> {
  const update = createUpdate(lane);
  update.tag = CaptureUpdate;
  return update;
}

function initializeClassErrorUpdate(
  update: Update<mixed>,
  root: FiberRoot,
  fiber: Fiber,
  errorInfo: CapturedValue<mixed>,
): void {
  const getDerivedStateFromError = fiber.type.getDerivedStateFromError;
  if (typeof getDerivedStateFromError === 'function') {
    const error = errorInfo.value;
    update.payload = () => {
      return getDerivedStateFromError(error);
    };
    update.callback = () => {
      if (__DEV__) {
        markFailedErrorBoundaryForHotReloading(fiber);
      }
      if (__DEV__) {
        runWithFiberInDEV(
          errorInfo.source,
          logCaughtError,
          root,
          fiber,
          errorInfo,
        );
      } else {
        logCaughtError(root, fiber, errorInfo);
      }
    };
  }

  const inst = fiber.stateNode;
  if (inst !== null && typeof inst.componentDidCatch === 'function') {
    // $FlowFixMe[missing-this-annot]
    update.callback = function callback() {
      if (__DEV__) {
        markFailedErrorBoundaryForHotReloading(fiber);
      }
      if (__DEV__) {
        runWithFiberInDEV(
          errorInfo.source,
          logCaughtError,
          root,
          fiber,
          errorInfo,
        );
      } else {
        logCaughtError(root, fiber, errorInfo);
      }
      if (typeof getDerivedStateFromError !== 'function') {
        // To preserve the preexisting retry behavior of error boundaries,
        // we keep track of which ones already failed during this batch.
        // This gets reset before we yield back to the browser.
        // TODO: Warn in strict mode if getDerivedStateFromError is
        // not defined.
        markLegacyErrorBoundaryAsFailed(this);
      }
      if (__DEV__) {
        callComponentDidCatchInDEV(this, errorInfo);
      } else {
        const error = errorInfo.value;
        const stack = errorInfo.stack;
        this.componentDidCatch(error, {
          componentStack: stack !== null ? stack : '',
        });
      }
      if (__DEV__) {
        if (typeof getDerivedStateFromError !== 'function') {
          // If componentDidCatch is the only error boundary method defined,
          // then it needs to call setState to recover from errors.
          // If no state update is scheduled then the boundary will swallow the error.
          if (!includesSomeLane(fiber.lanes, (SyncLane: Lane))) {
            console.error(
              '%s: Error boundaries should implement getDerivedStateFromError(). ' +
                'In that method, return a state update to display an error message or fallback UI.',
              getComponentNameFromFiber(fiber) || 'Unknown',
            );
          }
        }
      }
    };
  }
}

function resetSuspendedComponent(sourceFiber: Fiber, rootRenderLanes: Lanes) {
  if (enableLazyContextPropagation) {
    const currentSourceFiber = sourceFiber.alternate;
    if (currentSourceFiber !== null) {
      // Since we never visited the children of the suspended component, we
      // need to propagate the context change now, to ensure that we visit
      // them during the retry.
      //
      // We don't have to do this for errors because we retry errors without
      // committing in between. So this is specific to Suspense.
      propagateParentContextChangesToDeferredTree(
        currentSourceFiber,
        sourceFiber,
        rootRenderLanes,
      );
    }
  }

  // Reset the memoizedState to what it was before we attempted to render it.
  // A legacy mode Suspense quirk, only relevant to hook components.
  const tag = sourceFiber.tag;
  if (
    !disableLegacyMode &&
    (sourceFiber.mode & ConcurrentMode) === NoMode &&
    (tag === FunctionComponent ||
      tag === ForwardRef ||
      tag === SimpleMemoComponent)
  ) {
    const currentSource = sourceFiber.alternate;
    if (currentSource) {
      sourceFiber.updateQueue = currentSource.updateQueue;
      sourceFiber.memoizedState = currentSource.memoizedState;
      sourceFiber.lanes = currentSource.lanes;
    } else {
      sourceFiber.updateQueue = null;
      sourceFiber.memoizedState = null;
    }
  }
}

function markSuspenseBoundaryShouldCapture(
  suspenseBoundary: Fiber,
  returnFiber: Fiber | null,
  sourceFiber: Fiber,
  root: FiberRoot,
  rootRenderLanes: Lanes,
): Fiber | null {
  // This marks a Suspense boundary so that when we're unwinding the stack,
  // it captures the suspended "exception" and does a second (fallback) pass.
  if (
    !disableLegacyMode &&
    (suspenseBoundary.mode & ConcurrentMode) === NoMode
  ) {
    // Legacy Mode Suspense
    //
    // If the boundary is in legacy mode, we should *not*
    // suspend the commit. Pretend as if the suspended component rendered
    // null and keep rendering. When the Suspense boundary completes,
    // we'll do a second pass to render the fallback.
    if (suspenseBoundary === returnFiber) {
      // Special case where we suspended while reconciling the children of
      // a Suspense boundary's inner Offscreen wrapper fiber. This happens
      // when a React.lazy component is a direct child of a
      // Suspense boundary.
      //
      // Suspense boundaries are implemented as multiple fibers, but they
      // are a single conceptual unit. The legacy mode behavior where we
      // pretend the suspended fiber committed as `null` won't work,
      // because in this case the "suspended" fiber is the inner
      // Offscreen wrapper.
      //
      // Because the contents of the boundary haven't started rendering
      // yet (i.e. nothing in the tree has partially rendered) we can
      // switch to the regular, concurrent mode behavior: mark the
      // boundary with ShouldCapture and enter the unwind phase.
      suspenseBoundary.flags |= ShouldCapture;
    } else {
      suspenseBoundary.flags |= DidCapture;
      sourceFiber.flags |= ForceUpdateForLegacySuspense;

      // We're going to commit this fiber even though it didn't complete.
      // But we shouldn't call any lifecycle methods or callbacks. Remove
      // all lifecycle effect tags.
      sourceFiber.flags &= ~(LifecycleEffectMask | Incomplete);

      if (sourceFiber.tag === ClassComponent) {
        const currentSourceFiber = sourceFiber.alternate;
        if (currentSourceFiber === null) {
          // This is a new mount. Change the tag so it's not mistaken for a
          // completed class component. For example, we should not call
          // componentWillUnmount if it is deleted.
          sourceFiber.tag = IncompleteClassComponent;
        } else {
          // When we try rendering again, we should not reuse the current fiber,
          // since it's known to be in an inconsistent state. Use a force update to
          // prevent a bail out.
          const update = createUpdate(SyncLane);
          update.tag = ForceUpdate;
          enqueueUpdate(sourceFiber, update, SyncLane);
        }
      } else if (sourceFiber.tag === FunctionComponent) {
        const currentSourceFiber = sourceFiber.alternate;
        if (currentSourceFiber === null) {
          // This is a new mount. Change the tag so it's not mistaken for a
          // completed function component.
          sourceFiber.tag = IncompleteFunctionComponent;
        }
      }

      // The source fiber did not complete. Mark it with Sync priority to
      // indicate that it still has pending work.
      sourceFiber.lanes = mergeLanes(sourceFiber.lanes, SyncLane);
    }
    return suspenseBoundary;
  }
  // Confirmed that the boundary is in a concurrent mode tree. Continue
  // with the normal suspend path.
  //
  // After this we'll use a set of heuristics to determine whether this
  // render pass will run to completion or restart or "suspend" the commit.
  // The actual logic for this is spread out in different places.
  //
  // This first principle is that if we're going to suspend when we complete
  // a root, then we should also restart if we get an update or ping that
  // might unsuspend it, and vice versa. The only reason to suspend is
  // because you think you might want to restart before committing. However,
  // it doesn't make sense to restart only while in the period we're suspended.
  //
  // Restarting too aggressively is also not good because it starves out any
  // intermediate loading state. So we use heuristics to determine when.

  // Suspense Heuristics
  //
  // If nothing threw a Promise or all the same fallbacks are already showing,
  // then don't suspend/restart.
  //
  // If this is an initial render of a new tree of Suspense boundaries and
  // those trigger a fallback, then don't suspend/restart. We want to ensure
  // that we can show the initial loading state as quickly as possible.
  //
  // If we hit a "Delayed" case, such as when we'd switch from content back into
  // a fallback, then we should always suspend/restart. Transitions apply
  // to this case. If none is defined, JND is used instead.
  //
  // If we're already showing a fallback and it gets "retried", allowing us to show
  // another level, but there's still an inner boundary that would show a fallback,
  // then we suspend/restart for 500ms since the last time we showed a fallback
  // anywhere in the tree. This effectively throttles progressive loading into a
  // consistent train of commits. This also gives us an opportunity to restart to
  // get to the completed state slightly earlier.
  //
  // If there's ambiguity due to batching it's resolved in preference of:
  // 1) "delayed", 2) "initial render", 3) "retry".
  //
  // We want to ensure that a "busy" state doesn't get force committed. We want to
  // ensure that new initial loading states can commit as soon as possible.
  suspenseBoundary.flags |= ShouldCapture;
  // TODO: I think we can remove this, since we now use `DidCapture` in
  // the begin phase to prevent an early bailout.
  suspenseBoundary.lanes = rootRenderLanes;
  return suspenseBoundary;
}

function throwException(
  root: FiberRoot,
  returnFiber: Fiber | null,
  sourceFiber: Fiber,
  value: mixed,// 错误信息
  rootRenderLanes: Lanes,
): boolean {
  // 标题未完成
  sourceFiber.flags |= Incomplete;
  //  开发工具的处理
  if (enableUpdaterTracking) {
    if (isDevToolsPresent) {
      // If we have pending work still, restore the original updaters
      restorePendingUpdaters(root, rootRenderLanes);
    }
  }

  if (value !== null && typeof value === 'object') {
    if (enablePostpone && value.$$typeof === REACT_POSTPONE_TYPE) {
      // 伪装成promise。React.postpone的兼容。永不解析的"Promise"
      //Postpone 是一种新的机制，允许组件"推迟"渲染，与 Suspense 类似但有不同用途。
      value = {then: function () {}};
    }
    if (typeof value.then === 'function') {// 
      // This is a wakeable. The component suspended.
      const wakeable: Wakeable = (value: any);
      resetSuspendedComponent(sourceFiber, rootRenderLanes);

      // 获取最近的 Suspense 边界
      const suspenseBoundary = getSuspenseHandler();
      if (suspenseBoundary !== null) {
        switch (suspenseBoundary.tag) {
          case SuspenseComponent: {
            if (disableLegacyMode || sourceFiber.mode & ConcurrentMode) {
              //  并发模式下，判断shell
              //  shell：渲染碰到的第一个suspense
              //  也就是判断找到的suspenseBoundary是否是第一个碰到的suspense
              //  如果是第一个碰到的，需要延迟渲染fallback
              if (getShellBoundary() === null) {// 没有定义shell，或者发生在shell中
                renderDidSuspendDelayIfPossible();//  延迟处理。如果超时了才显示fallback
              } else {
                const current = suspenseBoundary.alternate;
                if (current === null) {
                  renderDidSuspend();
                }
              }
            }

            suspenseBoundary.flags &= ~ForceClientRender;// 清楚强制客户端渲染的标识，因为现在将使用正常的Suspense处理流程
            //标记Suspense边界需要捕获挂起的组件，并准备显示fallback内容
            markSuspenseBoundaryShouldCapture(
              suspenseBoundary,//捕获挂起的Suspense组件
              returnFiber,
              sourceFiber,
              root,
              rootRenderLanes,
            );
            //  检查是否为特殊的Suspensey资源
            const isSuspenseyResource = wakeable === noopSuspenseyCommitThenable;
            if (isSuspenseyResource) {
              //如果是Suspensey资源，标记Suspense边界需要立即重试
              suspenseBoundary.flags |= ScheduleRetry;
            } else {
              const retryQueue: RetryQueue | null = (suspenseBoundary.updateQueue: any);
              //处理普通Promise的情况（设置重试队列）
              if (retryQueue === null) {
                suspenseBoundary.updateQueue = new Set([wakeable]);
              } else {
                retryQueue.add(wakeable);
              }
              //  添加Ping监听器（仅在并发模式）
              if (disableLegacyMode || suspenseBoundary.mode & ConcurrentMode) {
                //  当Promise解析时，回调会通知React调度器。
                attachPingListener(root, wakeable, rootRenderLanes);
              }
            }
            return false;
          }
          case OffscreenComponent: {
            if (disableLegacyMode || suspenseBoundary.mode & ConcurrentMode) {
              suspenseBoundary.flags |= ShouldCapture;
              const isSuspenseyResource =
                wakeable === noopSuspenseyCommitThenable;
              if (isSuspenseyResource) {
                suspenseBoundary.flags |= ScheduleRetry;
              } else {
                const offscreenQueue: OffscreenQueue | null =
                  (suspenseBoundary.updateQueue: any);
                if (offscreenQueue === null) {
                  const newOffscreenQueue: OffscreenQueue = {
                    transitions: null,
                    markerInstances: null,
                    retryQueue: new Set([wakeable]),
                  };
                  suspenseBoundary.updateQueue = newOffscreenQueue;
                } else {
                  const retryQueue = offscreenQueue.retryQueue;
                  if (retryQueue === null) {
                    offscreenQueue.retryQueue = new Set([wakeable]);
                  } else {
                    retryQueue.add(wakeable);
                  }
                }

                attachPingListener(root, wakeable, rootRenderLanes);
              }
              return false;
            }
          }
        }
        throw new Error(
          `Unexpected Suspense handler tag (${suspenseBoundary.tag}). This ` +
            'is a bug in React.',
        );
      } else {
        // No boundary was found. Unless this is a sync update, this is OK.
        // We can suspend and wait for more data to arrive.

        if (disableLegacyMode || root.tag === ConcurrentRoot) {
          // In a concurrent root, suspending without a Suspense boundary is
          // allowed. It will suspend indefinitely without committing.
          //
          // TODO: Should we have different behavior for discrete updates? What
          // about flushSync? Maybe it should put the tree into an inert state,
          // and potentially log a warning. Revisit this for a future release.
          attachPingListener(root, wakeable, rootRenderLanes);
          renderDidSuspendDelayIfPossible();
          return false;
        } else {
          // In a legacy root, suspending without a boundary is always an error.
          const uncaughtSuspenseError = new Error(
            'A component suspended while responding to synchronous input. This ' +
              'will cause the UI to be replaced with a loading indicator. To ' +
              'fix, updates that suspend should be wrapped ' +
              'with startTransition.',
          );
          value = uncaughtSuspenseError;
        }
      }
    }
  }

  // This is a regular error, not a Suspense wakeable.
  if (
    getIsHydrating() &&
    (disableLegacyMode || sourceFiber.mode & ConcurrentMode)
  ) {
    markDidThrowWhileHydratingDEV();
    const suspenseBoundary = getSuspenseHandler();
    // If the error was thrown during hydration, we may be able to recover by
    // discarding the dehydrated content and switching to a client render.
    // Instead of surfacing the error, find the nearest Suspense boundary
    // and render it again without hydration.
    if (suspenseBoundary !== null) {
      if ((suspenseBoundary.flags & ShouldCapture) === NoFlags) {
        // Set a flag to indicate that we should try rendering the normal
        // children again, not the fallback.
        suspenseBoundary.flags |= ForceClientRender;
      }
      markSuspenseBoundaryShouldCapture(
        suspenseBoundary,
        returnFiber,
        sourceFiber,
        root,
        rootRenderLanes,
      );

      // Even though the user may not be affected by this error, we should
      // still log it so it can be fixed.
      if (value !== HydrationMismatchException) {
        const wrapperError = new Error(
          'There was an error while hydrating but React was able to recover by ' +
            'instead client rendering from the nearest Suspense boundary.',
          {cause: value},
        );
        queueHydrationError(
          createCapturedValueAtFiber(wrapperError, sourceFiber),
        );
      }
      return false;
    } else {
      if (value !== HydrationMismatchException) {
        const wrapperError = new Error(
          'There was an error while hydrating but React was able to recover by ' +
            'instead client rendering the entire root.',
          {cause: value},
        );
        queueHydrationError(
          createCapturedValueAtFiber(wrapperError, sourceFiber),
        );
      }
      const workInProgress: Fiber = (root.current: any).alternate;
      // Schedule an update at the root to log the error but this shouldn't
      // actually happen because we should recover.
      workInProgress.flags |= ShouldCapture;
      const lane = pickArbitraryLane(rootRenderLanes);
      workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
      const rootErrorInfo = createCapturedValueAtFiber(value, sourceFiber);
      const update = createRootErrorUpdate(
        workInProgress.stateNode,
        rootErrorInfo, // This should never actually get logged due to the recovery.
        lane,
      );
      enqueueCapturedUpdate(workInProgress, update);
      renderDidError();
      return false;
    }
  } else {
    // Otherwise, fall through to the error path.
  }

  const wrapperError = new Error(
    'There was an error during concurrent rendering but React was able to recover by ' +
      'instead synchronously rendering the entire root.',
    {cause: value},
  );
  queueConcurrentError(createCapturedValueAtFiber(wrapperError, sourceFiber));
  renderDidError();

  // We didn't find a boundary that could handle this type of exception. Start
  // over and traverse parent path again, this time treating the exception
  // as an error.

  if (returnFiber === null) {
    // There's no return fiber, which means the root errored. This should never
    // happen. Return `true` to trigger a fatal error (panic).
    return true;
  }

  const errorInfo = createCapturedValueAtFiber(value, sourceFiber);
  let workInProgress: Fiber = returnFiber;
  do {
    switch (workInProgress.tag) {
      case HostRoot: {
        workInProgress.flags |= ShouldCapture;
        const lane = pickArbitraryLane(rootRenderLanes);
        workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
        const update = createRootErrorUpdate(
          workInProgress.stateNode,
          errorInfo,
          lane,
        );
        enqueueCapturedUpdate(workInProgress, update);
        return false;
      }
      case ClassComponent:
        // Capture and retry
        const ctor = workInProgress.type;
        const instance = workInProgress.stateNode;
        if (
          (workInProgress.flags & DidCapture) === NoFlags &&
          (typeof ctor.getDerivedStateFromError === 'function' ||
            (instance !== null &&
              typeof instance.componentDidCatch === 'function' &&
              !isAlreadyFailedLegacyErrorBoundary(instance)))
        ) {
          workInProgress.flags |= ShouldCapture;
          const lane = pickArbitraryLane(rootRenderLanes);
          workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
          // Schedule the error boundary to re-render using updated state
          const update = createClassErrorUpdate(lane);
          initializeClassErrorUpdate(update, root, workInProgress, errorInfo);
          enqueueCapturedUpdate(workInProgress, update);
          return false;
        }
        break;
      default:
        break;
    }
    // $FlowFixMe[incompatible-type] we bail out when we get a null
    workInProgress = workInProgress.return;
  } while (workInProgress !== null);

  return false;
}

export {
  throwException,
  createRootErrorUpdate,
  createClassErrorUpdate,
  initializeClassErrorUpdate,
};
