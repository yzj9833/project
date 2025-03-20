/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  ReactConsumerType,
  ReactContext,
  ReactNodeList,
} from 'shared/ReactTypes';
import type { LazyComponent as LazyComponentType } from 'react/src/ReactLazy';
import type { Fiber, FiberRoot } from './ReactInternalTypes';
import type { TypeOfMode } from './ReactTypeOfMode';
import type { Lanes, Lane } from './ReactFiberLane';
import type {
  SuspenseState,
  SuspenseListRenderState,
  SuspenseListTailMode,
} from './ReactFiberSuspenseComponent';
import type { SuspenseContext } from './ReactFiberSuspenseContext';
import type {
  OffscreenProps,
  OffscreenState,
  OffscreenQueue,
  OffscreenInstance,
} from './ReactFiberActivityComponent';
import { OffscreenDetached } from './ReactFiberActivityComponent';
import type {
  Cache,
  CacheComponentState,
  SpawnedCachePool,
} from './ReactFiberCacheComponent';
import type { UpdateQueue } from './ReactFiberClassUpdateQueue';
import type { RootState } from './ReactFiberRoot';
import type { TracingMarkerInstance } from './ReactFiberTracingMarkerComponent';
import type { TransitionStatus } from './ReactFiberConfig';
import type { Hook } from './ReactFiberHooks';

import {
  markComponentRenderStarted,
  markComponentRenderStopped,
  setIsStrictModeForDevtools,
} from './ReactFiberDevToolsHook';
import {
  FunctionComponent,
  ClassComponent,
  HostRoot,
  HostComponent,
  HostHoistable,
  HostSingleton,
  HostText,
  HostPortal,
  ForwardRef,
  Fragment,
  Mode,
  ContextProvider,
  ContextConsumer,
  Profiler,
  SuspenseComponent,
  SuspenseListComponent,
  MemoComponent,
  SimpleMemoComponent,
  LazyComponent,
  IncompleteClassComponent,
  IncompleteFunctionComponent,
  ScopeComponent,
  OffscreenComponent,
  LegacyHiddenComponent,
  CacheComponent,
  TracingMarkerComponent,
  Throw,
} from './ReactWorkTags';
import {
  NoFlags,
  PerformedWork,
  Placement,
  Hydrating,
  ContentReset,
  DidCapture,
  Update,
  Ref,
  RefStatic,
  ChildDeletion,
  ForceUpdateForLegacySuspense,
  StaticMask,
  ShouldCapture,
  ForceClientRender,
  Passive,
  DidDefer,
} from './ReactFiberFlags';
import {
  debugRenderPhaseSideEffectsForStrictMode,
  disableLegacyContext,
  disableLegacyContextForFunctionComponents,
  enableProfilerCommitHooks,
  enableProfilerTimer,
  enableScopeAPI,
  enableCache,
  enableLazyContextPropagation,
  enableSchedulingProfiler,
  enableTransitionTracing,
  enableLegacyHidden,
  enableCPUSuspense,
  enableAsyncActions,
  enablePostpone,
  enableRenderableContext,
  enableRefAsProp,
  disableLegacyMode,
  disableDefaultPropsExceptForClasses,
  disableStringRefs,
  enableOwnerStacks,
} from 'shared/ReactFeatureFlags';
import isArray from 'shared/isArray';
import shallowEqual from 'shared/shallowEqual';
import getComponentNameFromFiber from 'react-reconciler/src/getComponentNameFromFiber';
import getComponentNameFromType from 'shared/getComponentNameFromType';
import ReactStrictModeWarnings from './ReactStrictModeWarnings';
import {
  REACT_LAZY_TYPE,
  REACT_FORWARD_REF_TYPE,
  REACT_MEMO_TYPE,
  getIteratorFn,
} from 'shared/ReactSymbols';
import {
  getCurrentFiberOwnerNameInDevOrNull,
  setCurrentFiber,
} from './ReactCurrentFiber';
import {
  resolveFunctionForHotReloading,
  resolveForwardRefForHotReloading,
  resolveClassForHotReloading,
} from './ReactFiberHotReloading';

import {
  mountChildFibers,
  reconcileChildFibers,
  cloneChildFibers,
} from './ReactChildFiber';
import {
  processUpdateQueue,
  cloneUpdateQueue,
  initializeUpdateQueue,
  enqueueCapturedUpdate,
  suspendIfUpdateReadFromEntangledAsyncAction,
} from './ReactFiberClassUpdateQueue';
import {
  NoLane,
  NoLanes,
  OffscreenLane,
  DefaultHydrationLane,
  SomeRetryLane,
  includesSomeLane,
  laneToLanes,
  removeLanes,
  mergeLanes,
  getBumpedLaneForHydration,
  pickArbitraryLane,
} from './ReactFiberLane';
import {
  ConcurrentMode,
  NoMode,
  ProfileMode,
  StrictLegacyMode,
} from './ReactTypeOfMode';
import {
  shouldSetTextContent,
  isSuspenseInstancePending,
  isSuspenseInstanceFallback,
  getSuspenseInstanceFallbackErrorDetails,
  registerSuspenseInstanceRetry,
  supportsHydration,
  supportsResources,
  supportsSingletons,
  isPrimaryRenderer,
  getResource,
  createHoistableInstance,
  HostTransitionContext,
} from './ReactFiberConfig';
import type { SuspenseInstance } from './ReactFiberConfig';
import { shouldError, shouldSuspend } from './ReactFiberReconciler';
import {
  pushHostContext,
  pushHostContainer,
  getRootHostContainer,
} from './ReactFiberHostContext';
import {
  suspenseStackCursor,
  pushSuspenseListContext,
  ForceSuspenseFallback,
  hasSuspenseListContext,
  setDefaultShallowSuspenseListContext,
  setShallowSuspenseListContext,
  pushPrimaryTreeSuspenseHandler,
  pushFallbackTreeSuspenseHandler,
  pushOffscreenSuspenseHandler,
  reuseSuspenseHandlerOnStack,
  popSuspenseHandler,
} from './ReactFiberSuspenseContext';
import {
  pushHiddenContext,
  reuseHiddenContextOnStack,
} from './ReactFiberHiddenContext';
import { findFirstSuspended } from './ReactFiberSuspenseComponent';
import {
  pushProvider,
  propagateContextChange,
  lazilyPropagateParentContextChanges,
  propagateParentContextChangesToDeferredTree,
  checkIfContextChanged,
  readContext,
  prepareToReadContext,
  scheduleContextWorkOnParentPath,
} from './ReactFiberNewContext';
import {
  renderWithHooks,
  checkDidRenderIdHook,
  bailoutHooks,
  replaySuspendedComponentWithHooks,
  renderTransitionAwareHostComponentWithHooks,
} from './ReactFiberHooks';
import { stopProfilerTimerIfRunning } from './ReactProfilerTimer';
import {
  getMaskedContext,
  getUnmaskedContext,
  hasContextChanged as hasLegacyContextChanged,
  pushContextProvider as pushLegacyContextProvider,
  isContextProvider as isLegacyContextProvider,
  pushTopLevelContextObject,
  invalidateContextProvider,
} from './ReactFiberContext';
import {
  getIsHydrating,
  enterHydrationState,
  reenterHydrationStateFromDehydratedSuspenseInstance,
  resetHydrationState,
  claimHydratableSingleton,
  tryToClaimNextHydratableInstance,
  tryToClaimNextHydratableTextInstance,
  tryToClaimNextHydratableSuspenseInstance,
  warnIfHydrating,
  queueHydrationError,
} from './ReactFiberHydrationContext';
import {
  constructClassInstance,
  mountClassInstance,
  resumeMountClassInstance,
  updateClassInstance,
  resolveClassComponentProps,
} from './ReactFiberClassComponent';
import { resolveDefaultPropsOnNonClassComponent } from './ReactFiberLazyComponent';
import {
  createFiberFromTypeAndProps,
  createFiberFromFragment,
  createFiberFromOffscreen,
  createWorkInProgress,
  isSimpleFunctionComponent,
  isFunctionClassComponent,
} from './ReactFiber';
import {
  retryDehydratedSuspenseBoundary,
  scheduleUpdateOnFiber,
  renderDidSuspendDelayIfPossible,
  markSkippedUpdateLanes,
  getWorkInProgressRoot,
  peekDeferredLane,
} from './ReactFiberWorkLoop';
import { enqueueConcurrentRenderForLane } from './ReactFiberConcurrentUpdates';
import { pushCacheProvider, CacheContext } from './ReactFiberCacheComponent';
import {
  createCapturedValueFromError,
  createCapturedValueAtFiber,
} from './ReactCapturedValue';
import {
  createClassErrorUpdate,
  initializeClassErrorUpdate,
} from './ReactFiberThrow';
import is from 'shared/objectIs';
import {
  getForksAtLevel,
  isForkedChild,
  pushTreeId,
  pushMaterializedTreeId,
} from './ReactFiberTreeContext';
import {
  requestCacheFromPool,
  pushRootTransition,
  getSuspendedCache,
  pushTransition,
  getOffscreenDeferredCache,
  getPendingTransitions,
} from './ReactFiberTransition';
import {
  getMarkerInstances,
  pushMarkerInstance,
  pushRootMarkerInstance,
  TransitionTracingMarker,
} from './ReactFiberTracingMarkerComponent';
import {
  callLazyInitInDEV,
  callComponentInDEV,
  callRenderInDEV,
} from './ReactFiberCallUserSpace';

// A special exception that's used to unwind the stack when an update flows
// into a dehydrated boundary.
export const SelectiveHydrationException: mixed = new Error(
  "This is not a real error. It's an implementation detail of React's " +
  "selective hydration feature. If this leaks into userspace, it's a bug in " +
  'React. Please file an issue.',
);

let didReceiveUpdate: boolean = false;

let didWarnAboutBadClass;
let didWarnAboutContextTypeOnFunctionComponent;
let didWarnAboutContextTypes;
let didWarnAboutGetDerivedStateOnFunctionComponent;
let didWarnAboutFunctionRefs;
export let didWarnAboutReassigningProps: boolean;
let didWarnAboutRevealOrder;
let didWarnAboutTailOptions;
let didWarnAboutDefaultPropsOnFunctionComponent;

if (__DEV__) {
  didWarnAboutBadClass = ({}: { [string]: boolean });
  didWarnAboutContextTypeOnFunctionComponent = ({}: { [string]: boolean });
  didWarnAboutContextTypes = ({}: { [string]: boolean });
  didWarnAboutGetDerivedStateOnFunctionComponent = ({}: { [string]: boolean });
  didWarnAboutFunctionRefs = ({}: { [string]: boolean });
  didWarnAboutReassigningProps = false;
  didWarnAboutRevealOrder = ({}: { [empty]: boolean });
  didWarnAboutTailOptions = ({}: { [string]: boolean });
  didWarnAboutDefaultPropsOnFunctionComponent = ({}: { [string]: boolean });
}

export function reconcileChildren(
  current: Fiber | null,
  workInProgress: Fiber,
  nextChildren: any,
  renderLanes: Lanes,
) {
  if (current === null) {
    // If this is a fresh new component that hasn't been rendered yet, we
    // won't update its child set by applying minimal side-effects. Instead,
    // we will add them all to the child before it gets rendered. That means
    // we can optimize this reconciliation pass by not tracking side-effects.
    workInProgress.child = mountChildFibers(
      workInProgress,
      null,
      nextChildren,
      renderLanes,
    );
  } else {
    // If the current child is the same as the work in progress, it means that
    // we haven't yet started any work on these children. Therefore, we use
    // the clone algorithm to create a copy of all the current children.

    // If we had any progressed work already, that is invalid at this point so
    // let's throw it out.
    workInProgress.child = reconcileChildFibers(
      workInProgress,
      current.child,
      nextChildren,
      renderLanes,
    );
  }
}

function forceUnmountCurrentAndReconcile(
  current: Fiber,
  workInProgress: Fiber,
  nextChildren: any,
  renderLanes: Lanes,
) {
  // This function is fork of reconcileChildren. It's used in cases where we
  // want to reconcile without matching against the existing set. This has the
  // effect of all current children being unmounted; even if the type and key
  // are the same, the old child is unmounted and a new child is created.
  //
  // To do this, we're going to go through the reconcile algorithm twice. In
  // the first pass, we schedule a deletion for all the current children by
  // passing null.
  workInProgress.child = reconcileChildFibers(
    workInProgress,
    current.child,
    null,
    renderLanes,
  );
  // In the second pass, we mount the new children. The trick here is that we
  // pass null in place of where we usually pass the current child set. This has
  // the effect of remounting all children regardless of whether their
  // identities match.
  workInProgress.child = reconcileChildFibers(
    workInProgress,
    null,
    nextChildren,
    renderLanes,
  );
}

function updateForwardRef(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  renderLanes: Lanes,
) {
  // TODO: current can be non-null here even if the component
  // hasn't yet mounted. This happens after the first render suspends.
  // We'll need to figure out if this is fine or can cause issues.
  const render = Component.render;
  const ref = workInProgress.ref;

  let propsWithoutRef;
  if (enableRefAsProp && 'ref' in nextProps) {
    // `ref` is just a prop now, but `forwardRef` expects it to not appear in
    // the props object. This used to happen in the JSX runtime, but now we do
    // it here.
    propsWithoutRef = ({}: { [string]: any });
    for (const key in nextProps) {
      // Since `ref` should only appear in props via the JSX transform, we can
      // assume that this is a plain object. So we don't need a
      // hasOwnProperty check.
      if (key !== 'ref') {
        propsWithoutRef[key] = nextProps[key];
      }
    }
  } else {
    propsWithoutRef = nextProps;
  }

  // The rest is a fork of updateFunctionComponent
  let nextChildren;
  let hasId;
  prepareToReadContext(workInProgress, renderLanes);
  if (enableSchedulingProfiler) {
    markComponentRenderStarted(workInProgress);
  }
  if (__DEV__) {
    nextChildren = renderWithHooks(
      current,
      workInProgress,
      render,
      propsWithoutRef,
      ref,
      renderLanes,
    );
    hasId = checkDidRenderIdHook();
  } else {
    nextChildren = renderWithHooks(
      current,
      workInProgress,
      render,
      propsWithoutRef,
      ref,
      renderLanes,
    );
    hasId = checkDidRenderIdHook();
  }
  if (enableSchedulingProfiler) {
    markComponentRenderStopped();
  }

  if (current !== null && !didReceiveUpdate) {
    bailoutHooks(current, workInProgress, renderLanes);
    return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
  }

  if (getIsHydrating() && hasId) {
    pushMaterializedTreeId(workInProgress);
  }

  // React DevTools reads this flag.
  workInProgress.flags |= PerformedWork;
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

function updateMemoComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  renderLanes: Lanes,
): null | Fiber {
  if (current === null) {
    const type = Component.type;
    if (
      isSimpleFunctionComponent(type) &&
      Component.compare === null &&
      // SimpleMemoComponent codepath doesn't resolve outer props either.
      (disableDefaultPropsExceptForClasses ||
        Component.defaultProps === undefined)
    ) {
      let resolvedType = type;
      if (__DEV__) {
        resolvedType = resolveFunctionForHotReloading(type);
      }
      // If this is a plain function component without default props,
      // and with only the default shallow comparison, we upgrade it
      // to a SimpleMemoComponent to allow fast path updates.
      workInProgress.tag = SimpleMemoComponent;
      workInProgress.type = resolvedType;
      if (__DEV__) {
        validateFunctionComponentInDev(workInProgress, type);
      }
      return updateSimpleMemoComponent(
        current,
        workInProgress,
        resolvedType,
        nextProps,
        renderLanes,
      );
    }
    if (!disableDefaultPropsExceptForClasses) {
      if (__DEV__) {
        if (Component.defaultProps !== undefined) {
          const componentName = getComponentNameFromType(type) || 'Unknown';
          if (!didWarnAboutDefaultPropsOnFunctionComponent[componentName]) {
            console.error(
              '%s: Support for defaultProps will be removed from memo components ' +
              'in a future major release. Use JavaScript default parameters instead.',
              componentName,
            );
            didWarnAboutDefaultPropsOnFunctionComponent[componentName] = true;
          }
        }
      }
    }
    const child = createFiberFromTypeAndProps(
      Component.type,
      null,
      nextProps,
      workInProgress,
      workInProgress.mode,
      renderLanes,
    );
    child.ref = workInProgress.ref;
    child.return = workInProgress;
    workInProgress.child = child;
    return child;
  }
  const currentChild = ((current.child: any): Fiber); // This is always exactly one child
  const hasScheduledUpdateOrContext = checkScheduledUpdateOrContext(
    current,
    renderLanes,
  );
  if (!hasScheduledUpdateOrContext) {
    // This will be the props with resolved defaultProps,
    // unlike current.memoizedProps which will be the unresolved ones.
    const prevProps = currentChild.memoizedProps;
    // Default to shallow comparison
    let compare = Component.compare;
    compare = compare !== null ? compare : shallowEqual;
    if (compare(prevProps, nextProps) && current.ref === workInProgress.ref) {
      return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
    }
  }
  // React DevTools reads this flag.
  workInProgress.flags |= PerformedWork;
  const newChild = createWorkInProgress(currentChild, nextProps);
  newChild.ref = workInProgress.ref;
  newChild.return = workInProgress;
  workInProgress.child = newChild;
  return newChild;
}

function updateSimpleMemoComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  renderLanes: Lanes,
): null | Fiber {
  // TODO: current can be non-null here even if the component
  // hasn't yet mounted. This happens when the inner render suspends.
  // We'll need to figure out if this is fine or can cause issues.
  if (current !== null) {
    const prevProps = current.memoizedProps;
    if (
      shallowEqual(prevProps, nextProps) &&
      current.ref === workInProgress.ref &&
      // Prevent bailout if the implementation changed due to hot reload.
      (__DEV__ ? workInProgress.type === current.type : true)
    ) {
      didReceiveUpdate = false;

      // The props are shallowly equal. Reuse the previous props object, like we
      // would during a normal fiber bailout.
      //
      // We don't have strong guarantees that the props object is referentially
      // equal during updates where we can't bail out anyway — like if the props
      // are shallowly equal, but there's a local state or context update in the
      // same batch.
      //
      // However, as a principle, we should aim to make the behavior consistent
      // across different ways of memoizing a component. For example, React.memo
      // has a different internal Fiber layout if you pass a normal function
      // component (SimpleMemoComponent) versus if you pass a different type
      // like forwardRef (MemoComponent). But this is an implementation detail.
      // Wrapping a component in forwardRef (or React.lazy, etc) shouldn't
      // affect whether the props object is reused during a bailout.
      workInProgress.pendingProps = nextProps = prevProps;

      if (!checkScheduledUpdateOrContext(current, renderLanes)) {
        // The pending lanes were cleared at the beginning of beginWork. We're
        // about to bail out, but there might be other lanes that weren't
        // included in the current render. Usually, the priority level of the
        // remaining updates is accumulated during the evaluation of the
        // component (i.e. when processing the update queue). But since since
        // we're bailing out early *without* evaluating the component, we need
        // to account for it here, too. Reset to the value of the current fiber.
        // NOTE: This only applies to SimpleMemoComponent, not MemoComponent,
        // because a MemoComponent fiber does not have hooks or an update queue;
        // rather, it wraps around an inner component, which may or may not
        // contains hooks.
        // TODO: Move the reset at in beginWork out of the common path so that
        // this is no longer necessary.
        workInProgress.lanes = current.lanes;
        return bailoutOnAlreadyFinishedWork(
          current,
          workInProgress,
          renderLanes,
        );
      } else if ((current.flags & ForceUpdateForLegacySuspense) !== NoFlags) {
        // This is a special case that only exists for legacy mode.
        // See https://github.com/facebook/react/pull/19216.
        didReceiveUpdate = true;
      }
    }
  }
  return updateFunctionComponent(
    current,
    workInProgress,
    Component,
    nextProps,
    renderLanes,
  );
}

function updateOffscreenComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  const nextProps: OffscreenProps = workInProgress.pendingProps;
  const nextChildren = nextProps.children;
  const nextIsDetached =
    (workInProgress.stateNode._pendingVisibility & OffscreenDetached) !== 0;

  const prevState: OffscreenState | null =
    current !== null ? current.memoizedState : null;

  markRef(current, workInProgress);

  if (
    nextProps.mode === 'hidden' ||
    (enableLegacyHidden &&
      nextProps.mode === 'unstable-defer-without-hiding') ||
    nextIsDetached
  ) {
    // Rendering a hidden tree.

    const didSuspend = (workInProgress.flags & DidCapture) !== NoFlags;
    if (didSuspend) {
      // Something suspended inside a hidden tree

      // Include the base lanes from the last render
      const nextBaseLanes =
        prevState !== null
          ? mergeLanes(prevState.baseLanes, renderLanes)
          : renderLanes;

      if (current !== null) {
        // Reset to the current children
        let currentChild = (workInProgress.child = current.child);

        // The current render suspended, but there may be other lanes with
        // pending work. We can't read `childLanes` from the current Offscreen
        // fiber because we reset it when it was deferred; however, we can read
        // the pending lanes from the child fibers.
        let currentChildLanes: Lanes = NoLanes;
        while (currentChild !== null) {
          currentChildLanes = mergeLanes(
            mergeLanes(currentChildLanes, currentChild.lanes),
            currentChild.childLanes,
          );
          currentChild = currentChild.sibling;
        }
        const lanesWeJustAttempted = nextBaseLanes;
        const remainingChildLanes = removeLanes(
          currentChildLanes,
          lanesWeJustAttempted,
        );
        workInProgress.childLanes = remainingChildLanes;
      } else {
        workInProgress.childLanes = NoLanes;
        workInProgress.child = null;
      }

      return deferHiddenOffscreenComponent(
        current,
        workInProgress,
        nextBaseLanes,
        renderLanes,
      );
    }

    if (
      !disableLegacyMode &&
      (workInProgress.mode & ConcurrentMode) === NoMode
    ) {
      // In legacy sync mode, don't defer the subtree. Render it now.
      // TODO: Consider how Offscreen should work with transitions in the future
      const nextState: OffscreenState = {
        baseLanes: NoLanes,
        cachePool: null,
      };
      workInProgress.memoizedState = nextState;
      if (enableCache) {
        // push the cache pool even though we're going to bail out
        // because otherwise there'd be a context mismatch
        if (current !== null) {
          pushTransition(workInProgress, null, null);
        }
      }
      reuseHiddenContextOnStack(workInProgress);
      pushOffscreenSuspenseHandler(workInProgress);
    } else if (!includesSomeLane(renderLanes, (OffscreenLane: Lane))) {
      // We're hidden, and we're not rendering at Offscreen. We will bail out
      // and resume this tree later.

      // Schedule this fiber to re-render at Offscreen priority
      workInProgress.lanes = workInProgress.childLanes =
        laneToLanes(OffscreenLane);

      // Include the base lanes from the last render
      const nextBaseLanes =
        prevState !== null
          ? mergeLanes(prevState.baseLanes, renderLanes)
          : renderLanes;

      return deferHiddenOffscreenComponent(
        current,
        workInProgress,
        nextBaseLanes,
        renderLanes,
      );
    } else {
      // This is the second render. The surrounding visible content has already
      // committed. Now we resume rendering the hidden tree.

      // Rendering at offscreen, so we can clear the base lanes.
      const nextState: OffscreenState = {
        baseLanes: NoLanes,
        cachePool: null,
      };
      workInProgress.memoizedState = nextState;
      if (enableCache && current !== null) {
        // If the render that spawned this one accessed the cache pool, resume
        // using the same cache. Unless the parent changed, since that means
        // there was a refresh.
        const prevCachePool = prevState !== null ? prevState.cachePool : null;
        // TODO: Consider if and how Offscreen pre-rendering should
        // be attributed to the transition that spawned it
        pushTransition(workInProgress, prevCachePool, null);
      }

      // Push the lanes that were skipped when we bailed out.
      if (prevState !== null) {
        pushHiddenContext(workInProgress, prevState);
      } else {
        reuseHiddenContextOnStack(workInProgress);
      }
      pushOffscreenSuspenseHandler(workInProgress);
    }
  } else {
    // Rendering a visible tree.
    if (prevState !== null) {
      // We're going from hidden -> visible.
      let prevCachePool = null;
      if (enableCache) {
        // If the render that spawned this one accessed the cache pool, resume
        // using the same cache. Unless the parent changed, since that means
        // there was a refresh.
        prevCachePool = prevState.cachePool;
      }

      let transitions = null;
      if (enableTransitionTracing) {
        // We have now gone from hidden to visible, so any transitions should
        // be added to the stack to get added to any Offscreen/suspense children
        const instance: OffscreenInstance | null = workInProgress.stateNode;
        if (instance !== null && instance._transitions != null) {
          transitions = Array.from(instance._transitions);
        }
      }

      pushTransition(workInProgress, prevCachePool, transitions);

      // Push the lanes that were skipped when we bailed out.
      pushHiddenContext(workInProgress, prevState);
      reuseSuspenseHandlerOnStack(workInProgress);

      // Since we're not hidden anymore, reset the state
      workInProgress.memoizedState = null;
    } else {
      // We weren't previously hidden, and we still aren't, so there's nothing
      // special to do. Need to push to the stack regardless, though, to avoid
      // a push/pop misalignment.

      if (enableCache) {
        // If the render that spawned this one accessed the cache pool, resume
        // using the same cache. Unless the parent changed, since that means
        // there was a refresh.
        if (current !== null) {
          pushTransition(workInProgress, null, null);
        }
      }

      // We're about to bail out, but we need to push this to the stack anyway
      // to avoid a push/pop misalignment.
      reuseHiddenContextOnStack(workInProgress);
      reuseSuspenseHandlerOnStack(workInProgress);
    }
  }

  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

function deferHiddenOffscreenComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  nextBaseLanes: Lanes,
  renderLanes: Lanes,
) {
  const nextState: OffscreenState = {
    baseLanes: nextBaseLanes,
    // Save the cache pool so we can resume later.
    cachePool: enableCache ? getOffscreenDeferredCache() : null,
  };
  workInProgress.memoizedState = nextState;
  if (enableCache) {
    // push the cache pool even though we're going to bail out
    // because otherwise there'd be a context mismatch
    if (current !== null) {
      pushTransition(workInProgress, null, null);
    }
  }

  // We're about to bail out, but we need to push this to the stack anyway
  // to avoid a push/pop misalignment.
  reuseHiddenContextOnStack(workInProgress);

  pushOffscreenSuspenseHandler(workInProgress);

  if (enableLazyContextPropagation && current !== null) {
    // Since this tree will resume rendering in a separate render, we need
    // to propagate parent contexts now so we don't lose track of which
    // ones changed.
    propagateParentContextChangesToDeferredTree(
      current,
      workInProgress,
      renderLanes,
    );
  }

  return null;
}

// Note: These happen to have identical begin phases, for now. We shouldn't hold
// ourselves to this constraint, though. If the behavior diverges, we should
// fork the function.
const updateLegacyHiddenComponent = updateOffscreenComponent;

function updateCacheComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  if (!enableCache) {
    return null;
  }

  prepareToReadContext(workInProgress, renderLanes);
  const parentCache = readContext(CacheContext);

  if (current === null) {
    // Initial mount. Request a fresh cache from the pool.
    const freshCache = requestCacheFromPool(renderLanes);
    const initialState: CacheComponentState = {
      parent: parentCache,
      cache: freshCache,
    };
    workInProgress.memoizedState = initialState;
    initializeUpdateQueue(workInProgress);
    pushCacheProvider(workInProgress, freshCache);
  } else {
    // Check for updates
    if (includesSomeLane(current.lanes, renderLanes)) {
      cloneUpdateQueue(current, workInProgress);
      processUpdateQueue(workInProgress, null, null, renderLanes);
      suspendIfUpdateReadFromEntangledAsyncAction();
    }
    const prevState: CacheComponentState = current.memoizedState;
    const nextState: CacheComponentState = workInProgress.memoizedState;

    // Compare the new parent cache to the previous to see detect there was
    // a refresh.
    if (prevState.parent !== parentCache) {
      // Refresh in parent. Update the parent.
      const derivedState: CacheComponentState = {
        parent: parentCache,
        cache: parentCache,
      };

      // Copied from getDerivedStateFromProps implementation. Once the update
      // queue is empty, persist the derived state onto the base state.
      workInProgress.memoizedState = derivedState;
      if (workInProgress.lanes === NoLanes) {
        const updateQueue: UpdateQueue<any> = (workInProgress.updateQueue: any);
        workInProgress.memoizedState = updateQueue.baseState = derivedState;
      }

      pushCacheProvider(workInProgress, parentCache);
      // No need to propagate a context change because the refreshed parent
      // already did.
    } else {
      // The parent didn't refresh. Now check if this cache did.
      const nextCache = nextState.cache;
      pushCacheProvider(workInProgress, nextCache);
      if (nextCache !== prevState.cache) {
        // This cache refreshed. Propagate a context change.
        propagateContextChange(workInProgress, CacheContext, renderLanes);
      }
    }
  }

  const nextChildren = workInProgress.pendingProps.children;
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

// This should only be called if the name changes
function updateTracingMarkerComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  if (!enableTransitionTracing) {
    return null;
  }

  // TODO: (luna) Only update the tracing marker if it's newly rendered or it's name changed.
  // A tracing marker is only associated with the transitions that rendered
  // or updated it, so we can create a new set of transitions each time
  if (current === null) {
    const currentTransitions = getPendingTransitions();
    if (currentTransitions !== null) {
      const markerInstance: TracingMarkerInstance = {
        tag: TransitionTracingMarker,
        transitions: new Set(currentTransitions),
        pendingBoundaries: null,
        name: workInProgress.pendingProps.name,
        aborts: null,
      };
      workInProgress.stateNode = markerInstance;

      // We call the marker complete callback when all child suspense boundaries resolve.
      // We do this in the commit phase on Offscreen. If the marker has no child suspense
      // boundaries, we need to schedule a passive effect to make sure we call the marker
      // complete callback.
      workInProgress.flags |= Passive;
    }
  } else {
    if (__DEV__) {
      if (current.memoizedProps.name !== workInProgress.pendingProps.name) {
        console.error(
          'Changing the name of a tracing marker after mount is not supported. ' +
          'To remount the tracing marker, pass it a new key.',
        );
      }
    }
  }

  const instance: TracingMarkerInstance | null = workInProgress.stateNode;
  if (instance !== null) {
    pushMarkerInstance(workInProgress, instance);
  }
  const nextChildren = workInProgress.pendingProps.children;
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

function updateFragment(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  const nextChildren = workInProgress.pendingProps;
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

function updateMode(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  const nextChildren = workInProgress.pendingProps.children;
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

function updateProfiler(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  if (enableProfilerTimer) {
    workInProgress.flags |= Update;

    if (enableProfilerCommitHooks) {
      // Schedule a passive effect for this Profiler to call onPostCommit hooks.
      // This effect should be scheduled even if there is no onPostCommit callback for this Profiler,
      // because the effect is also where times bubble to parent Profilers.
      workInProgress.flags |= Passive;
      // Reset effect durations for the next eventual effect phase.
      // These are reset during render to allow the DevTools commit hook a chance to read them,
      const stateNode = workInProgress.stateNode;
      stateNode.effectDuration = -0;
      stateNode.passiveEffectDuration = -0;
    }
  }
  const nextProps = workInProgress.pendingProps;
  const nextChildren = nextProps.children;
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

function markRef(current: Fiber | null, workInProgress: Fiber) {
  // TODO: Check props.ref instead of fiber.ref when enableRefAsProp is on.
  const ref = workInProgress.ref;
  if (ref === null) {
    if (current !== null && current.ref !== null) {
      // Schedule a Ref effect
      workInProgress.flags |= Ref | RefStatic;
    }
  } else {
    if (typeof ref !== 'function' && typeof ref !== 'object') {
      throw new Error(
        'Expected ref to be a function, an object returned by React.createRef(), or undefined/null.',
      );
    }
    if (current === null || current.ref !== ref) {
      if (!disableStringRefs && current !== null) {
        const oldRef = current.ref;
        const newRef = ref;
        if (
          typeof oldRef === 'function' &&
          typeof newRef === 'function' &&
          typeof oldRef.__stringRef === 'string' &&
          oldRef.__stringRef === newRef.__stringRef &&
          oldRef.__stringRefType === newRef.__stringRefType &&
          oldRef.__stringRefOwner === newRef.__stringRefOwner
        ) {
          // Although this is a different callback, it represents the same
          // string ref. To avoid breaking old Meta code that relies on string
          // refs only being attached once, reuse the old ref. This will
          // prevent us from detaching and reattaching the ref on each update.
          workInProgress.ref = oldRef;
          return;
        }
      }
      // Schedule a Ref effect
      workInProgress.flags |= Ref | RefStatic;
    }
  }
}

function mountIncompleteFunctionComponent(
  _current: null | Fiber,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  renderLanes: Lanes,
) {
  resetSuspendedCurrentOnMountInLegacyMode(_current, workInProgress);

  workInProgress.tag = FunctionComponent;

  return updateFunctionComponent(
    null,
    workInProgress,
    Component,
    nextProps,
    renderLanes,
  );
}

function updateFunctionComponent(
  current: null | Fiber,
  workInProgress: Fiber,
  Component: any,// 实际函数组件本身 如 function MyComponent() {...}
  nextProps: any,// 组件的新props
  renderLanes: Lanes,
) {
  if (__DEV__) {
    if (
      Component.prototype &&
      typeof Component.prototype.render === 'function'
    ) {
      const componentName = getComponentNameFromType(Component) || 'Unknown';

      if (!didWarnAboutBadClass[componentName]) {
        console.error(
          "The <%s /> component appears to have a render method, but doesn't extend React.Component. " +
          'This is likely to cause errors. Change %s to extend React.Component instead.',
          componentName,
          componentName,
        );
        didWarnAboutBadClass[componentName] = true;
      }
    }

    if (workInProgress.mode & StrictLegacyMode) {
      ReactStrictModeWarnings.recordLegacyContextWarning(workInProgress, null);
    }

    if (current === null) {
      // Some validations were previously done in mountIndeterminateComponent however and are now run
      // in updateFuntionComponent but only on mount
      validateFunctionComponentInDev(workInProgress, workInProgress.type);

      if (Component.contextTypes) {
        const componentName = getComponentNameFromType(Component) || 'Unknown';

        if (!didWarnAboutContextTypes[componentName]) {
          didWarnAboutContextTypes[componentName] = true;
          if (disableLegacyContext) {
            console.error(
              '%s uses the legacy contextTypes API which was removed in React 19. ' +
              'Use React.createContext() with React.useContext() instead. ' +
              '(https://react.dev/link/legacy-context)',
              componentName,
            );
          } else {
            console.error(
              '%s uses the legacy contextTypes API which will be removed soon. ' +
              'Use React.createContext() with React.useContext() instead. ' +
              '(https://react.dev/link/legacy-context)',
              componentName,
            );
          }
        }
      }
    }
  }


    // 处理遗留上下文
  // 例如: MyComponent.contextTypes = { theme: PropTypes.object }
  let context;
  if (!disableLegacyContext && !disableLegacyContextForFunctionComponents) {
     // 获取未屏蔽的上下文
    const unmaskedContext = getUnmaskedContext(workInProgress, Component, true);
    // 获取屏蔽后的上下文
    context = getMaskedContext(workInProgress, unmaskedContext);
  }

  let nextChildren;
  let hasId;

  // 为useContext钩子做准备
  prepareToReadContext(workInProgress, renderLanes);

  if (enableSchedulingProfiler) {
    markComponentRenderStarted(workInProgress);
  }
  if (__DEV__) {
    nextChildren = renderWithHooks(
      current,
      workInProgress,
      Component,
      nextProps,
      context,
      renderLanes,
    );
    hasId = checkDidRenderIdHook();
  } else {
    nextChildren = renderWithHooks(
      current,
      workInProgress,
      Component,
      nextProps,
      context,
      renderLanes,
    );
    hasId = checkDidRenderIdHook();
  }
  if (enableSchedulingProfiler) {
    markComponentRenderStopped();
  }

  // 如果是更新且没有接收到更新，尝试复用之前的工作。例如: 当父组件重新渲染但子组件props没变时
  if (current !== null && !didReceiveUpdate) {
    //  跳过hooks更新
    bailoutHooks(current, workInProgress, renderLanes);
    return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
  }

  //  处理服务器渲染水合逻辑
  if (getIsHydrating() && hasId) {
    pushMaterializedTreeId(workInProgress);
  }

  // React DevTools reads this flag.
  workInProgress.flags |= PerformedWork;
  // 处理组件返回的React元素，创建或更新子Fiber节点
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

export function replayFunctionComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  nextProps: any,
  Component: any,
  secondArg: any,
  renderLanes: Lanes,
): Fiber | null {
  // This function is used to replay a component that previously suspended,
  // after its data resolves. It's a simplified version of
  // updateFunctionComponent that reuses the hooks from the previous attempt.

  prepareToReadContext(workInProgress, renderLanes);
  if (enableSchedulingProfiler) {
    markComponentRenderStarted(workInProgress);
  }
  const nextChildren = replaySuspendedComponentWithHooks(
    current,
    workInProgress,
    Component,
    nextProps,
    secondArg,
  );
  const hasId = checkDidRenderIdHook();
  if (enableSchedulingProfiler) {
    markComponentRenderStopped();
  }

  if (current !== null && !didReceiveUpdate) {
    bailoutHooks(current, workInProgress, renderLanes);
    return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
  }

  if (getIsHydrating() && hasId) {
    pushMaterializedTreeId(workInProgress);
  }

  // React DevTools reads this flag.
  workInProgress.flags |= PerformedWork;
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

function updateClassComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  renderLanes: Lanes,
) {
  if (__DEV__) {
    // This is used by DevTools to force a boundary to error.
    switch (shouldError(workInProgress)) {
      case false: {
        const instance = workInProgress.stateNode;
        const ctor = workInProgress.type;
        // TODO This way of resetting the error boundary state is a hack.
        // Is there a better way to do this?
        const tempInstance = new ctor(
          workInProgress.memoizedProps,
          instance.context,
        );
        const state = tempInstance.state;
        instance.updater.enqueueSetState(instance, state, null);
        break;
      }
      case true: {
        workInProgress.flags |= DidCapture;
        workInProgress.flags |= ShouldCapture;
        // eslint-disable-next-line react-internal/prod-error-codes
        const error = new Error('Simulated error coming from DevTools');
        const lane = pickArbitraryLane(renderLanes);
        workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
        // Schedule the error boundary to re-render using updated state
        const root: FiberRoot | null = getWorkInProgressRoot();
        if (root === null) {
          throw new Error(
            'Expected a work-in-progress root. This is a bug in React. Please file an issue.',
          );
        }
        const update = createClassErrorUpdate(lane);
        initializeClassErrorUpdate(
          update,
          root,
          workInProgress,
          createCapturedValueAtFiber(error, workInProgress),
        );
        enqueueCapturedUpdate(workInProgress, update);
        break;
      }
    }
  }

  // Push context providers early to prevent context stack mismatches.
  // During mounting we don't know the child context yet as the instance doesn't exist.
  // We will invalidate the child context in finishClassComponent() right after rendering.
  let hasContext;
  if (isLegacyContextProvider(Component)) {
    hasContext = true;
    pushLegacyContextProvider(workInProgress);
  } else {
    hasContext = false;
  }
  prepareToReadContext(workInProgress, renderLanes);

  const instance = workInProgress.stateNode;
  let shouldUpdate;
  if (instance === null) {
    resetSuspendedCurrentOnMountInLegacyMode(current, workInProgress);

    // In the initial pass we might need to construct the instance.
    constructClassInstance(workInProgress, Component, nextProps);
    mountClassInstance(workInProgress, Component, nextProps, renderLanes);
    shouldUpdate = true;
  } else if (current === null) {
    // In a resume, we'll already have an instance we can reuse.
    shouldUpdate = resumeMountClassInstance(
      workInProgress,
      Component,
      nextProps,
      renderLanes,
    );
  } else {
    shouldUpdate = updateClassInstance(
      current,
      workInProgress,
      Component,
      nextProps,
      renderLanes,
    );
  }
  const nextUnitOfWork = finishClassComponent(
    current,
    workInProgress,
    Component,
    shouldUpdate,
    hasContext,
    renderLanes,
  );
  if (__DEV__) {
    const inst = workInProgress.stateNode;
    if (shouldUpdate && inst.props !== nextProps) {
      if (!didWarnAboutReassigningProps) {
        console.error(
          'It looks like %s is reassigning its own `this.props` while rendering. ' +
          'This is not supported and can lead to confusing bugs.',
          getComponentNameFromFiber(workInProgress) || 'a component',
        );
      }
      didWarnAboutReassigningProps = true;
    }
  }
  return nextUnitOfWork;
}

function finishClassComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  shouldUpdate: boolean,
  hasContext: boolean,
  renderLanes: Lanes,
) {
  // Refs should update even if shouldComponentUpdate returns false
  markRef(current, workInProgress);

  const didCaptureError = (workInProgress.flags & DidCapture) !== NoFlags;

  if (!shouldUpdate && !didCaptureError) {
    // Context providers should defer to sCU for rendering
    if (hasContext) {
      invalidateContextProvider(workInProgress, Component, false);
    }

    return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
  }

  const instance = workInProgress.stateNode;

  // Rerender
  if (__DEV__ || !disableStringRefs) {
    setCurrentFiber(workInProgress);
  }
  let nextChildren;
  if (
    didCaptureError &&
    typeof Component.getDerivedStateFromError !== 'function'
  ) {
    // If we captured an error, but getDerivedStateFromError is not defined,
    // unmount all the children. componentDidCatch will schedule an update to
    // re-render a fallback. This is temporary until we migrate everyone to
    // the new API.
    // TODO: Warn in a future release.
    nextChildren = null;

    if (enableProfilerTimer) {
      stopProfilerTimerIfRunning(workInProgress);
    }
  } else {
    if (enableSchedulingProfiler) {
      markComponentRenderStarted(workInProgress);
    }
    if (__DEV__) {
      nextChildren = callRenderInDEV(instance);
      if (
        debugRenderPhaseSideEffectsForStrictMode &&
        workInProgress.mode & StrictLegacyMode
      ) {
        setIsStrictModeForDevtools(true);
        try {
          callRenderInDEV(instance);
        } finally {
          setIsStrictModeForDevtools(false);
        }
      }
    } else {
      nextChildren = instance.render();
    }
    if (enableSchedulingProfiler) {
      markComponentRenderStopped();
    }
  }

  // React DevTools reads this flag.
  workInProgress.flags |= PerformedWork;
  if (current !== null && didCaptureError) {
    // If we're recovering from an error, reconcile without reusing any of
    // the existing children. Conceptually, the normal children and the children
    // that are shown on error are two different sets, so we shouldn't reuse
    // normal children even if their identities match.
    forceUnmountCurrentAndReconcile(
      current,
      workInProgress,
      nextChildren,
      renderLanes,
    );
  } else {
    reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  }

  // Memoize state using the values we just used to render.
  // TODO: Restructure so we never read values from the instance.
  workInProgress.memoizedState = instance.state;

  // The context might have changed so we need to recalculate it.
  if (hasContext) {
    invalidateContextProvider(workInProgress, Component, true);
  }

  return workInProgress.child;
}

function pushHostRootContext(workInProgress: Fiber) {
  //  因为此时为root节点，它的渲染树stateNode指向FiberRootNode
  const root = (workInProgress.stateNode: FiberRoot);
  if (root.pendingContext) {
    pushTopLevelContextObject(
      workInProgress,
      root.pendingContext,
      root.pendingContext !== root.context,
    );
  } else if (root.context) {
    // Should always be set
    pushTopLevelContextObject(workInProgress, root.context, false);
  }
  pushHostContainer(workInProgress, root.containerInfo);
}

function updateHostRoot(
  current: null | Fiber,//  组件在上一次渲染完成的数据，已加载在DOM上
  workInProgress: Fiber,//  当前组件期望渲染的节点数据
  renderLanes: Lanes,
) {
   // 将HostRoot的上下文推入上下文栈，设置渲染环境的全局配置
  //  例如：设置当前渲染的命名空间(HTML/SVG)、语言方向等
  pushHostRootContext(workInProgress); 
  if (current === null) {
    throw new Error('Should have a current fiber. This is a bug in React.');
  }

  const nextProps = workInProgress.pendingProps;// 通常是{children: [<App/>]}
  const prevState = workInProgress.memoizedState;// 前一次渲染的状态
  const prevChildren = prevState.element;// 前一次渲染的React元素(通常是<App/>)
  
  //  workInProgress虽然基于current进行创建的。但是他们的更新任务指向还是同一个updateQueue。进行解耦
  cloneUpdateQueue(current, workInProgress);

  // 处理组件的状态更新
  processUpdateQueue(workInProgress, nextProps, null, renderLanes);

  const nextState: RootState = workInProgress.memoizedState;// 获取更新后的状态
  const root: FiberRoot = workInProgress.stateNode;// 获取Fiber根节点
  pushRootTransition(workInProgress, root, renderLanes);// 推送根节点的过渡状态


  if (enableTransitionTracing) {
    pushRootMarkerInstance(workInProgress);
  }
  //  处理cache API相关逻辑
  if (enableCache) {
    const nextCache: Cache = nextState.cache;
    pushCacheProvider(workInProgress, nextCache);
    if (nextCache !== prevState.cache) {
      // The root cache refreshed.
      // 传播上下文变更
      propagateContextChange(workInProgress, CacheContext, renderLanes);
    }
  }

  // 检查是否需要因异步操作而挂起
  // 注释解释这应该在processUpdateQueue中，但为避免上下文栈不匹配，放在这里
  suspendIfUpdateReadFromEntangledAsyncAction();

  // 获取新的子元素(通常是应用的根组件，如<App/>)
  // React DevTools依赖于这个属性名为"element"
  const nextChildren = nextState.element;

  // 处理服务端渲染水合(Hydration)相关逻辑
  if (supportsHydration && prevState.isDehydrated) {
    // 这是一个尚未水合的水合根节点，应尝试水合
    
    // 将isDehydrated设为false，表示渲染完成后根节点将不再处于脱水状态
    const overrideState: RootState = {
      element: nextChildren,
      isDehydrated: false,
      cache: nextState.cache,
    };
    const updateQueue: UpdateQueue<RootState> =
      (workInProgress.updateQueue: any);
   // 根节点没有reducer函数，所以baseState可以直接是最新状态
    updateQueue.baseState = overrideState;
    workInProgress.memoizedState = overrideState;

    if (workInProgress.flags & ForceClientRender) {
      // 如果有强制客户端渲染的标记，跳过水合直接客户端渲染
      return mountHostRootWithoutHydrating(
        current,
        workInProgress,
        nextChildren,
        renderLanes,
      );
    } else if (nextChildren !== prevChildren) {
      // 如果在水合前收到更新且子元素变化，也切换到客户端渲染
      const recoverableError = createCapturedValueAtFiber < mixed > (
        new Error(
          'This root received an early update, before anything was able ' +
          'hydrate. Switched the entire root to client rendering.',
        ),
        workInProgress,
      );
      queueHydrationError(recoverableError);
      return mountHostRootWithoutHydrating(
        current,
        workInProgress,
        nextChildren,
        renderLanes,
      );
    } else {
      // 开始水合过程
      enterHydrationState(workInProgress);
 // 创建子Fiber节点
      const child = mountChildFibers(
        workInProgress,
        null,
        nextChildren,
        renderLanes,
      );
      workInProgress.child = child;
       // 标记所有子节点为水合中
      let node = child;
      while (node) {
       // 移除Placement标记，添加Hydrating标记
        // 这表明这个子树是水合树的一部分
        node.flags = (node.flags & ~Placement) | Hydrating;
        node = node.sibling;
      }
    }
  } else {
   // 处理非水合根节点(客户端渲染或已完成水合)
    // already hydrated.
    resetHydrationState();
    
    if (nextChildren === prevChildren) {
      return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
    }
    reconcileChildren(current, workInProgress, nextChildren, renderLanes);// 协调子节点
  }
  return workInProgress.child;
}

function mountHostRootWithoutHydrating(
  current: Fiber,
  workInProgress: Fiber,
  nextChildren: ReactNodeList,
  renderLanes: Lanes,
) {
  // Revert to client rendering.
  resetHydrationState();

  workInProgress.flags |= ForceClientRender;

  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

function updateHostComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  //  水合处理
  if (current === null) {
    tryToClaimNextHydratableInstance(workInProgress);
  }
  // 推入上下文
  pushHostContext(workInProgress);

  const type = workInProgress.type;
  const nextProps = workInProgress.pendingProps;
  const prevProps = current !== null ? current.memoizedProps : null;

  let nextChildren = nextProps.children;
  //  
  const isDirectTextChild = shouldSetTextContent(type, nextProps);

  if (isDirectTextChild) {
    //  直接文本子节点，包没有额外的Fiber节点
    nextChildren = null;
  } else if (prevProps !== null && shouldSetTextContent(type, prevProps)) {
    //  重置。清空原文本
    workInProgress.flags |= ContentReset;
  }
  //  处理异步操作，过度状态
  if (enableAsyncActions) {
    const memoizedState = workInProgress.memoizedState;
    if (memoizedState !== null) {
      const newState = renderTransitionAwareHostComponentWithHooks(
        current,
        workInProgress,
        renderLanes,
      );

      if (isPrimaryRenderer) {
        HostTransitionContext._currentValue = newState;
      } else {
        HostTransitionContext._currentValue2 = newState;
      }
      if (enableLazyContextPropagation) {
        // In the lazy propagation implementation, we don't scan for matching
        // consumers until something bails out.
      } else {
        if (didReceiveUpdate) {
          if (current !== null) {
            const oldStateHook: Hook = current.memoizedState;
            const oldState: TransitionStatus = oldStateHook.memoizedState;
            // This uses regular equality instead of Object.is because we assume
            // that host transition state doesn't include NaN as a valid type.
            if (oldState !== newState) {
              propagateContextChange(
                workInProgress,
                HostTransitionContext,
                renderLanes,
              );
            }
          }
        }
      }
    }
  }
  //  标记ref。 如果相同重新赋值workInProgress.ref，否则flags加上 ｜Ref
  markRef(current, workInProgress);
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

function updateHostHoistable(
  current: null | Fiber,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  markRef(current, workInProgress);

  if (current === null) {
    const resource = getResource(
      workInProgress.type,
      null,
      workInProgress.pendingProps,
      null,
    );
    if (resource) {
      workInProgress.memoizedState = resource;
    } else {
      if (!getIsHydrating()) {
        // This is not a Resource Hoistable and we aren't hydrating so we construct the instance.
        workInProgress.stateNode = createHoistableInstance(
          workInProgress.type,
          workInProgress.pendingProps,
          getRootHostContainer(),
          workInProgress,
        );
      }
    }
  } else {
    // Get Resource may or may not return a resource. either way we stash the result
    // on memoized state.
    workInProgress.memoizedState = getResource(
      workInProgress.type,
      current.memoizedProps,
      workInProgress.pendingProps,
      current.memoizedState,
    );
  }

  // Resources never have reconciler managed children. It is possible for
  // the host implementation of getResource to consider children in the
  // resource construction but they will otherwise be discarded. In practice
  // this precludes all but the simplest children and Host specific warnings
  // should be implemented to warn when children are passsed when otherwise not
  // expected
  return null;
}

function updateHostSingleton(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  pushHostContext(workInProgress);

  if (current === null) {
    claimHydratableSingleton(workInProgress);
  }

  const nextChildren = workInProgress.pendingProps.children;

  if (current === null && !getIsHydrating()) {
    // Similar to Portals we append Singleton children in the commit phase. So we
    // Track insertions even on mount.
    // TODO: Consider unifying this with how the root works.
    workInProgress.child = reconcileChildFibers(
      workInProgress,
      null,
      nextChildren,
      renderLanes,
    );
  } else {
    reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  }
  markRef(current, workInProgress);
  return workInProgress.child;
}

function updateHostText(current: null | Fiber, workInProgress: Fiber) {
  if (current === null) {
    tryToClaimNextHydratableTextInstance(workInProgress);
  }
  // Nothing to do here. This is terminal. We'll do the completion step
  // immediately after.
  return null;
}

function mountLazyComponent(
  _current: null | Fiber,
  workInProgress: Fiber,
  elementType: any,// React.lazy返回的对象.包含了如何加载实际组件信息的特殊对象。$$typeof,_init,_payload
  renderLanes: Lanes,
) {
  debugger
  // 在Legacy模式下重置挂起的当前Fiber
  // 这主要处理特殊的挂载情况，确保在Legacy模式下正确处理Suspense
  resetSuspendedCurrentOnMountInLegacyMode(_current, workInProgress);

  //传递给lazy组件的props。例如: <LazyComponent name="value" />中的{name: "value"}
  const props = workInProgress.pendingProps;

  const lazyComponent: LazyComponentType<any, any> = elementType;

  let Component;
  if (__DEV__) {
    Component = callLazyInitInDEV(lazyComponent);
  } else {
    const payload = lazyComponent._payload;
    const init = lazyComponent._init;
    // 如果import()还未完成，这里可能会抛出一个Promise
    // 该Promise会被Suspense捕获，显示fallback内容
    Component = init(payload);// 一个异步的过程。promise对象===>实际结果
  }
  //  此时代表加载完毕。初始化会throw promise
  // 将解析出的实际组件存储在workInProgress.type中
  // 这样React后续可以直接使用这个组件，而不需要再次解析
  workInProgress.type = Component;
  if (typeof Component === 'function') {
    // 判断是否为类组件。调用updateClassComponent处理类组件
    if (isFunctionClassComponent(Component)) {
      const resolvedProps = resolveClassComponentProps(Component, props, false);
      //  设置tag
      workInProgress.tag = ClassComponent;
      if (__DEV__) {
        workInProgress.type = Component =
          resolveClassForHotReloading(Component);
      }
      return updateClassComponent(
        null,
        workInProgress,
        Component,
        resolvedProps,
        renderLanes,
      );
    } else {
      // 函数组件
      const resolvedProps = disableDefaultPropsExceptForClasses
        ? props
        : resolveDefaultPropsOnNonClassComponent(Component, props);
        //  设置tag
      workInProgress.tag = FunctionComponent;
      if (__DEV__) {
        validateFunctionComponentInDev(workInProgress, Component);
        workInProgress.type = Component =
          resolveFunctionForHotReloading(Component);
      }
      //  调用updateFunctionComponent处理函数组件
      return updateFunctionComponent(
        null,
        workInProgress,
        Component,
        resolvedProps,
        renderLanes,
      );
    }
  } else if (Component !== undefined && Component !== null) {
    // 组件不是函数，但也不是undefined或null
    // 可能是特殊的React组件类型
    const $$typeof = Component.$$typeof;
    
    // 是React.forwardRef创建的组件
    // 例如: const MyComponent = React.forwardRef((props, ref) => {...})
    if ($$typeof === REACT_FORWARD_REF_TYPE) {
      const resolvedProps = disableDefaultPropsExceptForClasses
        ? props
        : resolveDefaultPropsOnNonClassComponent(Component, props);
      workInProgress.tag = ForwardRef;
      if (__DEV__) {
        workInProgress.type = Component =
          resolveForwardRefForHotReloading(Component);
      }
      // 调用updateForwardRef处理forwardRef组件
      return updateForwardRef(
        null,
        workInProgress,
        Component,
        resolvedProps,
        renderLanes,
      );
    } else if ($$typeof === REACT_MEMO_TYPE) {
      // React.memo
      const resolvedProps = disableDefaultPropsExceptForClasses
        ? props
        : resolveDefaultPropsOnNonClassComponent(Component, props);
      workInProgress.tag = MemoComponent;
      //  调用updateMemoComponent处理memo组件
      return updateMemoComponent(
        null,
        workInProgress,
        Component,
        disableDefaultPropsExceptForClasses
          ? resolvedProps
          : resolveDefaultPropsOnNonClassComponent(
            Component.type,
            resolvedProps,
          ), // The inner type can have defaults too
        renderLanes,
      );
    }
  }

  let hint = '';
  //  报错
  if (__DEV__) {
    if (
      Component !== null &&
      typeof Component === 'object' &&
      Component.$$typeof === REACT_LAZY_TYPE
    ) {
      hint = ' Did you wrap a component in React.lazy() more than once?';
    }
  }

  const loggedComponent = getComponentNameFromType(Component) || Component;

  // This message intentionally doesn't mention ForwardRef or MemoComponent
  // because the fact that it's a separate type of work is an
  // implementation detail.
  throw new Error(
    `Element type is invalid. Received a promise that resolves to: ${loggedComponent}. ` +
    `Lazy element type must resolve to a class or function.${hint}`,
  );
}

function mountIncompleteClassComponent(
  _current: null | Fiber,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  renderLanes: Lanes,
) {
  resetSuspendedCurrentOnMountInLegacyMode(_current, workInProgress);

  // Promote the fiber to a class and try rendering again.
  workInProgress.tag = ClassComponent;

  // The rest of this function is a fork of `updateClassComponent`

  // Push context providers early to prevent context stack mismatches.
  // During mounting we don't know the child context yet as the instance doesn't exist.
  // We will invalidate the child context in finishClassComponent() right after rendering.
  let hasContext;
  if (isLegacyContextProvider(Component)) {
    hasContext = true;
    pushLegacyContextProvider(workInProgress);
  } else {
    hasContext = false;
  }
  prepareToReadContext(workInProgress, renderLanes);

  constructClassInstance(workInProgress, Component, nextProps);
  mountClassInstance(workInProgress, Component, nextProps, renderLanes);

  return finishClassComponent(
    null,
    workInProgress,
    Component,
    true,
    hasContext,
    renderLanes,
  );
}

function validateFunctionComponentInDev(workInProgress: Fiber, Component: any) {
  if (__DEV__) {
    if (Component && Component.childContextTypes) {
      console.error(
        'childContextTypes cannot be defined on a function component.\n' +
        '  %s.childContextTypes = ...',
        Component.displayName || Component.name || 'Component',
      );
    }
    if (!enableRefAsProp && workInProgress.ref !== null) {
      let info = '';
      const componentName = getComponentNameFromType(Component) || 'Unknown';
      const ownerName = getCurrentFiberOwnerNameInDevOrNull();
      if (ownerName) {
        info += '\n\nCheck the render method of `' + ownerName + '`.';
      }

      const warningKey = componentName + '|' + (ownerName || '');
      if (!didWarnAboutFunctionRefs[warningKey]) {
        didWarnAboutFunctionRefs[warningKey] = true;
        console.error(
          'Function components cannot be given refs. ' +
          'Attempts to access this ref will fail. ' +
          'Did you mean to use React.forwardRef()?%s',
          info,
        );
      }
    }

    if (
      !disableDefaultPropsExceptForClasses &&
      Component.defaultProps !== undefined
    ) {
      const componentName = getComponentNameFromType(Component) || 'Unknown';

      if (!didWarnAboutDefaultPropsOnFunctionComponent[componentName]) {
        console.error(
          '%s: Support for defaultProps will be removed from function components ' +
          'in a future major release. Use JavaScript default parameters instead.',
          componentName,
        );
        didWarnAboutDefaultPropsOnFunctionComponent[componentName] = true;
      }
    }

    if (typeof Component.getDerivedStateFromProps === 'function') {
      const componentName = getComponentNameFromType(Component) || 'Unknown';

      if (!didWarnAboutGetDerivedStateOnFunctionComponent[componentName]) {
        console.error(
          '%s: Function components do not support getDerivedStateFromProps.',
          componentName,
        );
        didWarnAboutGetDerivedStateOnFunctionComponent[componentName] = true;
      }
    }

    if (
      typeof Component.contextType === 'object' &&
      Component.contextType !== null
    ) {
      const componentName = getComponentNameFromType(Component) || 'Unknown';

      if (!didWarnAboutContextTypeOnFunctionComponent[componentName]) {
        console.error(
          '%s: Function components do not support contextType.',
          componentName,
        );
        didWarnAboutContextTypeOnFunctionComponent[componentName] = true;
      }
    }
  }
}

const SUSPENDED_MARKER: SuspenseState = {
  dehydrated: null,
  treeContext: null,
  retryLane: NoLane,
};

function mountSuspenseOffscreenState(renderLanes: Lanes): OffscreenState {
  return {
    baseLanes: renderLanes,
    cachePool: getSuspendedCache(),
  };
}

function updateSuspenseOffscreenState(
  prevOffscreenState: OffscreenState,
  renderLanes: Lanes,
): OffscreenState {
  let cachePool: SpawnedCachePool | null = null;
  if (enableCache) {
    const prevCachePool: SpawnedCachePool | null = prevOffscreenState.cachePool;
    if (prevCachePool !== null) {
      const parentCache = isPrimaryRenderer
        ? CacheContext._currentValue
        : CacheContext._currentValue2;
      if (prevCachePool.parent !== parentCache) {
        // Detected a refresh in the parent. This overrides any previously
        // suspended cache.
        cachePool = {
          parent: parentCache,
          pool: parentCache,
        };
      } else {
        // We can reuse the cache from last time. The only thing that would have
        // overridden it is a parent refresh, which we checked for above.
        cachePool = prevCachePool;
      }
    } else {
      // If there's no previous cache pool, grab the current one.
      cachePool = getSuspendedCache();
    }
  }
  return {
    baseLanes: mergeLanes(prevOffscreenState.baseLanes, renderLanes),
    cachePool,
  };
}

// TODO: Probably should inline this back
function shouldRemainOnFallback(
  current: null | Fiber,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  // If we're already showing a fallback, there are cases where we need to
  // remain on that fallback regardless of whether the content has resolved.
  // For example, SuspenseList coordinates when nested content appears.
  // TODO: For compatibility with offscreen prerendering, this should also check
  // whether the current fiber (if it exists) was visible in the previous tree.
  if (current !== null) {
    const suspenseState: SuspenseState = current.memoizedState;
    if (suspenseState === null) {
      // Currently showing content. Don't hide it, even if ForceSuspenseFallback
      // is true. More precise name might be "ForceRemainSuspenseFallback".
      // Note: This is a factoring smell. Can't remain on a fallback if there's
      // no fallback to remain on.
      return false;
    }
  }

  // Not currently showing content. Consult the Suspense context.
  const suspenseContext: SuspenseContext = suspenseStackCursor.current;
  return hasSuspenseListContext(
    suspenseContext,
    (ForceSuspenseFallback: SuspenseContext),
  );
}

function getRemainingWorkInPrimaryTree(
  current: Fiber | null,
  primaryTreeDidDefer: boolean,
  renderLanes: Lanes,
) {
  let remainingLanes =
    current !== null ? removeLanes(current.childLanes, renderLanes) : NoLanes;
  if (primaryTreeDidDefer) {
    // A useDeferredValue hook spawned a deferred task inside the primary tree.
    // Ensure that we retry this component at the deferred priority.
    // TODO: We could make this a per-subtree value instead of a global one.
    // Would need to track it on the context stack somehow, similar to what
    // we'd have to do for resumable contexts.
    remainingLanes = mergeLanes(remainingLanes, peekDeferredLane());
  }
  return remainingLanes;
}

function updateSuspenseComponent(
  current: null | Fiber,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  const nextProps = workInProgress.pendingProps;
  let showFallback = false;// 是否显示fallback内容
  const didSuspend = (workInProgress.flags & DidCapture) !== NoFlags;//  挂起状态的捕获，子组件抛出promise
  if (
    didSuspend ||// 捕获到挂起状态，需要渲染fallback
    shouldRemainOnFallback(current, workInProgress, renderLanes)
  ) {
    // shouldRemainOnFallback：某些时间，即使加载完毕了也需要渲染fallback
    //1、SuspenseList中，revealOrder=together，初始化时，其它节点没挂载完成，也需要展示fallback。但后续更新时不需要，避免闪烁
    // 2.Transition更新时，不会插入 ｜DidCapture。而是将更新任务通过promise挂起。thenable.then(()=> scheduleUpdateOnFiber)
    //  所以并没有didSuspend，suspenseState也为null，不触发fallback
    //  本质为非正规途径，修改memorizedStates,又没打上DidCapture，且current有内容渲染，所以不会回退

    showFallback = true;
    workInProgress.flags &= ~DidCapture;
  }

  //  检测是否存在延迟任务（useDeferredValue）
  const didPrimaryChildrenDefer = (workInProgress.flags & DidDefer) !== NoFlags;
  workInProgress.flags &= ~DidDefer;

  // 以下是 Suspense 边界子组件协调的复杂逻辑说明
  //
  // 首先，Legacy 模式有不同的语义以保持向后兼容性。主树会在不一致的状态下提交，
  // 所以当我们进行第二次渲染回退内容时，需要一些非常巧妙的技巧来避免完全崩溃。
  // 比如从隐藏树中转移效果和删除操作。在 Concurrent 模式下，这要简单得多，
  // 因为我们完全放弃主树并保持其旧状态，没有效果。与 Offscreen 的处理方式相同
  // （只是 Offscreen 没有第一次渲染过程）。
  //
  // 其次是水合（hydration）。在水合过程中，Suspense fiber 有略微不同的布局，
  // 其中子节点指向一个脱水片段，该片段包含服务器渲染的 DOM。
  //
  // 第三，即使撇开所有这些，Suspense 类似于错误边界，我们首先尝试渲染一棵树，
  // 如果失败，我们再次渲染并切换到不同的树。就像 try/catch 块一样。
  // 所以我们需要跟踪当前正在渲染的分支。理想情况下，我们会使用栈来模拟这个过程。
  
  //  首次挂载
  if (current === null) {
    // 水合的特殊路径,如果当前正在水合，尝试水合这个边界
    if (getIsHydrating()) {
      // 在尝试水合之前，必须推入 suspense 处理程序上下文，以避免错误时出现不匹配
      if (showFallback) {
        pushPrimaryTreeSuspenseHandler(workInProgress);
      } else {
        pushFallbackTreeSuspenseHandler(workInProgress);
      }
      //  获取下一个水合节点，并生成脱水数据，并跟当前Fiber关联。方便子节点查询等操作
      tryToClaimNextHydratableSuspenseInstance(workInProgress);
      
      //  此时有可能是脱水的实际内容或者脱水的fallback
      const suspenseState: null | SuspenseState = workInProgress.memoizedState;
      if (suspenseState !== null) {
        const dehydrated = suspenseState.dehydrated;
        if (dehydrated !== null) {
          return mountDehydratedSuspenseComponent(
            workInProgress,
            dehydrated,
            renderLanes,
          );
        }
      }
      //  弹出suspense堆栈
      popSuspenseHandler(workInProgress);
    }
    // 获取主要子组件和回退子组件
    const nextPrimaryChildren = nextProps.children;// 实际子组件
    const nextFallbackChildren = nextProps.fallback;//  回退子组件
    // 如果需要显示回退内容
    if (showFallback) {
      //  渲染备用方案fallback，需要使用当前的suspense状态。
      //  此时当前状态为DidCapture，再次捕获会throw value冒泡出去
      pushFallbackTreeSuspenseHandler(workInProgress);

      //渲染fallback的Fiber，以及primaryChildFiber。primaryChildFragment的type为offscreen离屏类型
      const fallbackFragment = mountSuspenseFallbackChildren(
        workInProgress,
        nextPrimaryChildren,
        nextFallbackChildren,
        renderLanes,
      );

      const primaryChildFragment: Fiber = (workInProgress.child: any);
      //  保存创建offscreen组件时的优先级，以及此时的Cache缓存
      primaryChildFragment.memoizedState = mountSuspenseOffscreenState(renderLanes);

      primaryChildFragment.childLanes = getRemainingWorkInPrimaryTree(
        current,
        didPrimaryChildrenDefer,
        renderLanes,
      );
      // 标记当前 Suspense 组件为挂起状态
      workInProgress.memoizedState = SUSPENDED_MARKER;
      debugger
      // 启用过渡追踪的特殊处理   
      if (enableTransitionTracing) {
        const currentTransitions = getPendingTransitions();
        if (currentTransitions !== null) {
          const parentMarkerInstances = getMarkerInstances();
          const offscreenQueue: OffscreenQueue | null =
            (primaryChildFragment.updateQueue: any);
          if (offscreenQueue === null) {
            const newOffscreenQueue: OffscreenQueue = {
              transitions: currentTransitions,
              markerInstances: parentMarkerInstances,
              retryQueue: null,
            };
            primaryChildFragment.updateQueue = newOffscreenQueue;
          } else {
            offscreenQueue.transitions = currentTransitions;
            offscreenQueue.markerInstances = parentMarkerInstances;
          }
        }
      }

      return fallbackFragment;
    } else if ( enableCPUSuspense &&  typeof nextProps.unstable_expectedLoadTime === 'number' ) {
      // cpu密集型处理
      //<Suspense unstable_expectedLoadTime={3000}>
      pushFallbackTreeSuspenseHandler(workInProgress);
      const fallbackFragment = mountSuspenseFallbackChildren(
        workInProgress,
        nextPrimaryChildren,
        nextFallbackChildren,
        renderLanes,
      );
      const primaryChildFragment: Fiber = (workInProgress.child: any);
      primaryChildFragment.memoizedState = mountSuspenseOffscreenState(renderLanes);
      primaryChildFragment.childLanes = getRemainingWorkInPrimaryTree(
        current,
        didPrimaryChildrenDefer,
        renderLanes,
      );
      workInProgress.memoizedState = SUSPENDED_MARKER;
      // TODO: 过渡追踪尚未为 CPU Suspense 实现
      workInProgress.lanes = SomeRetryLane;
      return fallbackFragment;
    } else {
      // 正常情况：显示主要内容 
      pushPrimaryTreeSuspenseHandler(workInProgress);
      // 挂载 Suspense 主要子组件
      return mountSuspensePrimaryChildren(
        workInProgress,
        nextPrimaryChildren,
        renderLanes,
      );
    }
  } else {
   // 检查是否是服务端渲染的水合路径
    const prevState: null | SuspenseState = current.memoizedState;
    if (prevState !== null) {
      //  水合的标识。在水合初始化读取DOM并创建Fiber的时候，就会预设memoizedState 
      // fiber.memoizedState = {
      //   dehydrated: suspenseInstance,
      //   treeContext: getTreeContext(),
      //   retryLane: NoLane
      // };
      const dehydrated = prevState.dehydrated;
      if (dehydrated !== null) {
        // 更新脱水的 Suspense 组件。
        //  有可能抛错：SelectiveHydrationException
        //  有可能是多次尝试：选择删除节点，放弃水合，创建新的primaryChildFragment并return

        return updateDehydratedSuspenseComponent(
          current,
          workInProgress,
          didSuspend,
          didPrimaryChildrenDefer,
          nextProps,
          dehydrated,
          prevState,
          renderLanes,
        );
      }
    }
    // 如果需要显示回退内容
    if (showFallback) {
      pushFallbackTreeSuspenseHandler(workInProgress);
       // 获取回退子组件和主要子组件
      const nextFallbackChildren = nextProps.fallback;
      const nextPrimaryChildren = nextProps.children;
      const fallbackChildFragment = updateSuspenseFallbackChildren(
        current,
        workInProgress,
        nextPrimaryChildren,
        nextFallbackChildren,
        renderLanes,
      );
      // 获取主要子片段
      const primaryChildFragment: Fiber = (workInProgress.child: any);
       // 获取之前的离屏状态
      const prevOffscreenState: OffscreenState | null = (current.child: any).memoizedState;
        // 更新主要子片段的 memoizedState
      primaryChildFragment.memoizedState =
        prevOffscreenState === null
          ? mountSuspenseOffscreenState(renderLanes)
          : updateSuspenseOffscreenState(prevOffscreenState, renderLanes);
          // 启用过渡追踪的特殊处理
      if (enableTransitionTracing) {
        const currentTransitions = getPendingTransitions();
        if (currentTransitions !== null) {
          const parentMarkerInstances = getMarkerInstances();
          const offscreenQueue: OffscreenQueue | null =
            (primaryChildFragment.updateQueue: any);
          const currentOffscreenQueue: OffscreenQueue | null =
            (current.updateQueue: any);
          if (offscreenQueue === null) {
            const newOffscreenQueue: OffscreenQueue = {
              transitions: currentTransitions,
              markerInstances: parentMarkerInstances,
              retryQueue: null,
            };
            primaryChildFragment.updateQueue = newOffscreenQueue;
          } else if (offscreenQueue === currentOffscreenQueue) {
            // If the work-in-progress queue is the same object as current, we
            // can't modify it without cloning it first.
            const newOffscreenQueue: OffscreenQueue = {
              transitions: currentTransitions,
              markerInstances: parentMarkerInstances,
              retryQueue:
                currentOffscreenQueue !== null
                  ? currentOffscreenQueue.retryQueue
                  : null,
            };
            primaryChildFragment.updateQueue = newOffscreenQueue;
          } else {
            offscreenQueue.transitions = currentTransitions;
            offscreenQueue.markerInstances = parentMarkerInstances;
          }
        }
      }
        // 保存当前工作树的 childLanes。合并延迟任务
      primaryChildFragment.childLanes = getRemainingWorkInPrimaryTree(
        current,
        didPrimaryChildrenDefer,
        renderLanes,
      );
      workInProgress.memoizedState = SUSPENDED_MARKER;
      // 返回回退子片段
      return fallbackChildFragment;
    } else {
      // 正常情况：显示主要内容
      pushPrimaryTreeSuspenseHandler(workInProgress);
    // 获取主要子组件
      const nextPrimaryChildren = nextProps.children;
      // 更新 Suspense 主要子组件
      const primaryChildFragment = updateSuspensePrimaryChildren(
        current,
        workInProgress,
        nextPrimaryChildren,
        renderLanes,
      );
      workInProgress.memoizedState = null;
       // 返回主要子片段
      return primaryChildFragment;
    }
  }
}

function mountSuspensePrimaryChildren(
  workInProgress: Fiber,
  primaryChildren: $FlowFixMe,
  renderLanes: Lanes,
) {
  const mode = workInProgress.mode;
  const primaryChildProps: OffscreenProps = {
    mode: 'visible',
    children: primaryChildren,
  };
  const primaryChildFragment = mountWorkInProgressOffscreenFiber(
    primaryChildProps,
    mode,
    renderLanes,
  );
  primaryChildFragment.return = workInProgress;
  workInProgress.child = primaryChildFragment;
  return primaryChildFragment;
}

function mountSuspenseFallbackChildren(
  workInProgress: Fiber,
  primaryChildren: $FlowFixMe,
  fallbackChildren: $FlowFixMe,
  renderLanes: Lanes,
) {
  const mode = workInProgress.mode;// 当前Fiber的渲染模式，legacy、concurrent
  const progressedPrimaryFragment: Fiber | null = workInProgress.child;// 可能存在的子Fiber
  // 初始化状态，隐藏
  const primaryChildProps: OffscreenProps = {
    mode: 'hidden',
    children: primaryChildren,
  };

  let primaryChildFragment;// child对应的Fiber
  let fallbackChildFragment;//  fallback的Fiber

  //  Legacy模式下,当前已渲染了部分child
  if ( !disableLegacyMode && (mode & ConcurrentMode) === NoMode && progressedPrimaryFragment !== null ) {
    // Legacy模式下,重用已存在的Fiber
    primaryChildFragment = progressedPrimaryFragment;
    primaryChildFragment.childLanes = NoLanes;
    primaryChildFragment.pendingProps = primaryChildProps;

    //  ProfileMode性能模式下的测试处理
    if (enableProfilerTimer && workInProgress.mode & ProfileMode) {
      primaryChildFragment.actualDuration = -0;
      primaryChildFragment.actualStartTime = -1.1;
      primaryChildFragment.selfBaseDuration = -0;
      primaryChildFragment.treeBaseDuration = -0;
    }
    //  创建fallback内容的Fiber
    fallbackChildFragment = createFiberFromFragment(
      fallbackChildren,
      mode,
      renderLanes,
      null,
    );
  } else {
    // Concurrent模式或没有现成fiber的情况
    // 创建新的Offscreen fiber来包装主要内容
    primaryChildFragment = mountWorkInProgressOffscreenFiber(
      primaryChildProps,
      mode,
      NoLanes,// 不需要立即渲染，因为是隐藏的
    );
    //  创建fallback子组件
    fallbackChildFragment = createFiberFromFragment(
      fallbackChildren,
      mode,
      renderLanes,// 当前渲染等级，需要马上渲染
      null,
    );
  }

  primaryChildFragment.return = workInProgress;
  fallbackChildFragment.return = workInProgress;
  primaryChildFragment.sibling = fallbackChildFragment;
  workInProgress.child = primaryChildFragment;
  return fallbackChildFragment;
}

function mountWorkInProgressOffscreenFiber(
  offscreenProps: OffscreenProps,
  mode: TypeOfMode,
  renderLanes: Lanes,
) {
  // The props argument to `createFiberFromOffscreen` is `any` typed, so we use
  // this wrapper function to constrain it.
  return createFiberFromOffscreen(offscreenProps, mode, NoLanes, null);
}

function updateWorkInProgressOffscreenFiber(
  current: Fiber,
  offscreenProps: OffscreenProps,
) {
  // The props argument to `createWorkInProgress` is `any` typed, so we use this
  // wrapper function to constrain it.
  return createWorkInProgress(current, offscreenProps);
}

function updateSuspensePrimaryChildren(
  current: Fiber,
  workInProgress: Fiber,
  primaryChildren: $FlowFixMe,
  renderLanes: Lanes,
) {
  const currentPrimaryChildFragment: Fiber = (current.child: any);
  const currentFallbackChildFragment: Fiber | null =
    currentPrimaryChildFragment.sibling;

  const primaryChildFragment = updateWorkInProgressOffscreenFiber(
    currentPrimaryChildFragment,
    {
      mode: 'visible',
      children: primaryChildren,
    },
  );
  if (!disableLegacyMode && (workInProgress.mode & ConcurrentMode) === NoMode) {
    primaryChildFragment.lanes = renderLanes;
  }
  primaryChildFragment.return = workInProgress;
  primaryChildFragment.sibling = null;
  if (currentFallbackChildFragment !== null) {
    // Delete the fallback child fragment
    const deletions = workInProgress.deletions;
    if (deletions === null) {
      workInProgress.deletions = [currentFallbackChildFragment];
      workInProgress.flags |= ChildDeletion;
    } else {
      deletions.push(currentFallbackChildFragment);
    }
  }

  workInProgress.child = primaryChildFragment;
  return primaryChildFragment;
}

function updateSuspenseFallbackChildren(
  current: Fiber,
  workInProgress: Fiber,
  primaryChildren: $FlowFixMe,
  fallbackChildren: $FlowFixMe,
  renderLanes: Lanes,
) {
  const mode = workInProgress.mode;
  const currentPrimaryChildFragment: Fiber = (current.child: any);
  const currentFallbackChildFragment: Fiber | null =currentPrimaryChildFragment.sibling;

  const primaryChildProps: OffscreenProps = {
    mode: 'hidden',
    children: primaryChildren,
  };

  let primaryChildFragment;
  if (
    !disableLegacyMode &&
    (mode & ConcurrentMode) === NoMode &&
    workInProgress.child !== currentPrimaryChildFragment
  ) {
    //  legacy模式下，因为同步的原因，会渲染部分child，应该复用工作树的child
    const progressedPrimaryFragment: Fiber = (workInProgress.child: any);
    primaryChildFragment = progressedPrimaryFragment;
    primaryChildFragment.childLanes = NoLanes;
    primaryChildFragment.pendingProps = primaryChildProps;

    if (enableProfilerTimer && workInProgress.mode & ProfileMode) {
      // Reset the durations from the first pass so they aren't included in the
      // final amounts. This seems counterintuitive, since we're intentionally
      // not measuring part of the render phase, but this makes it match what we
      // do in Concurrent Mode.
      primaryChildFragment.actualDuration = -0;
      primaryChildFragment.actualStartTime = -1.1;
      primaryChildFragment.selfBaseDuration =
        currentPrimaryChildFragment.selfBaseDuration;
      primaryChildFragment.treeBaseDuration =
        currentPrimaryChildFragment.treeBaseDuration;
    }

    //  渲染失败会标记需要删除的节点。避免fallback删除
    workInProgress.deletions = null;
  } else {
    //  复用current树中的主要内容，并更新状态
    primaryChildFragment = updateWorkInProgressOffscreenFiber(
      currentPrimaryChildFragment,
      primaryChildProps,
    );
    //  仅保留静态数据，并清理动态flag。如Visibility
    primaryChildFragment.subtreeFlags = currentPrimaryChildFragment.subtreeFlags & StaticMask;
  }// 以上目的是为了获取正确的primaryChildFragment

  let fallbackChildFragment;
  if (currentFallbackChildFragment !== null) {
    fallbackChildFragment = createWorkInProgress(
      currentFallbackChildFragment,
      fallbackChildren,
    );
  } else {
    fallbackChildFragment = createFiberFromFragment(
      fallbackChildren,
      mode,
      renderLanes,
      null,
    );
    // Needs a placement effect because the parent (the Suspense boundary) already
    // mounted but this is a new fiber.
    fallbackChildFragment.flags |= Placement;
  }

  fallbackChildFragment.return = workInProgress;
  primaryChildFragment.return = workInProgress;
  primaryChildFragment.sibling = fallbackChildFragment;
  workInProgress.child = primaryChildFragment;

  return fallbackChildFragment;
}

function retrySuspenseComponentWithoutHydrating(
  current: Fiber,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  // Falling back to client rendering. Because this has performance
  // implications, it's considered a recoverable error, even though the user
  // likely won't observe anything wrong with the UI.

  // 删除当前节点。newChild=null
  reconcileChildFibers(workInProgress, current.child, null, renderLanes);

  // 重新以客户端的方式挂载suspense。
  const nextProps = workInProgress.pendingProps;
  const primaryChildren = nextProps.children;
  const primaryChildFragment = mountSuspensePrimaryChildren(
    workInProgress,
    primaryChildren,
    renderLanes,
  );
  // Needs a placement effect because the parent (the Suspense boundary) already
  // mounted but this is a new fiber.
  primaryChildFragment.flags |= Placement;
  workInProgress.memoizedState = null;

  return primaryChildFragment;
}

function mountSuspenseFallbackAfterRetryWithoutHydrating(
  current: Fiber,
  workInProgress: Fiber,
  primaryChildren: $FlowFixMe,
  fallbackChildren: $FlowFixMe,
  renderLanes: Lanes,
) {
  const fiberMode = workInProgress.mode;
  const primaryChildProps: OffscreenProps = {
    mode: 'visible',
    children: primaryChildren,
  };
  const primaryChildFragment = mountWorkInProgressOffscreenFiber(
    primaryChildProps,
    fiberMode,
    NoLanes,
  );
  const fallbackChildFragment = createFiberFromFragment(
    fallbackChildren,
    fiberMode,
    renderLanes,
    null,
  );
  // Needs a placement effect because the parent (the Suspense
  // boundary) already mounted but this is a new fiber.
  fallbackChildFragment.flags |= Placement;

  primaryChildFragment.return = workInProgress;
  fallbackChildFragment.return = workInProgress;
  primaryChildFragment.sibling = fallbackChildFragment;
  workInProgress.child = primaryChildFragment;

  if (disableLegacyMode || (workInProgress.mode & ConcurrentMode) !== NoMode) {
    // We will have dropped the effect list which contains the
    // deletion. We need to reconcile to delete the current child.
    reconcileChildFibers(workInProgress, current.child, null, renderLanes);
  }

  return fallbackChildFragment;
}

function mountDehydratedSuspenseComponent(
  workInProgress: Fiber,
  suspenseInstance: SuspenseInstance,
  renderLanes: Lanes,
): null | Fiber {
  // During the first pass, we'll bail out and not drill into the children.
  // Instead, we'll leave the content in place and try to hydrate it later.
  if (isSuspenseInstanceFallback(suspenseInstance)) {
    // This is a client-only boundary. Since we won't get any content from the server
    // for this, we need to schedule that at a higher priority based on when it would
    // have timed out. In theory we could render it in this pass but it would have the
    // wrong priority associated with it and will prevent hydration of parent path.
    // Instead, we'll leave work left on it to render it in a separate commit.

    // TODO This time should be the time at which the server rendered response that is
    // a parent to this boundary was displayed. However, since we currently don't have
    // a protocol to transfer that time, we'll just estimate it by using the current
    // time. This will mean that Suspense timeouts are slightly shifted to later than
    // they should be.
    // Schedule a normal pri update to render this content.
    workInProgress.lanes = laneToLanes(DefaultHydrationLane);
  } else {
    // We'll continue hydrating the rest at offscreen priority since we'll already
    // be showing the right content coming from the server, it is no rush.
    workInProgress.lanes = laneToLanes(OffscreenLane);
  }
  return null;
}

function updateDehydratedSuspenseComponent(
  current: Fiber,
  workInProgress: Fiber,
  didSuspend: boolean,// 捕获标识 DidCapture
  didPrimaryChildrenDefer: boolean,
  nextProps: any,
  suspenseInstance: SuspenseInstance,
  suspenseState: SuspenseState,
  renderLanes: Lanes,
): null | Fiber {
  //  存在更新/上下文变化时，提高优先级重新进行
  //  pending阶段，等待服务端继续传输。会注册回调，等待传输完毕再执行
  //  都不满足，且没有捕获到DidCapture。为第一次水合
  //  如果捕获到了，为第二次尝试水合

  if (!didSuspend) {
    // 这是第一次渲染 。尝试进行水合。
    pushPrimaryTreeSuspenseHandler(workInProgress);

    // dev的报错警告。本次是第一次进来，不可能正在进行水合
    warnIfHydrating();
    //  fallback的水合，需要重试
    if (isSuspenseInstanceFallback(suspenseInstance)) {
      // This boundary is in a permanent fallback state. In this case, we'll never
      // get an update and we'll never be able to hydrate the final content. Let's just try the
      // client side render instead.
      let digest: ?string;
      let message;
      let stack = null;
      let componentStack = null;
      if (__DEV__) {
        ({ digest, message, stack, componentStack } =
          getSuspenseInstanceFallbackErrorDetails(suspenseInstance));
      } else {
        ({ digest } = getSuspenseInstanceFallbackErrorDetails(suspenseInstance));
      }

      // TODO: Figure out a better signal than encoding a magic digest value.
      if (!enablePostpone || digest !== 'POSTPONE') {
        let error: Error;
        if (__DEV__ && message) {
          // eslint-disable-next-line react-internal/prod-error-codes
          error = new Error(message);
        } else {
          error = new Error(
            'The server could not finish this Suspense boundary, likely ' +
            'due to an error during server rendering. ' +
            'Switched to client rendering.',
          );
        }
        // Replace the stack with the server stack
        error.stack = (__DEV__ && stack) || '';
        (error: any).digest = digest;
        const capturedValue = createCapturedValueFromError(
          error,
          componentStack === undefined ? null : componentStack,
        );
        queueHydrationError(capturedValue);
      }
      return retrySuspenseComponentWithoutHydrating(
        current,
        workInProgress,
        renderLanes,
      );
    }

    if (
      enableLazyContextPropagation &&
      // TODO: Factoring is a little weird, since we check this right below, too.
      // But don't want to re-arrange the if-else chain until/unless this
      // feature lands.
      !didReceiveUpdate
    ) {
      // We need to check if any children have context before we decide to bail
      // out, so propagate the changes now.
      lazilyPropagateParentContextChanges(current, workInProgress, renderLanes);
    }

    //  存在内容变更。比如用户点击了脱水内容。current的lanes跟当前lanes肯定不同。多了一个高优先级
    const hasContextChanged = includesSomeLane(renderLanes, current.childLanes);
    if (didReceiveUpdate || hasContextChanged) {
      //  存在内容变更
      const root = getWorkInProgressRoot();
      if (root !== null) {
         // 获取更高优先级的水合通道
        // 说明：getBumpedLaneForHydration 会检查renderLanes：
        // 1. 如果用户刚刚点击了组件，返回 InputContinuousHydrationLane（高优先级）
        // 3. 如果没有用户交互，则返回正常的 DefaultHydrationLane
        const attemptHydrationAtLane = getBumpedLaneForHydration( root, renderLanes,);
          // 检查是否找到了新的高优先级通道，且与之前的重试通道不同
          //  suspenseState.retryLane应该是OffscreenLane。上一次mount脱水内容时，设置的水合lanes
        if (
          attemptHydrationAtLane !== NoLane &&
          attemptHydrationAtLane !== suspenseState.retryLane
        ) {
          //  当前水合出现优先级提升的情况。
          suspenseState.retryLane = attemptHydrationAtLane;
          enqueueConcurrentRenderForLane(current, attemptHydrationAtLane);
          scheduleUpdateOnFiber(root, current, attemptHydrationAtLane);

           // 抛出SelectiveHydrationException异常
            // 1. 这不是错误，而是一种控制流机制
            // 2. React 捕获此异常后，会停止当前渲染
            // 3. 然后立即开始处理刚刚安排的高优先级渲染
          throw SelectiveHydrationException;
        } else {
        //  此时已经尝试使用了高优先级，仍然失败
        }
      }
      //  没有进行选择性的水合，也就是上面的else情况
      //  会继续渲染，但是不进行水合
      //  同时将这棵子树标记为"suspended"（暂停）状态
      
      //  此时发生在同步更新期间，hydration lanes已经暂停了
      //  同步更新期间，未来应该存在一个同步水合lanes
      if (isSuspenseInstancePending(suspenseInstance)) {
        // 当前处于pending状态，已经显示了fallback。不需要额外处理
      } else {
        // 标记当前suspense暂停
        renderDidSuspendDelayIfPossible();
      }
      //  删除当前子节点，放弃水合
      //  以
      return retrySuspenseComponentWithoutHydrating(
        current,
        workInProgress,
        renderLanes,
      );
    } else if (isSuspenseInstancePending(suspenseInstance)) {
      //  当前组件等待来自服务端数据，react的流式服务端渲染。
      //  1、服务器首先发送页面的初始 HTML，包括 Suspense 组件的占位符或 fallback 内容。
      //  这些 Suspense 组件被标记为 SUSPENSE_PENDING_START_DAT
      //  2.当服务器完成数据加载后，会通过同一个流继续发送额外的 HTML 片段这些片段包含 Suspense 组件的实际内容
      //  客户端接收到这些片段后，会替换对应的占位符
      //  所以此时不能对其进行hydration
      
      workInProgress.flags |= DidCapture;// 标记已捕获。应该显示fallback内容
      workInProgress.child = current.child;// 保留当前的脱水子节点
      // 注册回调函数，在服务器发送结果后重试此边界
      const retry = retryDehydratedSuspenseBoundary.bind(null, current);
      registerSuspenseInstanceRetry(suspenseInstance, retry);
      return null;//  不进行处理。因为pending
    } else {
      // 第一次尝试
      //  定义一些水合的前置内容。获取第一个可以水合的节点，初始化其它状态。表明isHydrating=true
      reenterHydrationStateFromDehydratedSuspenseInstance(
        workInProgress,
        suspenseInstance,
        suspenseState.treeContext,
      );
      //  加载主要内容并返回
      const primaryChildren = nextProps.children;
      const primaryChildFragment = mountSuspensePrimaryChildren(
        workInProgress,
        primaryChildren,
        renderLanes,
      );
      // 标记children为hydration。这是一个快速的方法来知道这棵树是否是补水树的一部分。
      // 这用于确定子节点是否已经完全挂载，以及调度事件重放。
      // 从概念上讲，这类似于在这里插入一个子树到React树中。它只是碰巧不需要修改DOM，因为它已经存在了。
      primaryChildFragment.flags |= Hydrating;
      return primaryChildFragment;
    }
  } else {
    // This is the second render pass. We already attempted to hydrated, but
    // something either suspended or errored.

    if (workInProgress.flags & ForceClientRender) {
      // Something errored during hydration. Try again without hydrating.
      // The error should've already been logged in throwException.
      pushPrimaryTreeSuspenseHandler(workInProgress);
      workInProgress.flags &= ~ForceClientRender;
      return retrySuspenseComponentWithoutHydrating(
        current,
        workInProgress,
        renderLanes,
      );
    } else if ((workInProgress.memoizedState: null | SuspenseState) !== null) {
      // Something suspended and we should still be in dehydrated mode.
      // Leave the existing child in place.

      // Push to avoid a mismatch
      pushFallbackTreeSuspenseHandler(workInProgress);

      workInProgress.child = current.child;
      // The dehydrated completion pass expects this flag to be there
      // but the normal suspense pass doesn't.
      workInProgress.flags |= DidCapture;
      return null;
    } else {
      // Suspended but we should no longer be in dehydrated mode.
      // Therefore we now have to render the fallback.
      pushFallbackTreeSuspenseHandler(workInProgress);

      const nextPrimaryChildren = nextProps.children;
      const nextFallbackChildren = nextProps.fallback;
      const fallbackChildFragment =
        mountSuspenseFallbackAfterRetryWithoutHydrating(
          current,
          workInProgress,
          nextPrimaryChildren,
          nextFallbackChildren,
          renderLanes,
        );
      const primaryChildFragment: Fiber = (workInProgress.child: any);
      primaryChildFragment.memoizedState =
        mountSuspenseOffscreenState(renderLanes);
      primaryChildFragment.childLanes = getRemainingWorkInPrimaryTree(
        current,
        didPrimaryChildrenDefer,
        renderLanes,
      );
      workInProgress.memoizedState = SUSPENDED_MARKER;
      return fallbackChildFragment;
    }
  }
}

function scheduleSuspenseWorkOnFiber(
  fiber: Fiber,
  renderLanes: Lanes,
  propagationRoot: Fiber,
) {
  fiber.lanes = mergeLanes(fiber.lanes, renderLanes);
  const alternate = fiber.alternate;
  if (alternate !== null) {
    alternate.lanes = mergeLanes(alternate.lanes, renderLanes);
  }
  scheduleContextWorkOnParentPath(fiber.return, renderLanes, propagationRoot);
}

function propagateSuspenseContextChange(
  workInProgress: Fiber,
  firstChild: null | Fiber,
  renderLanes: Lanes,
): void {
  // Mark any Suspense boundaries with fallbacks as having work to do.
  // If they were previously forced into fallbacks, they may now be able
  // to unblock.
  let node = firstChild;
  while (node !== null) {
    if (node.tag === SuspenseComponent) {
      const state: SuspenseState | null = node.memoizedState;
      if (state !== null) {
        scheduleSuspenseWorkOnFiber(node, renderLanes, workInProgress);
      }
    } else if (node.tag === SuspenseListComponent) {
      // If the tail is hidden there might not be an Suspense boundaries
      // to schedule work on. In this case we have to schedule it on the
      // list itself.
      // We don't have to traverse to the children of the list since
      // the list will propagate the change when it rerenders.
      scheduleSuspenseWorkOnFiber(node, renderLanes, workInProgress);
    } else if (node.child !== null) {
      node.child.return = node;
      node = node.child;
      continue;
    }
    if (node === workInProgress) {
      return;
    }
    // $FlowFixMe[incompatible-use] found when upgrading Flow
    while (node.sibling === null) {
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      if (node.return === null || node.return === workInProgress) {
        return;
      }
      node = node.return;
    }
    // $FlowFixMe[incompatible-use] found when upgrading Flow
    node.sibling.return = node.return;
    node = node.sibling;
  }
}

function findLastContentRow(firstChild: null | Fiber): null | Fiber {
  // This is going to find the last row among these children that is already
  // showing content on the screen, as opposed to being in fallback state or
  // new. If a row has multiple Suspense boundaries, any of them being in the
  // fallback state, counts as the whole row being in a fallback state.
  // Note that the "rows" will be workInProgress, but any nested children
  // will still be current since we haven't rendered them yet. The mounted
  // order may not be the same as the new order. We use the new order.
  let row = firstChild;
  let lastContentRow: null | Fiber = null;
  while (row !== null) {
    const currentRow = row.alternate;
    // New rows can't be content rows.
    if (currentRow !== null && findFirstSuspended(currentRow) === null) {
      lastContentRow = row;
    }
    row = row.sibling;
  }
  return lastContentRow;
}

type SuspenseListRevealOrder = 'forwards' | 'backwards' | 'together' | void;

function validateRevealOrder(revealOrder: SuspenseListRevealOrder) {
  if (__DEV__) {
    if (
      revealOrder !== undefined &&
      revealOrder !== 'forwards' &&
      revealOrder !== 'backwards' &&
      revealOrder !== 'together' &&
      !didWarnAboutRevealOrder[revealOrder]
    ) {
      didWarnAboutRevealOrder[revealOrder] = true;
      if (typeof revealOrder === 'string') {
        switch (revealOrder.toLowerCase()) {
          case 'together':
          case 'forwards':
          case 'backwards': {
            console.error(
              '"%s" is not a valid value for revealOrder on <SuspenseList />. ' +
              'Use lowercase "%s" instead.',
              revealOrder,
              revealOrder.toLowerCase(),
            );
            break;
          }
          case 'forward':
          case 'backward': {
            console.error(
              '"%s" is not a valid value for revealOrder on <SuspenseList />. ' +
              'React uses the -s suffix in the spelling. Use "%ss" instead.',
              revealOrder,
              revealOrder.toLowerCase(),
            );
            break;
          }
          default:
            console.error(
              '"%s" is not a supported revealOrder on <SuspenseList />. ' +
              'Did you mean "together", "forwards" or "backwards"?',
              revealOrder,
            );
            break;
        }
      } else {
        console.error(
          '%s is not a supported value for revealOrder on <SuspenseList />. ' +
          'Did you mean "together", "forwards" or "backwards"?',
          revealOrder,
        );
      }
    }
  }
}

function validateTailOptions(
  tailMode: SuspenseListTailMode,
  revealOrder: SuspenseListRevealOrder,
) {
  if (__DEV__) {
    if (tailMode !== undefined && !didWarnAboutTailOptions[tailMode]) {
      if (tailMode !== 'collapsed' && tailMode !== 'hidden') {
        didWarnAboutTailOptions[tailMode] = true;
        console.error(
          '"%s" is not a supported value for tail on <SuspenseList />. ' +
          'Did you mean "collapsed" or "hidden"?',
          tailMode,
        );
      } else if (revealOrder !== 'forwards' && revealOrder !== 'backwards') {
        didWarnAboutTailOptions[tailMode] = true;
        console.error(
          '<SuspenseList tail="%s" /> is only valid if revealOrder is ' +
          '"forwards" or "backwards". ' +
          'Did you mean to specify revealOrder="forwards"?',
          tailMode,
        );
      }
    }
  }
}

function validateSuspenseListNestedChild(childSlot: mixed, index: number) {
  if (__DEV__) {
    const isAnArray = isArray(childSlot);
    const isIterable =
      !isAnArray && typeof getIteratorFn(childSlot) === 'function';
    if (isAnArray || isIterable) {
      const type = isAnArray ? 'array' : 'iterable';
      console.error(
        'A nested %s was passed to row #%s in <SuspenseList />. Wrap it in ' +
        'an additional SuspenseList to configure its revealOrder: ' +
        '<SuspenseList revealOrder=...> ... ' +
        '<SuspenseList revealOrder=...>{%s}</SuspenseList> ... ' +
        '</SuspenseList>',
        type,
        index,
        type,
      );
      return false;
    }
  }
  return true;
}

function validateSuspenseListChildren(
  children: mixed,
  revealOrder: SuspenseListRevealOrder,
) {
  if (__DEV__) {
    if (
      (revealOrder === 'forwards' || revealOrder === 'backwards') &&
      children !== undefined &&
      children !== null &&
      children !== false
    ) {
      if (isArray(children)) {
        for (let i = 0; i < children.length; i++) {
          if (!validateSuspenseListNestedChild(children[i], i)) {
            return;
          }
        }
      } else {
        const iteratorFn = getIteratorFn(children);
        if (typeof iteratorFn === 'function') {
          const childrenIterator = iteratorFn.call(children);
          if (childrenIterator) {
            let step = childrenIterator.next();
            let i = 0;
            for (; !step.done; step = childrenIterator.next()) {
              if (!validateSuspenseListNestedChild(step.value, i)) {
                return;
              }
              i++;
            }
          }
        } else {
          console.error(
            'A single row was passed to a <SuspenseList revealOrder="%s" />. ' +
            'This is not useful since it needs multiple rows. ' +
            'Did you mean to pass multiple children or an array?',
            revealOrder,
          );
        }
      }
    }
  }
}

function initSuspenseListRenderState(
  workInProgress: Fiber,
  isBackwards: boolean,
  tail: null | Fiber,
  lastContentRow: null | Fiber,
  tailMode: SuspenseListTailMode,
): void {
  const renderState: null | SuspenseListRenderState =
    workInProgress.memoizedState;
  if (renderState === null) {
    workInProgress.memoizedState = ({
      isBackwards: isBackwards,
      rendering: null,
      renderingStartTime: 0,
      last: lastContentRow,
      tail: tail,
      tailMode: tailMode,
    }: SuspenseListRenderState);
  } else {
    // We can reuse the existing object from previous renders.
    renderState.isBackwards = isBackwards;
    renderState.rendering = null;
    renderState.renderingStartTime = 0;
    renderState.last = lastContentRow;
    renderState.tail = tail;
    renderState.tailMode = tailMode;
  }
}

// This can end up rendering this component multiple passes.
// The first pass splits the children fibers into two sets. A head and tail.
// We first render the head. If anything is in fallback state, we do another
// pass through beginWork to rerender all children (including the tail) with
// the force suspend context. If the first render didn't have anything in
// in fallback state. Then we render each row in the tail one-by-one.
// That happens in the completeWork phase without going back to beginWork.
function updateSuspenseListComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  const nextProps = workInProgress.pendingProps;
  const revealOrder: SuspenseListRevealOrder = nextProps.revealOrder;
  const tailMode: SuspenseListTailMode = nextProps.tail;
  const newChildren = nextProps.children;

  validateRevealOrder(revealOrder);
  validateTailOptions(tailMode, revealOrder);
  validateSuspenseListChildren(newChildren, revealOrder);

  reconcileChildren(current, workInProgress, newChildren, renderLanes);

  let suspenseContext: SuspenseContext = suspenseStackCursor.current;

  const shouldForceFallback = hasSuspenseListContext(
    suspenseContext,
    (ForceSuspenseFallback: SuspenseContext),
  );
  if (shouldForceFallback) {
    suspenseContext = setShallowSuspenseListContext(
      suspenseContext,
      ForceSuspenseFallback,
    );
    workInProgress.flags |= DidCapture;
  } else {
    const didSuspendBefore =
      current !== null && (current.flags & DidCapture) !== NoFlags;
    if (didSuspendBefore) {
      // If we previously forced a fallback, we need to schedule work
      // on any nested boundaries to let them know to try to render
      // again. This is the same as context updating.
      propagateSuspenseContextChange(
        workInProgress,
        workInProgress.child,
        renderLanes,
      );
    }
    suspenseContext = setDefaultShallowSuspenseListContext(suspenseContext);
  }
  pushSuspenseListContext(workInProgress, suspenseContext);

  if (!disableLegacyMode && (workInProgress.mode & ConcurrentMode) === NoMode) {
    // In legacy mode, SuspenseList doesn't work so we just
    // use make it a noop by treating it as the default revealOrder.
    workInProgress.memoizedState = null;
  } else {
    switch (revealOrder) {
      case 'forwards': {
        const lastContentRow = findLastContentRow(workInProgress.child);
        let tail;
        if (lastContentRow === null) {
          // The whole list is part of the tail.
          // TODO: We could fast path by just rendering the tail now.
          tail = workInProgress.child;
          workInProgress.child = null;
        } else {
          // Disconnect the tail rows after the content row.
          // We're going to render them separately later.
          tail = lastContentRow.sibling;
          lastContentRow.sibling = null;
        }
        initSuspenseListRenderState(
          workInProgress,
          false, // isBackwards
          tail,
          lastContentRow,
          tailMode,
        );
        break;
      }
      case 'backwards': {
        // We're going to find the first row that has existing content.
        // At the same time we're going to reverse the list of everything
        // we pass in the meantime. That's going to be our tail in reverse
        // order.
        let tail = null;
        let row = workInProgress.child;
        workInProgress.child = null;
        while (row !== null) {
          const currentRow = row.alternate;
          // New rows can't be content rows.
          if (currentRow !== null && findFirstSuspended(currentRow) === null) {
            // This is the beginning of the main content.
            workInProgress.child = row;
            break;
          }
          const nextRow = row.sibling;
          row.sibling = tail;
          tail = row;
          row = nextRow;
        }
        // TODO: If workInProgress.child is null, we can continue on the tail immediately.
        initSuspenseListRenderState(
          workInProgress,
          true, // isBackwards
          tail,
          null, // last
          tailMode,
        );
        break;
      }
      case 'together': {
        initSuspenseListRenderState(
          workInProgress,
          false, // isBackwards
          null, // tail
          null, // last
          undefined,
        );
        break;
      }
      default: {
        // The default reveal order is the same as not having
        // a boundary.
        workInProgress.memoizedState = null;
      }
    }
  }
  return workInProgress.child;
}

function updatePortalComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  pushHostContainer(workInProgress, workInProgress.stateNode.containerInfo);
  const nextChildren = workInProgress.pendingProps;
  if (current === null) {
    // Portals are special because we don't append the children during mount
    // but at commit. Therefore we need to track insertions which the normal
    // flow doesn't do during mount. This doesn't happen at the root because
    // the root always starts with a "current" with a null child.
    // TODO: Consider unifying this with how the root works.
    workInProgress.child = reconcileChildFibers(
      workInProgress,
      null,
      nextChildren,
      renderLanes,
    );
  } else {
    reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  }
  return workInProgress.child;
}

let hasWarnedAboutUsingNoValuePropOnContextProvider = false;

function updateContextProvider(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  let context: ReactContext<any>;
  if (enableRenderableContext) {
    context = workInProgress.type;
  } else {
    context = workInProgress.type._context;
  }
  const newProps = workInProgress.pendingProps;
  const oldProps = workInProgress.memoizedProps;

  const newValue = newProps.value;

  if (__DEV__) {
    if (!('value' in newProps)) {
      if (!hasWarnedAboutUsingNoValuePropOnContextProvider) {
        hasWarnedAboutUsingNoValuePropOnContextProvider = true;
        console.error(
          'The `value` prop is required for the `<Context.Provider>`. Did you misspell it or forget to pass it?',
        );
      }
    }
  }

  pushProvider(workInProgress, context, newValue);

  if (enableLazyContextPropagation) {
    // In the lazy propagation implementation, we don't scan for matching
    // consumers until something bails out, because until something bails out
    // we're going to visit those nodes, anyway. The trade-off is that it shifts
    // responsibility to the consumer to track whether something has changed.
  } else {
    if (oldProps !== null) {
      const oldValue = oldProps.value;
      if (is(oldValue, newValue)) {
        // No change. Bailout early if children are the same.
        if (
          oldProps.children === newProps.children &&
          !hasLegacyContextChanged()
        ) {
          return bailoutOnAlreadyFinishedWork(
            current,
            workInProgress,
            renderLanes,
          );
        }
      } else {
        // The context value changed. Search for matching consumers and schedule
        // them to update.
        propagateContextChange(workInProgress, context, renderLanes);
      }
    }
  }

  const newChildren = newProps.children;
  reconcileChildren(current, workInProgress, newChildren, renderLanes);
  return workInProgress.child;
}

function updateContextConsumer(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  let context: ReactContext<any>;
  if (enableRenderableContext) {
    const consumerType: ReactConsumerType<any> = workInProgress.type;
    context = consumerType._context;
  } else {
    context = workInProgress.type;
    if (__DEV__) {
      if ((context: any)._context !== undefined) {
        context = (context: any)._context;
      }
    }
  }
  const newProps = workInProgress.pendingProps;
  const render = newProps.children;

  if (__DEV__) {
    if (typeof render !== 'function') {
      console.error(
        'A context consumer was rendered with multiple children, or a child ' +
        "that isn't a function. A context consumer expects a single child " +
        'that is a function. If you did pass a function, make sure there ' +
        'is no trailing or leading whitespace around it.',
      );
    }
  }

  prepareToReadContext(workInProgress, renderLanes);
  const newValue = readContext(context);
  if (enableSchedulingProfiler) {
    markComponentRenderStarted(workInProgress);
  }
  let newChildren;
  if (__DEV__) {
    newChildren = callComponentInDEV(render, newValue, undefined);
  } else {
    newChildren = render(newValue);
  }
  if (enableSchedulingProfiler) {
    markComponentRenderStopped();
  }

  // React DevTools reads this flag.
  workInProgress.flags |= PerformedWork;
  reconcileChildren(current, workInProgress, newChildren, renderLanes);
  return workInProgress.child;
}

function updateScopeComponent(
  current: null | Fiber,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  const nextProps = workInProgress.pendingProps;
  const nextChildren = nextProps.children;
  markRef(current, workInProgress);
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}

export function markWorkInProgressReceivedUpdate() {
  didReceiveUpdate = true;
}

export function checkIfWorkInProgressReceivedUpdate(): boolean {
  return didReceiveUpdate;
}

function resetSuspendedCurrentOnMountInLegacyMode(
  current: null | Fiber,
  workInProgress: Fiber,
) {
  if (!disableLegacyMode && (workInProgress.mode & ConcurrentMode) === NoMode) {
    if (current !== null) {
      // A lazy component only mounts if it suspended inside a non-
      // concurrent tree, in an inconsistent state. We want to treat it like
      // a new mount, even though an empty version of it already committed.
      // Disconnect the alternate pointers.
      current.alternate = null;
      workInProgress.alternate = null;
      // Since this is conceptually a new fiber, schedule a Placement effect
      workInProgress.flags |= Placement;
    }
  }
}

function bailoutOnAlreadyFinishedWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  if (current !== null) {
    // Reuse previous dependencies
    workInProgress.dependencies = current.dependencies;
  }

  if (enableProfilerTimer) {
    // Don't update "base" render times for bailouts.
    stopProfilerTimerIfRunning(workInProgress);
  }

  markSkippedUpdateLanes(workInProgress.lanes);

  // Check if the children have any pending work.
  if (!includesSomeLane(renderLanes, workInProgress.childLanes)) {
    // The children don't have any work either. We can skip them.
    // TODO: Once we add back resuming, we should check if the children are
    // a work-in-progress set. If so, we need to transfer their effects.

    if (enableLazyContextPropagation && current !== null) {
      // Before bailing out, check if there are any context changes in
      // the children.
      lazilyPropagateParentContextChanges(current, workInProgress, renderLanes);
      if (!includesSomeLane(renderLanes, workInProgress.childLanes)) {
        return null;
      }
    } else {
      return null;
    }
  }

  // This fiber doesn't have work, but its subtree does. Clone the child
  // fibers and continue.
  cloneChildFibers(current, workInProgress);
  return workInProgress.child;
}

function remountFiber(
  current: Fiber,
  oldWorkInProgress: Fiber,
  newWorkInProgress: Fiber,
): Fiber | null {
  if (__DEV__) {
    const returnFiber = oldWorkInProgress.return;
    if (returnFiber === null) {
      // eslint-disable-next-line react-internal/prod-error-codes
      throw new Error('Cannot swap the root fiber.');
    }

    // Disconnect from the old current.
    // It will get deleted.
    current.alternate = null;
    oldWorkInProgress.alternate = null;

    // Connect to the new tree.
    newWorkInProgress.index = oldWorkInProgress.index;
    newWorkInProgress.sibling = oldWorkInProgress.sibling;
    newWorkInProgress.return = oldWorkInProgress.return;
    newWorkInProgress.ref = oldWorkInProgress.ref;

    if (__DEV__) {
      newWorkInProgress._debugInfo = oldWorkInProgress._debugInfo;
    }

    // Replace the child/sibling pointers above it.
    if (oldWorkInProgress === returnFiber.child) {
      returnFiber.child = newWorkInProgress;
    } else {
      let prevSibling = returnFiber.child;
      if (prevSibling === null) {
        // eslint-disable-next-line react-internal/prod-error-codes
        throw new Error('Expected parent to have a child.');
      }
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      while (prevSibling.sibling !== oldWorkInProgress) {
        // $FlowFixMe[incompatible-use] found when upgrading Flow
        prevSibling = prevSibling.sibling;
        if (prevSibling === null) {
          // eslint-disable-next-line react-internal/prod-error-codes
          throw new Error('Expected to find the previous sibling.');
        }
      }
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      prevSibling.sibling = newWorkInProgress;
    }

    // Delete the old fiber and place the new one.
    // Since the old fiber is disconnected, we have to schedule it manually.
    const deletions = returnFiber.deletions;
    if (deletions === null) {
      returnFiber.deletions = [current];
      returnFiber.flags |= ChildDeletion;
    } else {
      deletions.push(current);
    }

    newWorkInProgress.flags |= Placement;

    // Restart work from the new fiber.
    return newWorkInProgress;
  } else {
    throw new Error(
      'Did not expect this call in production. ' +
      'This is a bug in React. Please file an issue.',
    );
  }
}

function checkScheduledUpdateOrContext( current: Fiber, renderLanes: Lanes): boolean {
   // 检查是否有待处理的更新通道
  const updateLanes = current.lanes;
  if (includesSomeLane(updateLanes, renderLanes)) {
    return true;
  }
  // 即使不在更新通道，但是要检查context的变更
  if (enableLazyContextPropagation) {//react18 默认开启。
    const dependencies = current.dependencies;
    if (dependencies !== null && checkIfContextChanged(dependencies)) {
      return true;
    }
  }
  return false;
}

function attemptEarlyBailoutIfNoScheduledUpdate(
  current: Fiber,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  //  当前组件会直接退出，但是还要做一些必要操作。
  //  维护 Fiber 树内部一致性的必要操作，即使跳过主要更新逻辑，这些操作仍必须执行
  switch (workInProgress.tag) {
    case HostRoot:
      pushHostRootContext(workInProgress);
      const root: FiberRoot = workInProgress.stateNode;
      pushRootTransition(workInProgress, root, renderLanes);

      if (enableTransitionTracing) {
        pushRootMarkerInstance(workInProgress);
      }

      if (enableCache) {
        const cache: Cache = current.memoizedState.cache;
        pushCacheProvider(workInProgress, cache);
      }
      resetHydrationState();
      break;
    case HostSingleton:
    case HostComponent:
      pushHostContext(workInProgress);
      break;
    case ClassComponent: {
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        pushLegacyContextProvider(workInProgress);
      }
      break;
    }
    case HostPortal:
      pushHostContainer(workInProgress, workInProgress.stateNode.containerInfo);
      break;
    case ContextProvider: {
      const newValue = workInProgress.memoizedProps.value;
      let context: ReactContext<any>;
      if (enableRenderableContext) {
        context = workInProgress.type;
      } else {
        context = workInProgress.type._context;
      }
      pushProvider(workInProgress, context, newValue);
      break;
    }
    case Profiler:
      if (enableProfilerTimer) {
        // Profiler should only call onRender when one of its descendants actually rendered.
        const hasChildWork = includesSomeLane(
          renderLanes,
          workInProgress.childLanes,
        );
        if (hasChildWork) {
          workInProgress.flags |= Update;
        }

        if (enableProfilerCommitHooks) {
          // Schedule a passive effect for this Profiler to call onPostCommit hooks.
          // This effect should be scheduled even if there is no onPostCommit callback for this Profiler,
          // because the effect is also where times bubble to parent Profilers.
          workInProgress.flags |= Passive;
          // Reset effect durations for the next eventual effect phase.
          // These are reset during render to allow the DevTools commit hook a chance to read them,
          const stateNode = workInProgress.stateNode;
          stateNode.effectDuration = -0;
          stateNode.passiveEffectDuration = -0;
        }
      }
      break;
    case SuspenseComponent: {
      const state: SuspenseState | null = workInProgress.memoizedState;
      if (state !== null) {
        if (state.dehydrated !== null) {
          // We're not going to render the children, so this is just to maintain
          // push/pop symmetry
          pushPrimaryTreeSuspenseHandler(workInProgress);
          // We know that this component will suspend again because if it has
          // been unsuspended it has committed as a resolved Suspense component.
          // If it needs to be retried, it should have work scheduled on it.
          workInProgress.flags |= DidCapture;
          // We should never render the children of a dehydrated boundary until we
          // upgrade it. We return null instead of bailoutOnAlreadyFinishedWork.
          return null;
        }

        // If this boundary is currently timed out, we need to decide
        // whether to retry the primary children, or to skip over it and
        // go straight to the fallback. Check the priority of the primary
        // child fragment.
        const primaryChildFragment: Fiber = (workInProgress.child: any);
        const primaryChildLanes = primaryChildFragment.childLanes;
        if (includesSomeLane(renderLanes, primaryChildLanes)) {
          // The primary children have pending work. Use the normal path
          // to attempt to render the primary children again.
          return updateSuspenseComponent(current, workInProgress, renderLanes);
        } else {
          // The primary child fragment does not have pending work marked
          // on it
          pushPrimaryTreeSuspenseHandler(workInProgress);
          // The primary children do not have pending work with sufficient
          // priority. Bailout.
          const child = bailoutOnAlreadyFinishedWork(
            current,
            workInProgress,
            renderLanes,
          );
          if (child !== null) {
            // The fallback children have pending work. Skip over the
            // primary children and work on the fallback.
            return child.sibling;
          } else {
            // Note: We can return `null` here because we already checked
            // whether there were nested context consumers, via the call to
            // `bailoutOnAlreadyFinishedWork` above.
            return null;
          }
        }
      } else {
        pushPrimaryTreeSuspenseHandler(workInProgress);
      }
      break;
    }
    case SuspenseListComponent: {
      const didSuspendBefore = (current.flags & DidCapture) !== NoFlags;

      let hasChildWork = includesSomeLane(
        renderLanes,
        workInProgress.childLanes,
      );

      if (enableLazyContextPropagation && !hasChildWork) {
        // Context changes may not have been propagated yet. We need to do
        // that now, before we can decide whether to bail out.
        // TODO: We use `childLanes` as a heuristic for whether there is
        // remaining work in a few places, including
        // `bailoutOnAlreadyFinishedWork` and
        // `updateDehydratedSuspenseComponent`. We should maybe extract this
        // into a dedicated function.
        lazilyPropagateParentContextChanges(
          current,
          workInProgress,
          renderLanes,
        );
        hasChildWork = includesSomeLane(renderLanes, workInProgress.childLanes);
      }

      if (didSuspendBefore) {
        if (hasChildWork) {
          // If something was in fallback state last time, and we have all the
          // same children then we're still in progressive loading state.
          // Something might get unblocked by state updates or retries in the
          // tree which will affect the tail. So we need to use the normal
          // path to compute the correct tail.
          return updateSuspenseListComponent(
            current,
            workInProgress,
            renderLanes,
          );
        }
        // If none of the children had any work, that means that none of
        // them got retried so they'll still be blocked in the same way
        // as before. We can fast bail out.
        workInProgress.flags |= DidCapture;
      }

      // If nothing suspended before and we're rendering the same children,
      // then the tail doesn't matter. Anything new that suspends will work
      // in the "together" mode, so we can continue from the state we had.
      const renderState = workInProgress.memoizedState;
      if (renderState !== null) {
        // Reset to the "together" mode in case we've started a different
        // update in the past but didn't complete it.
        renderState.rendering = null;
        renderState.tail = null;
        renderState.lastEffect = null;
      }
      pushSuspenseListContext(workInProgress, suspenseStackCursor.current);

      if (hasChildWork) {
        break;
      } else {
        // If none of the children had any work, that means that none of
        // them got retried so they'll still be blocked in the same way
        // as before. We can fast bail out.
        return null;
      }
    }
    case OffscreenComponent:
    case LegacyHiddenComponent: {
      // Need to check if the tree still needs to be deferred. This is
      // almost identical to the logic used in the normal update path,
      // so we'll just enter that. The only difference is we'll bail out
      // at the next level instead of this one, because the child props
      // have not changed. Which is fine.
      // TODO: Probably should refactor `beginWork` to split the bailout
      // path from the normal path. I'm tempted to do a labeled break here
      // but I won't :)
      workInProgress.lanes = NoLanes;
      return updateOffscreenComponent(current, workInProgress, renderLanes);
    }
    case CacheComponent: {
      if (enableCache) {
        const cache: Cache = current.memoizedState.cache;
        pushCacheProvider(workInProgress, cache);
      }
      break;
    }
    case TracingMarkerComponent: {
      if (enableTransitionTracing) {
        const instance: TracingMarkerInstance | null = workInProgress.stateNode;
        if (instance !== null) {
          pushMarkerInstance(workInProgress, instance);
        }
      }
    }
  }
  return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
}

function beginWork(
  current: Fiber | null,//  当前组件对应的在上一次更新时的Fiber节点
  workInProgress: Fiber,//  当前组件本次的Fiber节点
  renderLanes: Lanes,
): Fiber | null {
  if (current !== null) {// 更新节点
    const oldProps = current.memoizedProps;// 获取当前节点的记忆化props（上次渲染的最终props）
    const newProps = workInProgress.pendingProps;// 获取工作进度节点的待处理props（本次更新的props）
    //  1.判断props或旧版上下文是否发生变化
    //  2.hasLegacyContextChanged:判断旧版Context更新context，触发下级组件重新渲染
    //    此时didPerformWorkStackCursor.current会被设置为true
    if ( oldProps !== newProps ||  hasLegacyContextChanged()) {
      didReceiveUpdate = true;// 如果变化，标记该Fiber节点需要更新
    } else {
      // 通过比对Fiber节点待处理的更新通道（lanes）与本次渲染任务的优先级通道（renderLanes），
      // 判断该节点是否存在需要在此次渲染批次中处理的更新
      const hasScheduledUpdateOrContext = checkScheduledUpdateOrContext(current,renderLanes);

      // 不存在更新,且当前组件没有错误边界。【当组件报错被捕获时会向上查找错误边界，标记为DidCapture】
      if ( !hasScheduledUpdateOrContext &&  (workInProgress.flags & DidCapture) === NoFlags ) {
        didReceiveUpdate = false;// 标记不需要更新
        //  提前退出
        return attemptEarlyBailoutIfNoScheduledUpdate(
          current,
          workInProgress,
          renderLanes,
        );
      }
      if ((current.flags & ForceUpdateForLegacySuspense) !== NoFlags) {
        // This is a special case that only exists for legacy mode.
        // See https://github.com/facebook/react/pull/19216.
        // 处理Legacy Suspense的强制更新情况
        didReceiveUpdate = true;
      } else {
        // 如果没有新props或旧版上下文变化，且没有强制更新，标记不需要更新
        didReceiveUpdate = false;
      }
    }
  } else {// 如果current为null，表示这是一个挂载节点
    didReceiveUpdate = false;// 初次挂载时，默认不需要更新

    if (getIsHydrating() && isForkedChild(workInProgress)) {
      // 如果正在进行hydration，并且是forked子节点
      // 处理多子节点的ID生成（用于并行渲染）
      const slotIndex = workInProgress.index;// 获取当前节点在父节点中的索引
      const numberOfForks = getForksAtLevel(workInProgress);// 获取当前层级的fork数量
      pushTreeId(workInProgress, numberOfForks, slotIndex);// 生成并推送树ID
    }
  }

  // 在进入begin阶段之前，清除待处理的更新优先级.
  //  在此之前确定了didReceiveUpdate的情况
  workInProgress.lanes = NoLanes;// 清除当前工作节点的优先级标记
 // 根据工作进度节点的标签，分派到不同的组件类型处理逻辑
  switch (workInProgress.tag) {
    case LazyComponent: {
      const elementType = workInProgress.elementType;
      return mountLazyComponent(
        current,
        workInProgress,
        elementType,
        renderLanes,
      );
    }
    case FunctionComponent: {
      const Component = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      const resolvedProps =
        disableDefaultPropsExceptForClasses ||
          workInProgress.elementType === Component
          ? unresolvedProps
          : resolveDefaultPropsOnNonClassComponent(Component, unresolvedProps);
      return updateFunctionComponent(
        current,
        workInProgress,
        Component,
        resolvedProps,
        renderLanes,
      );
    }
    case ClassComponent: {
      const Component = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      const resolvedProps = resolveClassComponentProps(
        Component,
        unresolvedProps,
        workInProgress.elementType === Component,
      );
      return updateClassComponent(
        current,
        workInProgress,
        Component,
        resolvedProps,
        renderLanes,
      );
    }
    case HostRoot:
      return updateHostRoot(current, workInProgress, renderLanes);
    case HostHoistable:
      if (supportsResources) {
        return updateHostHoistable(current, workInProgress, renderLanes);
      }
    // Fall through
    case HostSingleton:
      if (supportsSingletons) {
        return updateHostSingleton(current, workInProgress, renderLanes);
      }
    // Fall through
    case HostComponent:
      return updateHostComponent(current, workInProgress, renderLanes);
    case HostText:
      return updateHostText(current, workInProgress);
    case SuspenseComponent:
      return updateSuspenseComponent(current, workInProgress, renderLanes);
    case HostPortal:
      return updatePortalComponent(current, workInProgress, renderLanes);
    case ForwardRef: {
      const type = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      const resolvedProps =
        disableDefaultPropsExceptForClasses ||
          workInProgress.elementType === type
          ? unresolvedProps
          : resolveDefaultPropsOnNonClassComponent(type, unresolvedProps);
      return updateForwardRef(
        current,
        workInProgress,
        type,
        resolvedProps,
        renderLanes,
      );
    }
    case Fragment:
      return updateFragment(current, workInProgress, renderLanes);
    case Mode:
      return updateMode(current, workInProgress, renderLanes);
    case Profiler:
      return updateProfiler(current, workInProgress, renderLanes);
    case ContextProvider:
      return updateContextProvider(current, workInProgress, renderLanes);
    case ContextConsumer:
      return updateContextConsumer(current, workInProgress, renderLanes);
    case MemoComponent: {
      const type = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      // Resolve outer props first, then resolve inner props.
      let resolvedProps = disableDefaultPropsExceptForClasses
        ? unresolvedProps
        : resolveDefaultPropsOnNonClassComponent(type, unresolvedProps);
      resolvedProps = disableDefaultPropsExceptForClasses
        ? resolvedProps
        : resolveDefaultPropsOnNonClassComponent(type.type, resolvedProps);
      return updateMemoComponent(
        current,
        workInProgress,
        type,
        resolvedProps,
        renderLanes,
      );
    }
    case SimpleMemoComponent: {
      return updateSimpleMemoComponent(
        current,
        workInProgress,
        workInProgress.type,
        workInProgress.pendingProps,
        renderLanes,
      );
    }
    case IncompleteClassComponent: {
      if (disableLegacyMode) {
        break;
      }
      const Component = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      const resolvedProps = resolveClassComponentProps(
        Component,
        unresolvedProps,
        workInProgress.elementType === Component,
      );
      return mountIncompleteClassComponent(
        current,
        workInProgress,
        Component,
        resolvedProps,
        renderLanes,
      );
    }
    case IncompleteFunctionComponent: {
      if (disableLegacyMode) {
        break;
      }
      const Component = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      const resolvedProps = resolveClassComponentProps(
        Component,
        unresolvedProps,
        workInProgress.elementType === Component,
      );
      return mountIncompleteFunctionComponent(
        current,
        workInProgress,
        Component,
        resolvedProps,
        renderLanes,
      );
    }
    case SuspenseListComponent: {
      return updateSuspenseListComponent(current, workInProgress, renderLanes);
    }
    case ScopeComponent: {
      if (enableScopeAPI) {
        return updateScopeComponent(current, workInProgress, renderLanes);
      }
      break;
    }
    case OffscreenComponent: {
      return updateOffscreenComponent(current, workInProgress, renderLanes);
    }
    case LegacyHiddenComponent: {
      if (enableLegacyHidden) {
        return updateLegacyHiddenComponent(
          current,
          workInProgress,
          renderLanes,
        );
      }
      break;
    }
    case CacheComponent: {
      if (enableCache) {
        return updateCacheComponent(current, workInProgress, renderLanes);
      }
      break;
    }
    case TracingMarkerComponent: {
      if (enableTransitionTracing) {
        return updateTracingMarkerComponent(
          current,
          workInProgress,
          renderLanes,
        );
      }
      break;
    }
    case Throw: {
      // This represents a Component that threw in the reconciliation phase.
      // So we'll rethrow here. This might be a Thenable.
      throw workInProgress.pendingProps;
    }
  }

  throw new Error(
    `Unknown unit of work tag (${workInProgress.tag}). This error is likely caused by a bug in ` +
    'React. Please file an issue.',
  );
}

export { beginWork };
