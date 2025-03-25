/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber, FiberRoot} from './ReactInternalTypes';
import type {RootState} from './ReactFiberRoot';
import type {Lanes, Lane} from './ReactFiberLane';
import type {ReactScopeInstance, ReactContext} from 'shared/ReactTypes';
import type {
  Instance,
  Type,
  Props,
  Container,
  ChildSet,
  Resource,
} from './ReactFiberConfig';
import type {
  SuspenseState,
  SuspenseListRenderState,
  RetryQueue,
} from './ReactFiberSuspenseComponent';
import type {
  OffscreenState,
  OffscreenQueue,
} from './ReactFiberActivityComponent';
import {isOffscreenManual} from './ReactFiberActivityComponent';
import type {TracingMarkerInstance} from './ReactFiberTracingMarkerComponent';
import type {Cache} from './ReactFiberCacheComponent';
import {
  enableLegacyHidden,
  enableSuspenseCallback,
  enableScopeAPI,
  enablePersistedModeClonedFlag,
  enableProfilerTimer,
  enableCache,
  enableTransitionTracing,
  enableRenderableContext,
  passChildrenWhenCloningPersistedNodes,
  disableLegacyMode,
} from 'shared/ReactFeatureFlags';

import {now} from './Scheduler';

import {
  FunctionComponent,
  ClassComponent,
  HostRoot,
  HostComponent,
  HostHoistable,
  HostSingleton,
  HostText,
  HostPortal,
  ContextProvider,
  ContextConsumer,
  ForwardRef,
  Fragment,
  Mode,
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
import {NoMode, ConcurrentMode, ProfileMode} from './ReactTypeOfMode';
import {
  Placement,
  Update,
  Visibility,
  NoFlags,
  DidCapture,
  Snapshot,
  ChildDeletion,
  StaticMask,
  MutationMask,
  Passive,
  ForceClientRender,
  MaySuspendCommit,
  ScheduleRetry,
  ShouldSuspendCommit,
  Cloned,
} from './ReactFiberFlags';

import {
  createInstance,
  createTextInstance,
  resolveSingletonInstance,
  appendInitialChild,
  finalizeInitialChildren,
  supportsMutation,
  supportsPersistence,
  supportsResources,
  supportsSingletons,
  cloneInstance,
  cloneHiddenInstance,
  cloneHiddenTextInstance,
  createContainerChildSet,
  appendChildToContainerChildSet,
  finalizeContainerChildren,
  preparePortalMount,
  prepareScopeUpdate,
  maySuspendCommit,
  mayResourceSuspendCommit,
  preloadInstance,
  preloadResource,
} from './ReactFiberConfig';
import {
  getRootHostContainer,
  popHostContext,
  getHostContext,
  popHostContainer,
} from './ReactFiberHostContext';
import {
  suspenseStackCursor,
  popSuspenseListContext,
  popSuspenseHandler,
  pushSuspenseListContext,
  setShallowSuspenseListContext,
  ForceSuspenseFallback,
  setDefaultShallowSuspenseListContext,
} from './ReactFiberSuspenseContext';
import {popHiddenContext} from './ReactFiberHiddenContext';
import {findFirstSuspended} from './ReactFiberSuspenseComponent';
import {
  isContextProvider as isLegacyContextProvider,
  popContext as popLegacyContext,
  popTopLevelContextObject as popTopLevelLegacyContextObject,
} from './ReactFiberContext';
import {popProvider} from './ReactFiberNewContext';
import {
  prepareToHydrateHostInstance,
  prepareToHydrateHostTextInstance,
  prepareToHydrateHostSuspenseInstance,
  popHydrationState,
  resetHydrationState,
  getIsHydrating,
  upgradeHydrationErrorsToRecoverable,
  emitPendingHydrationWarnings,
} from './ReactFiberHydrationContext';
import {
  renderHasNotSuspendedYet,
  getRenderTargetTime,
  getWorkInProgressTransitions,
  shouldRemainOnPreviousScreen,
  markSpawnedRetryLane,
} from './ReactFiberWorkLoop';
import {
  OffscreenLane,
  SomeRetryLane,
  NoLanes,
  includesSomeLane,
  mergeLanes,
  claimNextRetryLane,
} from './ReactFiberLane';
import {resetChildFibers} from './ReactChildFiber';
import {createScopeInstance} from './ReactFiberScope';
import {transferActualDuration} from './ReactProfilerTimer';
import {popCacheProvider} from './ReactFiberCacheComponent';
import {popTreeContext} from './ReactFiberTreeContext';
import {popRootTransition, popTransition} from './ReactFiberTransition';
import {
  popMarkerInstance,
  popRootMarkerInstance,
} from './ReactFiberTracingMarkerComponent';
import {suspendCommit} from './ReactFiberThenable';

/**
 * Tag the fiber with an update effect. This turns a Placement into
 * a PlacementAndUpdate.
 */
function markUpdate(workInProgress: Fiber) {
  workInProgress.flags |= Update;
}

/**
 * Tag the fiber with Cloned in persistent mode to signal that
 * it received an update that requires a clone of the tree above.
 */
function markCloned(workInProgress: Fiber) {
  if (supportsPersistence && enablePersistedModeClonedFlag) {
    workInProgress.flags |= Cloned;
  }
}

/**
 * In persistent mode, return whether this update needs to clone the subtree.
 */
function doesRequireClone(current: null | Fiber, completedWork: Fiber) {
  const didBailout = current !== null && current.child === completedWork.child;
  if (didBailout) {
    return false;
  }

  if ((completedWork.flags & ChildDeletion) !== NoFlags) {
    return true;
  }

  // TODO: If we move the `doesRequireClone` call after `bubbleProperties`
  // then we only have to check the `completedWork.subtreeFlags`.
  let child = completedWork.child;
  while (child !== null) {
    const checkedFlags = enablePersistedModeClonedFlag
      ? Cloned | Visibility | Placement | ChildDeletion
      : MutationMask;
    if (
      (child.flags & checkedFlags) !== NoFlags ||
      (child.subtreeFlags & checkedFlags) !== NoFlags
    ) {
      return true;
    }
    child = child.sibling;
  }
  return false;
}

function appendAllChildren(
  parent: Instance,
  workInProgress: Fiber,
  needsVisibilityToggle: boolean,
  isHidden: boolean,
) {
  if (supportsMutation) {
    // We only have the top Fiber that was created but we need recurse down its
    // children to find all the terminal nodes.
    let node = workInProgress.child;
    while (node !== null) {
      if (node.tag === HostComponent || node.tag === HostText) {
        appendInitialChild(parent, node.stateNode);
      } else if (
        node.tag === HostPortal ||
        (supportsSingletons ? node.tag === HostSingleton : false)
      ) {
        // If we have a portal child, then we don't want to traverse
        // down its children. Instead, we'll get insertions from each child in
        // the portal directly.
        // If we have a HostSingleton it will be placed independently
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
  } else if (supportsPersistence) {
    // We only have the top Fiber that was created but we need recurse down its
    // children to find all the terminal nodes.
    let node = workInProgress.child;
    while (node !== null) {
      if (node.tag === HostComponent) {
        let instance = node.stateNode;
        if (needsVisibilityToggle && isHidden) {
          // This child is inside a timed out tree. Hide it.
          const props = node.memoizedProps;
          const type = node.type;
          instance = cloneHiddenInstance(instance, type, props);
        }
        appendInitialChild(parent, instance);
      } else if (node.tag === HostText) {
        let instance = node.stateNode;
        if (needsVisibilityToggle && isHidden) {
          // This child is inside a timed out tree. Hide it.
          const text = node.memoizedProps;
          instance = cloneHiddenTextInstance(instance, text);
        }
        appendInitialChild(parent, instance);
      } else if (node.tag === HostPortal) {
        // If we have a portal child, then we don't want to traverse
        // down its children. Instead, we'll get insertions from each child in
        // the portal directly.
      } else if (
        node.tag === OffscreenComponent &&
        node.memoizedState !== null
      ) {
        // The children in this boundary are hidden. Toggle their visibility
        // before appending.
        const child = node.child;
        if (child !== null) {
          child.return = node;
        }
        appendAllChildren(
          parent,
          node,
          /* needsVisibilityToggle */ true,
          /* isHidden */ true,
        );
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
}

// An unfortunate fork of appendAllChildren because we have two different parent types.
function appendAllChildrenToContainer(
  containerChildSet: ChildSet,
  workInProgress: Fiber,
  needsVisibilityToggle: boolean,
  isHidden: boolean,
) {
  if (supportsPersistence) {
    // We only have the top Fiber that was created but we need recurse down its
    // children to find all the terminal nodes.
    let node = workInProgress.child;
    while (node !== null) {
      if (node.tag === HostComponent) {
        let instance = node.stateNode;
        if (needsVisibilityToggle && isHidden) {
          // This child is inside a timed out tree. Hide it.
          const props = node.memoizedProps;
          const type = node.type;
          instance = cloneHiddenInstance(instance, type, props);
        }
        appendChildToContainerChildSet(containerChildSet, instance);
      } else if (node.tag === HostText) {
        let instance = node.stateNode;
        if (needsVisibilityToggle && isHidden) {
          // This child is inside a timed out tree. Hide it.
          const text = node.memoizedProps;
          instance = cloneHiddenTextInstance(instance, text);
        }
        appendChildToContainerChildSet(containerChildSet, instance);
      } else if (node.tag === HostPortal) {
        // If we have a portal child, then we don't want to traverse
        // down its children. Instead, we'll get insertions from each child in
        // the portal directly.
      } else if (
        node.tag === OffscreenComponent &&
        node.memoizedState !== null
      ) {
        // The children in this boundary are hidden. Toggle their visibility
        // before appending.
        const child = node.child;
        if (child !== null) {
          child.return = node;
        }
        // If Offscreen is not in manual mode, detached tree is hidden from user space.
        const _needsVisibilityToggle = !isOffscreenManual(node);
        appendAllChildrenToContainer(
          containerChildSet,
          node,
          /* needsVisibilityToggle */ _needsVisibilityToggle,
          /* isHidden */ true,
        );
      } else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      node = (node: Fiber);
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
}

function updateHostContainer(current: null | Fiber, workInProgress: Fiber) {
  if (supportsPersistence) {
    if (doesRequireClone(current, workInProgress)) {
      const portalOrRoot: {
        containerInfo: Container,
        pendingChildren: ChildSet,
        ...
      } = workInProgress.stateNode;
      const container = portalOrRoot.containerInfo;
      const newChildSet = createContainerChildSet();
      // If children might have changed, we have to add them all to the set.
      appendAllChildrenToContainer(
        newChildSet,
        workInProgress,
        /* needsVisibilityToggle */ false,
        /* isHidden */ false,
      );
      portalOrRoot.pendingChildren = newChildSet;
      // Schedule an update on the container to swap out the container.
      markUpdate(workInProgress);
      finalizeContainerChildren(container, newChildSet);
    }
  }
}

function updateHostComponent(
  current: Fiber,
  workInProgress: Fiber,
  type: Type,
  newProps: Props,
  renderLanes: Lanes,
) {
  // supportsMutation 表示当前渲染器是否支持直接修改DOM
  // 大多数环境（如浏览器）都支持mutation模式
  if (supportsMutation) {
    //  需要调度一个副作用执行DOM更新
    const oldProps = current.memoizedProps;
    if (oldProps === newProps) {
      return;
    }
    // 标记这个fiber节点需要更新
    // 这会将Update标志添加到fiber.flags中
    markUpdate(workInProgress);
  } else if (supportsPersistence) {
      // supportsPersistence 表示是否支持持久化模式
      // 持久化模式不直接修改DOM，而是创建新的DOM树
      // 主要用于一些特殊环境，如React Native

  // 获取当前DOM实例
    const currentInstance = current.stateNode;
    const oldProps = current.memoizedProps;
    
    //  校验两棵树的子节点，判断是否需要克隆。当节点以及子节点有变化时，需要克隆一个副本。
    const requiresClone = doesRequireClone(current, workInProgress);

    //  
    if (!requiresClone && oldProps === newProps) {
      //  复用现有实例
      workInProgress.stateNode = currentInstance;
      return;
    }
    const currentHostContext = getHostContext();

    let newChildSet = null;
    if (requiresClone && passChildrenWhenCloningPersistedNodes) {
      markCloned(workInProgress);
      newChildSet = createContainerChildSet();
      // If children might have changed, we have to add them all to the set.
      appendAllChildrenToContainer(
        newChildSet,
        workInProgress,
        /* needsVisibilityToggle */ false,
        /* isHidden */ false,
      );
    }

    const newInstance = cloneInstance(
      currentInstance,
      type,
      oldProps,
      newProps,
      !requiresClone,
      newChildSet,
    );
    if (newInstance === currentInstance) {
      // No changes, just reuse the existing instance.
      // Note that this might release a previous clone.
      workInProgress.stateNode = currentInstance;
      return;
    } else {
      markCloned(workInProgress);
    }

   // 某些渲染器需要在初始挂载时执行提交时效果
    // (例如DOM渲染器支持某些元素的自动聚焦)
    // 确保这些渲染器被安排进行后续工作
    if (
      finalizeInitialChildren(newInstance, type, newProps, currentHostContext)
    ) {
      markUpdate(workInProgress);
    }
    workInProgress.stateNode = newInstance;
    if (!requiresClone) {
      if (!enablePersistedModeClonedFlag) {
        // If there are no other effects in this tree, we need to flag this node as having one.
        // Even though we're not going to use it for anything.
        // Otherwise parents won't know that there are new children to propagate upwards.
        markUpdate(workInProgress);
      }
    } else if (!passChildrenWhenCloningPersistedNodes) {// 如果需要克隆但不传递子节点
      // 将子节点的dom节点加入到当前fiber的stateNode中
      appendAllChildren(
        newInstance,
        workInProgress,
        /* needsVisibilityToggle */ false,
        /* isHidden */ false,
      );
    }
  }
}

// 暂时放complete最后，理论上应该放beginWork中
// 处理可能需要预加载的资源，并在必要时暂停提交
function preloadInstanceAndSuspendIfNeeded(
  workInProgress: Fiber,
  type: Type,
  props: Props,
  renderLanes: Lanes,
) {
  //  
  if (!maySuspendCommit(type, props)) {// 判断自居是否依赖未加载的资源
    //  移除可能需要暂停提交的标识
    workInProgress.flags &= ~MaySuspendCommit;
    return;
  }

  // 给当前 Fiber 节点添加 MaySuspendCommit 标记
  // 这个标记表示该组件可能需要在提交阶段暂停
  // 即使当前不需要暂停，也会添加此标记，用于后续可能的资源加载情况
  workInProgress.flags |= MaySuspendCommit;

  // preload the instance if necessary. Even if this is an urgent render there
  // could be benefits to preloading early.
  // @TODO we should probably do the preload in begin work
  const isReady = preloadInstance(type, props);
  if (!isReady) {
    if (shouldRemainOnPreviousScreen()) {
      workInProgress.flags |= ShouldSuspendCommit;
    } else {
      suspendCommit();
    }
  }
}

function preloadResourceAndSuspendIfNeeded(
  workInProgress: Fiber,
  resource: Resource,
  type: Type,
  props: Props,
  renderLanes: Lanes,
) {
  // This is a fork of preloadInstanceAndSuspendIfNeeded, but for resources.
  if (!mayResourceSuspendCommit(resource)) {
    workInProgress.flags &= ~MaySuspendCommit;
    return;
  }

  workInProgress.flags |= MaySuspendCommit;

  const isReady = preloadResource(resource);
  if (!isReady) {
    if (shouldRemainOnPreviousScreen()) {
      workInProgress.flags |= ShouldSuspendCommit;
    } else {
      suspendCommit();
    }
  }
}

function scheduleRetryEffect(
  workInProgress: Fiber,
  retryQueue: RetryQueue | null,
) {
  const wakeables = retryQueue;
  if (wakeables !== null) {
    // Schedule an effect to attach a retry listener to the promise.
    // TODO: Move to passive phase
    workInProgress.flags |= Update;
  }

  // Check if we need to schedule an immediate retry. This should happen
  // whenever we unwind a suspended tree without fully rendering its siblings;
  // we need to begin the retry so we can start prerendering them.
  //
  // We also use this mechanism for Suspensey Resources (e.g. stylesheets),
  // because those don't actually block the render phase, only the commit phase.
  // So we can start rendering even before the resources are ready.
  if (workInProgress.flags & ScheduleRetry) {
    const retryLane =
      // TODO: This check should probably be moved into claimNextRetryLane
      // I also suspect that we need some further consolidation of offscreen
      // and retry lanes.
      workInProgress.tag !== OffscreenComponent
        ? claimNextRetryLane()
        : OffscreenLane;
    workInProgress.lanes = mergeLanes(workInProgress.lanes, retryLane);

    // Track the lanes that have been scheduled for an immediate retry so that
    // we can mark them as suspended upon committing the root.
    markSpawnedRetryLane(retryLane);
  }
}

function updateHostText(
  current: Fiber,
  workInProgress: Fiber,
  oldText: string,
  newText: string,
) {
  if (supportsMutation) {
    // If the text differs, mark it as an update. All the work in done in commitWork.
    if (oldText !== newText) {
      markUpdate(workInProgress);
    }
  } else if (supportsPersistence) {
    if (oldText !== newText) {
      // If the text content differs, we'll create a new text instance for it.
      const rootContainerInstance = getRootHostContainer();
      const currentHostContext = getHostContext();
      markCloned(workInProgress);
      workInProgress.stateNode = createTextInstance(
        newText,
        rootContainerInstance,
        currentHostContext,
        workInProgress,
      );
      if (!enablePersistedModeClonedFlag) {
        // We'll have to mark it as having an effect, even though we won't use the effect for anything.
        // This lets the parents know that at least one of their children has changed.
        markUpdate(workInProgress);
      }
    } else {
      workInProgress.stateNode = current.stateNode;
    }
  }
}

function cutOffTailIfNeeded(
  renderState: SuspenseListRenderState,
  hasRenderedATailFallback: boolean,
) {
  if (getIsHydrating()) {
    // If we're hydrating, we should consume as many items as we can
    // so we don't leave any behind.
    return;
  }
  switch (renderState.tailMode) {
    case 'hidden': {
      // Any insertions at the end of the tail list after this point
      // should be invisible. If there are already mounted boundaries
      // anything before them are not considered for collapsing.
      // Therefore we need to go through the whole tail to find if
      // there are any.
      let tailNode = renderState.tail;
      let lastTailNode = null;
      while (tailNode !== null) {
        if (tailNode.alternate !== null) {
          lastTailNode = tailNode;
        }
        tailNode = tailNode.sibling;
      }
      // Next we're simply going to delete all insertions after the
      // last rendered item.
      if (lastTailNode === null) {
        // All remaining items in the tail are insertions.
        renderState.tail = null;
      } else {
        // Detach the insertion after the last node that was already
        // inserted.
        lastTailNode.sibling = null;
      }
      break;
    }
    case 'collapsed': {
      // Any insertions at the end of the tail list after this point
      // should be invisible. If there are already mounted boundaries
      // anything before them are not considered for collapsing.
      // Therefore we need to go through the whole tail to find if
      // there are any.
      let tailNode = renderState.tail;
      let lastTailNode = null;
      while (tailNode !== null) {
        if (tailNode.alternate !== null) {
          lastTailNode = tailNode;
        }
        tailNode = tailNode.sibling;
      }
      // Next we're simply going to delete all insertions after the
      // last rendered item.
      if (lastTailNode === null) {
        // All remaining items in the tail are insertions.
        if (!hasRenderedATailFallback && renderState.tail !== null) {
          // We suspended during the head. We want to show at least one
          // row at the tail. So we'll keep on and cut off the rest.
          renderState.tail.sibling = null;
        } else {
          renderState.tail = null;
        }
      } else {
        // Detach the insertion after the last node that was already
        // inserted.
        lastTailNode.sibling = null;
      }
      break;
    }
  }
}

function bubbleProperties(completedWork: Fiber) {
  //  上一次渲染的Fiber，且子节点没有变化。可以跳过一些处理
  const didBailout = completedWork.alternate !== null && completedWork.alternate.child === completedWork.child;
  //  while循环遍历child的flags、subtreeFlags、并累加到当前的subtreeFlags
  //  didBailout代表跳过。需要跳过的只记录&StaticMask静态标识


  let newChildLanes: Lanes = NoLanes;
  let subtreeFlags = NoFlags;

  if (!didBailout) {
    // Bubble up the earliest expiration time.
    if (enableProfilerTimer && (completedWork.mode & ProfileMode) !== NoMode) {
      // In profiling mode, resetChildExpirationTime is also used to reset
      // profiler durations.
      let actualDuration = completedWork.actualDuration;
      let treeBaseDuration = ((completedWork.selfBaseDuration: any): number);

      let child = completedWork.child;
      while (child !== null) {
        newChildLanes = mergeLanes(
          newChildLanes,
          mergeLanes(child.lanes, child.childLanes),
        );

        subtreeFlags |= child.subtreeFlags;
        subtreeFlags |= child.flags;

        actualDuration += child.actualDuration;

        treeBaseDuration += child.treeBaseDuration;
        child = child.sibling;
      }

      completedWork.actualDuration = actualDuration;
      completedWork.treeBaseDuration = treeBaseDuration;
    } else {
      let child = completedWork.child;
      while (child !== null) {
        newChildLanes = mergeLanes(
          newChildLanes,
          mergeLanes(child.lanes, child.childLanes),
        );

        subtreeFlags |= child.subtreeFlags;// 收集子组件的subtreeFlags
        subtreeFlags |= child.flags;

        // Update the return pointer so the tree is consistent. This is a code
        // smell because it assumes the commit phase is never concurrent with
        // the render phase. Will address during refactor to alternate model.
        child.return = completedWork;

        child = child.sibling;
      }
    }

    completedWork.subtreeFlags |= subtreeFlags;
  } else {
    // Bubble up the earliest expiration time.
    if (enableProfilerTimer && (completedWork.mode & ProfileMode) !== NoMode) {
      // In profiling mode, resetChildExpirationTime is also used to reset
      // profiler durations.
      let treeBaseDuration = ((completedWork.selfBaseDuration: any): number);

      let child = completedWork.child;
      while (child !== null) {
        newChildLanes = mergeLanes(
          newChildLanes,
          mergeLanes(child.lanes, child.childLanes),
        );

        // "Static" flags share the lifetime of the fiber/hook they belong to,
        // so we should bubble those up even during a bailout. All the other
        // flags have a lifetime only of a single render + commit, so we should
        // ignore them.
        subtreeFlags |= child.subtreeFlags & StaticMask;
        subtreeFlags |= child.flags & StaticMask;

        // $FlowFixMe[unsafe-addition] addition with possible null/undefined value
        treeBaseDuration += child.treeBaseDuration;
        child = child.sibling;
      }

      completedWork.treeBaseDuration = treeBaseDuration;
    } else {
      let child = completedWork.child;
      while (child !== null) {
        newChildLanes = mergeLanes(
          newChildLanes,
          mergeLanes(child.lanes, child.childLanes),
        );

        // "Static" flags share the lifetime of the fiber/hook they belong to,
        // so we should bubble those up even during a bailout. All the other
        // flags have a lifetime only of a single render + commit, so we should
        // ignore them.
        subtreeFlags |= child.subtreeFlags & StaticMask;
        subtreeFlags |= child.flags & StaticMask;

        // Update the return pointer so the tree is consistent. This is a code
        // smell because it assumes the commit phase is never concurrent with
        // the render phase. Will address during refactor to alternate model.
        child.return = completedWork;

        child = child.sibling;
      }
    }

    completedWork.subtreeFlags |= subtreeFlags;
  }

  completedWork.childLanes = newChildLanes;

  return didBailout;
}

function completeDehydratedSuspenseBoundary(
  current: Fiber | null,
  workInProgress: Fiber,
  nextState: SuspenseState | null,//  suspense组件上的memorizedState
): boolean {
  // 进行水合状态的处理，并判断是否成功处理水合。返回true标识已成功处理
  const wasHydrated = popHydrationState(workInProgress);

  if (nextState !== null && nextState.dehydrated !== null) {
    //  表示仍然存在脱水的情况
    // 处理两种情况：首次渲染这个Suspense或更新已存在的Suspense
    
    // 情况1: 首次渲染的Suspense边界
    if (current === null) {
      if (!wasHydrated) { // 验证：首次渲染的脱水组件必须存在对应DOM节点
        throw new Error(
          'A dehydrated suspense component was completed without a hydrated node. ' +
            'This is probably a bug in React.',
        );
      }
      // 准备水合Suspense实例，关联DOM与fiber
      prepareToHydrateHostSuspenseInstance(workInProgress);
      //  冒泡子组件的标识
      bubbleProperties(workInProgress);

      //  性能分析
      if (enableProfilerTimer) {
        if ((workInProgress.mode & ProfileMode) !== NoMode) {
          const isTimedOutSuspense = nextState !== null;
          if (isTimedOutSuspense) {
            // Don't count time spent in a timed out Suspense subtree as part of the base duration.
            const primaryChildFragment = workInProgress.child;
            if (primaryChildFragment !== null) {
              // $FlowFixMe[unsafe-arithmetic] Flow doesn't support type casting in combination with the -= operator
              workInProgress.treeBaseDuration -=
                ((primaryChildFragment.treeBaseDuration: any): number);
            }
          }
        }
      }
      // 返回false表示水合已完成，不需要继续执行普通Suspense逻辑
      return false;
    } else {// 情况2: 更新已存在的Suspense边界
      
      // 判断警告，如果有会console.error
      emitPendingHydrationWarnings();

      // 重置水合状态，准备下一个水合阶段
      // 因为我们现在退出这个Suspense边界的处理
      resetHydrationState();

      // 如果Suspense没有捕获到挂起内容，清除其状态
      if ((workInProgress.flags & DidCapture) === NoFlags) {
        workInProgress.memoizedState = null;
      }
      // 标记需要在提交阶段处理的更新
      // 这确保:
      // 1. 标记这个边界已完成水合，事件可以被正常处理
      // 2. 支持事件重播和Suspense回调
      // 3. 为挂起内容设置重试监听器  
      workInProgress.flags |= Update;
      //  冒泡
      bubbleProperties(workInProgress);
      if (enableProfilerTimer) {
        if ((workInProgress.mode & ProfileMode) !== NoMode) {
          const isTimedOutSuspense = nextState !== null;
          if (isTimedOutSuspense) {
            // Don't count time spent in a timed out Suspense subtree as part of the base duration.
            const primaryChildFragment = workInProgress.child;
            if (primaryChildFragment !== null) {
              // $FlowFixMe[unsafe-arithmetic] Flow doesn't support type casting in combination with the -= operator
              workInProgress.treeBaseDuration -=
                ((primaryChildFragment.treeBaseDuration: any): number);
            }
          }
        }
      }
      return false;
    }
  } else {
    //  1、完全水合成功的suspense
    //  2、强制客户端渲染的情况。水合错误，打上ForceClientRender且dehydrated被清空
    //  3、初始化客户端渲染的suspense
    //  4.水合成功，但是又挂起了
    //  
    // 将可能在首次水合尝试时收集的错误升级为可恢复错误
    // 这些将在提交阶段被记录
    upgradeHydrationErrorsToRecoverable();

      // 返回true表示应该继续执行普通的Suspense逻辑
    return true;
  }
}

function completeWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  const newProps = workInProgress.pendingProps;
  //  此时不进行hydration校验。直接进行fiber比较更高效、且不容易出错
  //  如：更新节点不需要比较。因为已经创建了
  popTreeContext(workInProgress);
  switch (workInProgress.tag) {
    case IncompleteFunctionComponent: {
      if (disableLegacyMode) {
        break;
      }
      // Fallthrough
    }
    case LazyComponent:
    case SimpleMemoComponent:
    case FunctionComponent:
    case ForwardRef:
    case Fragment:
    case Mode:
    case Profiler:
    case ContextConsumer:
    case MemoComponent:
      //  将子组件属性冒泡到父组件。记录子组件的subTreeFlags、flags到当前组件的subTreeFlags
      bubbleProperties(workInProgress);
      return null;
    case ClassComponent: {
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        popLegacyContext(workInProgress);
      }
      bubbleProperties(workInProgress);
      return null;
    }
    case HostRoot: {
      const fiberRoot = (workInProgress.stateNode: FiberRoot);
      //  transition 处理。打上Passive的flag
      if (enableTransitionTracing) {
        const transitions = getWorkInProgressTransitions();
        if (transitions !== null) {
          workInProgress.flags |= Passive;
        }
      }
      // 缓存处理
      if (enableCache) {
        let previousCache: Cache | null = null;
        if (current !== null) {
          previousCache = current.memoizedState.cache;
        }
        const cache: Cache = workInProgress.memoizedState.cache;
        if (cache !== previousCache) {
          // Run passive effects to retain/release the cache.
          workInProgress.flags |= Passive;
        }
        popCacheProvider(workInProgress, cache);
      }

      if (enableTransitionTracing) {
        popRootMarkerInstance(workInProgress);
      }

      popRootTransition(workInProgress, fiberRoot, renderLanes);
      popHostContainer(workInProgress);
      popTopLevelLegacyContextObject(workInProgress);
      if (fiberRoot.pendingContext) {
        fiberRoot.context = fiberRoot.pendingContext;
        fiberRoot.pendingContext = null;
      }
      if (current === null || current.child === null) {
        // If we hydrated, pop so that we can delete any remaining children
        // that weren't hydrated.
        const wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          emitPendingHydrationWarnings();
          // If we hydrated, then we'll need to schedule an update for
          // the commit side-effects on the root.
          markUpdate(workInProgress);
        } else {
          if (current !== null) {
            const prevState: RootState = current.memoizedState;
            if (
              // Check if this is a client root
              !prevState.isDehydrated ||
              // Check if we reverted to client rendering (e.g. due to an error)
              (workInProgress.flags & ForceClientRender) !== NoFlags
            ) {
              // Schedule an effect to clear this container at the start of the
              // next commit. This handles the case of React rendering into a
              // container with previous children. It's also safe to do for
              // updates too, because current.child would only be null if the
              // previous render was null (so the container would already
              // be empty).
              workInProgress.flags |= Snapshot;

              // If this was a forced client render, there may have been
              // recoverable errors during first hydration attempt. If so, add
              // them to a queue so we can log them in the commit phase.
              upgradeHydrationErrorsToRecoverable();
            }
          }
        }
      }
      updateHostContainer(current, workInProgress);
      bubbleProperties(workInProgress);
      if (enableTransitionTracing) {
        if ((workInProgress.subtreeFlags & Visibility) !== NoFlags) {
          // If any of our suspense children toggle visibility, this means that
          // the pending boundaries array needs to be updated, which we only
          // do in the passive phase.
          workInProgress.flags |= Passive;
        }
      }
      return null;
    }
    case HostHoistable: {
      if (supportsResources) {
        // The branching here is more complicated than you might expect because
        // a HostHoistable sometimes corresponds to a Resource and sometimes
        // corresponds to an Instance. It can also switch during an update.

        const type = workInProgress.type;
        const nextResource: Resource | null = workInProgress.memoizedState;
        if (current === null) {
          // We are mounting and must Update this Hoistable in this commit
          // @TODO refactor this block to create the instance here in complete
          // phase if we are not hydrating.
          markUpdate(workInProgress);
          if (nextResource !== null) {
            // This is a Hoistable Resource

            // This must come at the very end of the complete phase.
            bubbleProperties(workInProgress);
            preloadResourceAndSuspendIfNeeded(
              workInProgress,
              nextResource,
              type,
              newProps,
              renderLanes,
            );
            return null;
          } else {
            // This is a Hoistable Instance
            // This must come at the very end of the complete phase.
            bubbleProperties(workInProgress);
            preloadInstanceAndSuspendIfNeeded(
              workInProgress,
              type,
              newProps,
              renderLanes,
            );
            return null;
          }
        } else {
          // This is an update.
          if (nextResource) {
            // This is a Resource
            if (nextResource !== current.memoizedState) {
              // we have a new Resource. we need to update
              markUpdate(workInProgress);
              // This must come at the very end of the complete phase.
              bubbleProperties(workInProgress);
              // This must come at the very end of the complete phase, because it might
              // throw to suspend, and if the resource immediately loads, the work loop
              // will resume rendering as if the work-in-progress completed. So it must
              // fully complete.
              preloadResourceAndSuspendIfNeeded(
                workInProgress,
                nextResource,
                type,
                newProps,
                renderLanes,
              );
              return null;
            } else {
              // This must come at the very end of the complete phase.
              bubbleProperties(workInProgress);
              workInProgress.flags &= ~MaySuspendCommit;
              return null;
            }
          } else {
            // This is an Instance
            // We may have props to update on the Hoistable instance.
            if (supportsMutation) {
              const oldProps = current.memoizedProps;
              if (oldProps !== newProps) {
                markUpdate(workInProgress);
              }
            } else {
              // We use the updateHostComponent path becuase it produces
              // the update queue we need for Hoistables.
              updateHostComponent(
                current,
                workInProgress,
                type,
                newProps,
                renderLanes,
              );
            }
            // This must come at the very end of the complete phase.
            bubbleProperties(workInProgress);
            preloadInstanceAndSuspendIfNeeded(
              workInProgress,
              type,
              newProps,
              renderLanes,
            );
            return null;
          }
        }
      }
      // Fall through
    }
    case HostSingleton: {
      if (supportsSingletons) {
        popHostContext(workInProgress);
        const rootContainerInstance = getRootHostContainer();
        const type = workInProgress.type;
        if (current !== null && workInProgress.stateNode != null) {
          if (supportsMutation) {
            const oldProps = current.memoizedProps;
            if (oldProps !== newProps) {
              markUpdate(workInProgress);
            }
          } else {
            updateHostComponent(
              current,
              workInProgress,
              type,
              newProps,
              renderLanes,
            );
          }
        } else {
          if (!newProps) {
            if (workInProgress.stateNode === null) {
              throw new Error(
                'We must have new props for new mounts. This error is likely ' +
                  'caused by a bug in React. Please file an issue.',
              );
            }

            // This can happen when we abort work.
            bubbleProperties(workInProgress);
            return null;
          }

          const currentHostContext = getHostContext();
          const wasHydrated = popHydrationState(workInProgress);
          let instance: Instance;
          if (wasHydrated) {
            // We ignore the boolean indicating there is an updateQueue because
            // it is used only to set text children and HostSingletons do not
            // use them.
            prepareToHydrateHostInstance(workInProgress, currentHostContext);
            instance = workInProgress.stateNode;
          } else {
            instance = resolveSingletonInstance(
              type,
              newProps,
              rootContainerInstance,
              currentHostContext,
              true,
            );
            workInProgress.stateNode = instance;
            markUpdate(workInProgress);
          }
        }
        bubbleProperties(workInProgress);
        return null;
      }
      // Fall through
    }
    case HostComponent: {
    // 从栈中弹出当前的 host 上下文，完成当前组件的上下文处理
    // 这是因为在 beginWork 阶段我们可能推入了新的上下文
      popHostContext(workInProgress);
      const type = workInProgress.type;

      //  DOM树中已存在内容，且存在对应节点
      if (current !== null && workInProgress.stateNode != null) {
        //  标记节点更新
        updateHostComponent(
          current,
          workInProgress,
          type,
          newProps,
          renderLanes,
        );
      } else {
        // 挂载阶段：创建新的 DOM 节点。
        if (!newProps) {
          if (workInProgress.stateNode === null) {
            throw new Error(
              'We must have new props for new mounts. This error is likely ' +
                'caused by a bug in React. Please file an issue.',
            );
          }
          // 这种情况可能发生在我们中止工作时
          // 处理 fiber 的属性冒泡
          bubbleProperties(workInProgress);
          return null;
        }
        //  获取内容的上下文，用于创建
        const currentHostContext = getHostContext();
   
        // 检查当前 fiber 是否是通过服务端渲染的水合(hydration)过程
        const wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          //  开始水合。beginWork也有
          prepareToHydrateHostInstance(workInProgress, currentHostContext);
        } else {
          // 获取根容器实例，通常是整个应用的根 DOM 节点
          const rootContainerInstance = getRootHostContainer();
          // 创建 DOM 实例
          const instance = createInstance(
            type,
            newProps,
            rootContainerInstance,
            currentHostContext,
            workInProgress,
          );
          // 标记该 fiber 为已克隆，用于优化
          markCloned(workInProgress);

          // 这里采用的是自下而上的方式，因为在 completeWork 阶段，子节点已经完成了处理
          //  将节点的子节点DOM挂载到当前Fiber的stateNode中
          appendAllChildren(instance, workInProgress, false, false);
          // 将创建的 DOM 实例保存到 fiber 的 stateNode 属性上
          workInProgress.stateNode = instance;

      
          // 某些渲染器需要在初始挂载时执行提交时效果
          // (例如 DOM 渲染器支持某些元素的自动聚焦)
          // 确保这些渲染器被安排进行后续工作
          //  判断符合的元素+需要操作的属性标识。同时满足，就打flags
          if (
            finalizeInitialChildren(
              instance,
              type,
              newProps,
              currentHostContext,
            )// 会设置相应属性
          ) {
            //  标记在提交阶段需要update
            markUpdate(workInProgress);
          }
        }
      }
      //  冒泡属性
      bubbleProperties(workInProgress);

      //  最后处理。有可能会抛出异常，需要暂停处理。
      //  大概率都是不需要的。为了预留接口
      preloadInstanceAndSuspendIfNeeded(
        workInProgress,
        workInProgress.type,
        workInProgress.pendingProps,
        renderLanes,
      );
      return null;
    }
    case HostText: {
      const newText = newProps;
      if (current && workInProgress.stateNode != null) {
        //  更新已有节点
        const oldText = current.memoizedProps;
        // If we have an alternate, that means this is an update and we need
        // to schedule a side-effect to do the updates.
        updateHostText(current, workInProgress, oldText, newText);
      } else {
        //  创建新节点
        if (typeof newText !== 'string') {
          if (workInProgress.stateNode === null) {
            throw new Error(
              'We must have new props for new mounts. This error is likely ' +
                'caused by a bug in React. Please file an issue.',
            );
          }
          // This can happen when we abort work.
        }
        //  根容器实例
        const rootContainerInstance = getRootHostContainer();
        //  获取当前的渲染上下文，包括命名空间
        const currentHostContext = getHostContext();

        //  判断当前场景是否可以水合。nextHydratableInstance已经存在说明有问题，会throw error走错误机制，重新调度。客户端渲染
        // 内部会定义nextHydratableInstance。下一个水合元素
        const wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          // 判断水合结构是否符合预期。fiber.stateNode跟fiber.memoizedProps。一个是服务端的结果，一个是Fiber的计算结果。

          //  关联Fiber跟DOM。通过internalInstanceKey
          prepareToHydrateHostTextInstance(workInProgress);
        } else {
          //  客户端渲染
          markCloned(workInProgress)//仅supportsPersistence持久化下有意义。不管如何都是clone
          //  创建一个节点
          workInProgress.stateNode = createTextInstance(
            newText,
            rootContainerInstance,
            currentHostContext,
            workInProgress,
          );
        }
      }
      bubbleProperties(workInProgress);
      return null;
    }
    case SuspenseComponent: {
      // 获取当前Suspense组件的状态
      // 如果nextState !== null，表示Suspense处于挂起状态，应该显示fallback
      // 如果nextState === null，表示Suspense应该显示其子内容
      const nextState: null | SuspenseState = workInProgress.memoizedState;
      if (
        current === null || //  首次渲染
        (current.memoizedState !== null &&current.memoizedState.dehydrated !== null)//  脱水情况
      ) {
        // 尝试完成脱水Suspense边界的水合过程，包括常规的bubbleProperties
        // 返回false表示水合处理已完成，不需要执行普通Suspense逻辑
        // 返回true表示需要继续执行普通Suspense逻辑。包括水合已经完成了
        const fallthroughToNormalSuspensePath =
          completeDehydratedSuspenseBoundary(
            current,
            workInProgress,
            nextState,
          );
        if (!fallthroughToNormalSuspensePath) {// 此时一定是水合完成的情况
          //  存在水合错误，标记为强制客户端渲染
          if (workInProgress.flags & ForceClientRender) {
            popSuspenseHandler(workInProgress);
            // 弹出Suspense处理器上下文
            // 返回workInProgress表示需要重新渲染此fiber，但使用客户端渲染。会到next，走下一个beginWork
            return workInProgress;
          } else {
            // 弹出Suspense处理器上下文
            popSuspenseHandler(workInProgress);
            // 水合逻辑已完成，但是水合没有最终完成。可能暂停或者初始渲染。
            return null;
          }
        }

        // Continue with the normal Suspense path.
      }
      // 弹出Suspense处理器上下文
      popSuspenseHandler(workInProgress);

      // 处理已捕获挂起的情况。当前suspense捕获了一个错误。需要进行处理
      //  在子组件beginWork的时候向上冒泡，打上flags。并继续渲染
      //  complete阶段，到了suspense时，重修渲染
      if ((workInProgress.flags & DidCapture) !== NoFlags) {
       // 有内容挂起，需要使用fallback子树重新渲染
        workInProgress.lanes = renderLanes;// 保留当前渲染车道用于重试
        if (  enableProfilerTimer && (workInProgress.mode & ProfileMode) !== NoMode) {
          transferActualDuration(workInProgress);
        }
        // 这种情况下不冒泡属性，直接返回fiber本身进行重新处理
        return workInProgress;
      }
      // 此处超时，代表的是是否显示fallback。跟超时无关，历史命名问题
      const nextDidTimeout = nextState !== null;// 当前是否显示fallback
      const prevDidTimeout =
        current !== null &&
        (current.memoizedState: null | SuspenseState) !== null;// 之前是否显示fallback
      if (enableCache && nextDidTimeout) {
        const offscreenFiber: Fiber = (workInProgress.child: any);
        let previousCache: Cache | null = null;
        if (
          offscreenFiber.alternate !== null &&
          offscreenFiber.alternate.memoizedState !== null &&
          offscreenFiber.alternate.memoizedState.cachePool !== null
        ) {
          previousCache = offscreenFiber.alternate.memoizedState.cachePool.pool;
        }
        let cache: Cache | null = null;
        if (
          offscreenFiber.memoizedState !== null &&
          offscreenFiber.memoizedState.cachePool !== null
        ) {
          cache = offscreenFiber.memoizedState.cachePool.pool;
        }
        if (cache !== previousCache) {
          // 如果缓存发生变化，标记需要执行副作用来保留/释放缓存
          offscreenFiber.flags |= Passive;
        }
      }

     // 处理Suspense状态变化（从正常显示到fallback或从fallback到正常显示
      if (nextDidTimeout !== prevDidTimeout) {
        // Transition追踪：在状态变化时添加Passive标记处理transitions
        if (enableTransitionTracing) {
          const offscreenFiber: Fiber = (workInProgress.child: any);
          offscreenFiber.flags |= Passive;
        }
        //  只处理当前需要显示fallback。隐藏offscreen中的真实内容
        //  如果显示真实内容。在offscreenFiber中就已经进行了切换，因为内部已经完成了
        //  但是显示fallback，代表内部没完成
        if (nextDidTimeout) {
          const offscreenFiber: Fiber = (workInProgress.child: any);
          offscreenFiber.flags |= Visibility;
        }
      }
    // 处理重试队列，调度重试效果（用于当挂起的数据就绪后重试渲染）
      const retryQueue: RetryQueue | null = (workInProgress.updateQueue: any);//  获取挂起的重试队列
      scheduleRetryEffect(workInProgress, retryQueue);
      // Suspense回调处理
      if (
        enableSuspenseCallback &&
        workInProgress.updateQueue !== null &&
        workInProgress.memoizedProps.suspenseCallback != null
      ) {
        workInProgress.flags |= Update;
      }
      bubbleProperties(workInProgress);
      if (enableProfilerTimer) {
        if ((workInProgress.mode & ProfileMode) !== NoMode) {
          if (nextDidTimeout) {
            // Don't count time spent in a timed out Suspense subtree as part of the base duration.
            const primaryChildFragment = workInProgress.child;
            if (primaryChildFragment !== null) {
              // $FlowFixMe[unsafe-arithmetic] Flow doesn't support type casting in combination with the -= operator
              workInProgress.treeBaseDuration -=
                ((primaryChildFragment.treeBaseDuration: any): number);
            }
          }
        }
      }
      return null;
    }
    case HostPortal:
      popHostContainer(workInProgress);
      updateHostContainer(current, workInProgress);
      if (current === null) {
        preparePortalMount(workInProgress.stateNode.containerInfo);
      }
      bubbleProperties(workInProgress);
      return null;
    case ContextProvider:
      // Pop provider fiber
      let context: ReactContext<any>;
      if (enableRenderableContext) {
        context = workInProgress.type;
      } else {
        context = workInProgress.type._context;
      }
      popProvider(context, workInProgress);
      bubbleProperties(workInProgress);
      return null;
    case IncompleteClassComponent: {
      if (disableLegacyMode) {
        break;
      }
      // Same as class component case. I put it down here so that the tags are
      // sequential to ensure this switch is compiled to a jump table.
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        popLegacyContext(workInProgress);
      }
      bubbleProperties(workInProgress);
      return null;
    }
    case SuspenseListComponent: {
      popSuspenseListContext(workInProgress);

      const renderState: null | SuspenseListRenderState =
        workInProgress.memoizedState;

      if (renderState === null) {
        // We're running in the default, "independent" mode.
        // We don't do anything in this mode.
        bubbleProperties(workInProgress);
        return null;
      }

      let didSuspendAlready = (workInProgress.flags & DidCapture) !== NoFlags;

      const renderedTail = renderState.rendering;
      if (renderedTail === null) {
        // We just rendered the head.
        if (!didSuspendAlready) {
          // This is the first pass. We need to figure out if anything is still
          // suspended in the rendered set.

          // If new content unsuspended, but there's still some content that
          // didn't. Then we need to do a second pass that forces everything
          // to keep showing their fallbacks.

          // We might be suspended if something in this render pass suspended, or
          // something in the previous committed pass suspended. Otherwise,
          // there's no chance so we can skip the expensive call to
          // findFirstSuspended.
          const cannotBeSuspended =
            renderHasNotSuspendedYet() &&
            (current === null || (current.flags & DidCapture) === NoFlags);
          if (!cannotBeSuspended) {
            let row = workInProgress.child;
            while (row !== null) {
              const suspended = findFirstSuspended(row);
              if (suspended !== null) {
                didSuspendAlready = true;
                workInProgress.flags |= DidCapture;
                cutOffTailIfNeeded(renderState, false);

                // If this is a newly suspended tree, it might not get committed as
                // part of the second pass. In that case nothing will subscribe to
                // its thenables. Instead, we'll transfer its thenables to the
                // SuspenseList so that it can retry if they resolve.
                // There might be multiple of these in the list but since we're
                // going to wait for all of them anyway, it doesn't really matter
                // which ones gets to ping. In theory we could get clever and keep
                // track of how many dependencies remain but it gets tricky because
                // in the meantime, we can add/remove/change items and dependencies.
                // We might bail out of the loop before finding any but that
                // doesn't matter since that means that the other boundaries that
                // we did find already has their listeners attached.
                const retryQueue: RetryQueue | null =
                  (suspended.updateQueue: any);
                workInProgress.updateQueue = retryQueue;
                scheduleRetryEffect(workInProgress, retryQueue);

                // Rerender the whole list, but this time, we'll force fallbacks
                // to stay in place.
                // Reset the effect flags before doing the second pass since that's now invalid.
                // Reset the child fibers to their original state.
                workInProgress.subtreeFlags = NoFlags;
                resetChildFibers(workInProgress, renderLanes);

                // Set up the Suspense List Context to force suspense and
                // immediately rerender the children.
                pushSuspenseListContext(
                  workInProgress,
                  setShallowSuspenseListContext(
                    suspenseStackCursor.current,
                    ForceSuspenseFallback,
                  ),
                );
                // Don't bubble properties in this case.
                return workInProgress.child;
              }
              row = row.sibling;
            }
          }

          if (renderState.tail !== null && now() > getRenderTargetTime()) {
            // We have already passed our CPU deadline but we still have rows
            // left in the tail. We'll just give up further attempts to render
            // the main content and only render fallbacks.
            workInProgress.flags |= DidCapture;
            didSuspendAlready = true;

            cutOffTailIfNeeded(renderState, false);

            // Since nothing actually suspended, there will nothing to ping this
            // to get it started back up to attempt the next item. While in terms
            // of priority this work has the same priority as this current render,
            // it's not part of the same transition once the transition has
            // committed. If it's sync, we still want to yield so that it can be
            // painted. Conceptually, this is really the same as pinging.
            // We can use any RetryLane even if it's the one currently rendering
            // since we're leaving it behind on this node.
            workInProgress.lanes = SomeRetryLane;
          }
        } else {
          cutOffTailIfNeeded(renderState, false);
        }
        // Next we're going to render the tail.
      } else {
        // Append the rendered row to the child list.
        if (!didSuspendAlready) {
          const suspended = findFirstSuspended(renderedTail);
          if (suspended !== null) {
            workInProgress.flags |= DidCapture;
            didSuspendAlready = true;

            // Ensure we transfer the update queue to the parent so that it doesn't
            // get lost if this row ends up dropped during a second pass.
            const retryQueue: RetryQueue | null = (suspended.updateQueue: any);
            workInProgress.updateQueue = retryQueue;
            scheduleRetryEffect(workInProgress, retryQueue);

            cutOffTailIfNeeded(renderState, true);
            // This might have been modified.
            if (
              renderState.tail === null &&
              renderState.tailMode === 'hidden' &&
              !renderedTail.alternate &&
              !getIsHydrating() // We don't cut it if we're hydrating.
            ) {
              // We're done.
              bubbleProperties(workInProgress);
              return null;
            }
          } else if (
            // The time it took to render last row is greater than the remaining
            // time we have to render. So rendering one more row would likely
            // exceed it.
            now() * 2 - renderState.renderingStartTime >
              getRenderTargetTime() &&
            renderLanes !== OffscreenLane
          ) {
            // We have now passed our CPU deadline and we'll just give up further
            // attempts to render the main content and only render fallbacks.
            // The assumption is that this is usually faster.
            workInProgress.flags |= DidCapture;
            didSuspendAlready = true;

            cutOffTailIfNeeded(renderState, false);

            // Since nothing actually suspended, there will nothing to ping this
            // to get it started back up to attempt the next item. While in terms
            // of priority this work has the same priority as this current render,
            // it's not part of the same transition once the transition has
            // committed. If it's sync, we still want to yield so that it can be
            // painted. Conceptually, this is really the same as pinging.
            // We can use any RetryLane even if it's the one currently rendering
            // since we're leaving it behind on this node.
            workInProgress.lanes = SomeRetryLane;
          }
        }
        if (renderState.isBackwards) {
          // The effect list of the backwards tail will have been added
          // to the end. This breaks the guarantee that life-cycles fire in
          // sibling order but that isn't a strong guarantee promised by React.
          // Especially since these might also just pop in during future commits.
          // Append to the beginning of the list.
          renderedTail.sibling = workInProgress.child;
          workInProgress.child = renderedTail;
        } else {
          const previousSibling = renderState.last;
          if (previousSibling !== null) {
            previousSibling.sibling = renderedTail;
          } else {
            workInProgress.child = renderedTail;
          }
          renderState.last = renderedTail;
        }
      }

      if (renderState.tail !== null) {
        // We still have tail rows to render.
        // Pop a row.
        const next = renderState.tail;
        renderState.rendering = next;
        renderState.tail = next.sibling;
        renderState.renderingStartTime = now();
        next.sibling = null;

        // Restore the context.
        // TODO: We can probably just avoid popping it instead and only
        // setting it the first time we go from not suspended to suspended.
        let suspenseContext = suspenseStackCursor.current;
        if (didSuspendAlready) {
          suspenseContext = setShallowSuspenseListContext(
            suspenseContext,
            ForceSuspenseFallback,
          );
        } else {
          suspenseContext =
            setDefaultShallowSuspenseListContext(suspenseContext);
        }
        pushSuspenseListContext(workInProgress, suspenseContext);
        // Do a pass over the next row.
        // Don't bubble properties in this case.
        return next;
      }
      bubbleProperties(workInProgress);
      return null;
    }
    case ScopeComponent: {
      if (enableScopeAPI) {
        if (current === null) {
          const scopeInstance: ReactScopeInstance = createScopeInstance();
          workInProgress.stateNode = scopeInstance;
          prepareScopeUpdate(scopeInstance, workInProgress);
          if (workInProgress.ref !== null) {
            // Scope components always do work in the commit phase if there's a
            // ref attached.
            markUpdate(workInProgress);
          }
        } else {
          if (workInProgress.ref !== null) {
            // Scope components always do work in the commit phase if there's a
            // ref attached.
            markUpdate(workInProgress);
          }
        }
        bubbleProperties(workInProgress);
        return null;
      }
      break;
    }
    case OffscreenComponent:
    case LegacyHiddenComponent: {
      popSuspenseHandler(workInProgress);
      popHiddenContext(workInProgress);
      const nextState: OffscreenState | null = workInProgress.memoizedState;
      const nextIsHidden = nextState !== null;

      // Schedule a Visibility effect if the visibility has changed
      if (enableLegacyHidden && workInProgress.tag === LegacyHiddenComponent) {
        // LegacyHidden doesn't do any hiding — it only pre-renders.
      } else {
        if (current !== null) {
          const prevState: OffscreenState | null = current.memoizedState;
          const prevIsHidden = prevState !== null;
          if (prevIsHidden !== nextIsHidden) {
            workInProgress.flags |= Visibility;
          }
        } else {
          // On initial mount, we only need a Visibility effect if the tree
          // is hidden.
          if (nextIsHidden) {
            workInProgress.flags |= Visibility;
          }
        }
      }

      if (
        !nextIsHidden ||
        (!disableLegacyMode &&
          (workInProgress.mode & ConcurrentMode) === NoMode)
      ) {
        bubbleProperties(workInProgress);
      } else {
        // Don't bubble properties for hidden children unless we're rendering
        // at offscreen priority.
        if (
          includesSomeLane(renderLanes, (OffscreenLane: Lane)) &&
          // Also don't bubble if the tree suspended
          (workInProgress.flags & DidCapture) === NoLanes
        ) {
          bubbleProperties(workInProgress);
          // Check if there was an insertion or update in the hidden subtree.
          // If so, we need to hide those nodes in the commit phase, so
          // schedule a visibility effect.
          if (
            (!enableLegacyHidden ||
              workInProgress.tag !== LegacyHiddenComponent) &&
            workInProgress.subtreeFlags & (Placement | Update)
          ) {
            workInProgress.flags |= Visibility;
          }
        }
      }

      const offscreenQueue: OffscreenQueue | null =
        (workInProgress.updateQueue: any);
      if (offscreenQueue !== null) {
        const retryQueue = offscreenQueue.retryQueue;
        scheduleRetryEffect(workInProgress, retryQueue);
      }

      if (enableCache) {
        let previousCache: Cache | null = null;
        if (
          current !== null &&
          current.memoizedState !== null &&
          current.memoizedState.cachePool !== null
        ) {
          previousCache = current.memoizedState.cachePool.pool;
        }
        let cache: Cache | null = null;
        if (
          workInProgress.memoizedState !== null &&
          workInProgress.memoizedState.cachePool !== null
        ) {
          cache = workInProgress.memoizedState.cachePool.pool;
        }
        if (cache !== previousCache) {
          // Run passive effects to retain/release the cache.
          workInProgress.flags |= Passive;
        }
      }

      popTransition(workInProgress, current);

      return null;
    }
    case CacheComponent: {
      if (enableCache) {
        let previousCache: Cache | null = null;
        if (current !== null) {
          previousCache = current.memoizedState.cache;
        }
        const cache: Cache = workInProgress.memoizedState.cache;
        if (cache !== previousCache) {
          // Run passive effects to retain/release the cache.
          workInProgress.flags |= Passive;
        }
        popCacheProvider(workInProgress, cache);
        bubbleProperties(workInProgress);
      }
      return null;
    }
    case TracingMarkerComponent: {
      if (enableTransitionTracing) {
        const instance: TracingMarkerInstance | null = workInProgress.stateNode;
        if (instance !== null) {
          popMarkerInstance(workInProgress);
        }
        bubbleProperties(workInProgress);
      }
      return null;
    }
    case Throw: {
      if (!disableLegacyMode) {
        // Only Legacy Mode completes an errored node.
        return null;
      }
    }
  }

  throw new Error(
    `Unknown unit of work tag (${workInProgress.tag}). This error is likely caused by a bug in ` +
      'React. Please file an issue.',
  );
}

export {completeWork};
