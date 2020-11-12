/* @flow */

import { _Vue } from '../install'
import type Router from '../index'
import { inBrowser } from '../util/dom'
import { runQueue } from '../util/async'
import { warn } from '../util/warn'
import { START, isSameRoute } from '../util/route'
import {
  flatten,
  flatMapComponents,
  resolveAsyncComponents
} from '../util/resolve-components'
import {
  createNavigationDuplicatedError,
  createNavigationCancelledError,
  createNavigationRedirectedError,
  createNavigationAbortedError,
  isError,
  isNavigationFailure,
  NavigationFailureType
} from '../util/errors'

export class History {
  router: Router
  base: string
  current: Route
  pending: ?Route
  cb: (r: Route) => void
  ready: boolean
  readyCbs: Array<Function>
  readyErrorCbs: Array<Function>
  errorCbs: Array<Function>
  listeners: Array<Function>
  cleanupListeners: Function

  // implemented by sub-classes
  +go: (n: number) => void
  +push: (loc: RawLocation, onComplete?: Function, onAbort?: Function) => void
  +replace: (
    loc: RawLocation,
    onComplete?: Function,
    onAbort?: Function
  ) => void
  +ensureURL: (push?: boolean) => void
  +getCurrentLocation: () => string
  +setupListeners: Function

  constructor (router: Router, base: ?string) {
    this.router = router
    // 规范化base
    this.base = normalizeBase(base)
    // start with a route object that stands for "nowhere"
    // 开始路由对象
    this.current = START
    this.pending = null
    this.ready = false
    this.readyCbs = []
    this.readyErrorCbs = []
    this.errorCbs = []
    this.listeners = []
  }

  listen (cb: Function) {
    this.cb = cb
  }

  // 路由全局设置在路由初始化后调用
  // 可以设置多个回调，push(f,f,f)
  onReady (cb: Function, errorCb: ?Function) {
    if (this.ready) {
      cb()
    } else {
      this.readyCbs.push(cb)
      if (errorCb) {
        this.readyErrorCbs.push(errorCb)
      }
    }
  }

  onError (errorCb: Function) {
    this.errorCbs.push(errorCb)
  }

  // 路由匹配跳转
  transitionTo (
    location: RawLocation,
    onComplete?: Function,
    onAbort?: Function
  ) {
    let route
    // catch redirect option https://github.com/vuejs/vue-router/issues/3201
    try {
      // 匹配路由
      route = this.router.match(location, this.current)
    } catch (e) {
      this.errorCbs.forEach(cb => {
        cb(e)
      })
      // Exception should still be thrown
      throw e
    }
    // 调用路由组件的守卫构子
    this.confirmTransition(
      route,
      () => {
        const prev = this.current
        // 更新当前路由，触发视图更新，在微任务队列中，因此实际执行在afterHooks后面
        this.updateRoute(route)
        // 路由更新成功后的回调
        onComplete && onComplete(route)
        //设置浏览器地址栏的
        this.ensureURL()
        // 调用全局
        this.router.afterHooks.forEach(hook => {
          hook && hook(route, prev)
        })

        // fire ready cbs once
        // 调用路由初始化的onready回调，全局一次
        if (!this.ready) {
          this.ready = true
          this.readyCbs.forEach(cb => {
            cb(route)
          })
        }
      },
      err => {
        if (onAbort) {
          onAbort(err)
        }
        if (err && !this.ready) {
          this.ready = true
          // Initial redirection should still trigger the onReady onSuccess
          // https://github.com/vuejs/vue-router/issues/3225
          if (!isNavigationFailure(err, NavigationFailureType.redirected)) {
            this.readyErrorCbs.forEach(cb => {
              cb(err)
            })
          } else {
            this.readyCbs.forEach(cb => {
              cb(route)
            })
          }
        }
      }
    )
  }

  //前后路由的切换时调用路由相关的所有组件预设的守卫
  confirmTransition (route: Route, onComplete: Function, onAbort?: Function) {
    const current = this.current
    const abort = err => {
      // changed after adding errors with
      // https://github.com/vuejs/vue-router/pull/3047 before that change,
      // redirect and aborted navigation would produce an err == null
      if (!isNavigationFailure(err) && isError(err)) {
        if (this.errorCbs.length) {
          this.errorCbs.forEach(cb => {
            cb(err)
          })
        } else {
          warn(false, 'uncaught error during route navigation:')
          console.error(err)
        }
      }
      onAbort && onAbort(err)
    }
    const lastRouteIndex = route.matched.length - 1
    const lastCurrentIndex = current.matched.length - 1
    if (
      isSameRoute(route, current) &&
      // in the case the route map has been dynamically appended to
      lastRouteIndex === lastCurrentIndex &&
      route.matched[lastRouteIndex] === current.matched[lastCurrentIndex]
    ) {
      this.ensureURL()
      return abort(createNavigationDuplicatedError(current, route))
    }

    // 找出3中类型的路由记录
    const { updated, deactivated, activated } = resolveQueue(
      this.current.matched,
      route.matched
    )

    /**
      在失活的组件里调用 beforeRouteLeave 守卫。
      调用全局的 beforeEach 守卫。
      在重用的组件里调用 beforeRouteUpdate 守卫 (2.2+)。
      在路由配置里调用 beforeEnter。
      解析异步路由组件。
     */
    const queue: Array<?NavigationGuard> = [].concat(
      // in-component leave guards
      //提取deactivated路由记录的beforeRouteLeave守卫
      extractLeaveGuards(deactivated),
      // global before hooks
      this.router.beforeHooks,
      // in-component update hooks
      // 提取beforeRouteUpdate路由记录下的组件的beforeRouteUpdate守卫
      extractUpdateHooks(updated),
      // in-config enter guards
      // 路由记录中的beforeEnter
      activated.map(m => m.beforeEnter),
      // async components
      // 解析异步路由组件，组件加载完才进入下一步钩子
      resolveAsyncComponents(activated)
    )

    this.pending = route
    const iterator = (hook: NavigationGuard, next/**调用下一个钩子 */) => {
      if (this.pending !== route) {
        return abort(createNavigationCancelledError(current, route))
      }
      try {
        hook(route, current, (to: any) => {
          // 给用户的next方法，根据不同的参数产生不同的行为，默认是下一个钩子
          if (to === false) {
            // next(false) -> abort navigation, ensure current URL
            this.ensureURL(true)
            abort(createNavigationAbortedError(current, route))
          } else if (isError(to)) {
            this.ensureURL(true)
            abort(to)
          } else if (
            typeof to === 'string' ||
            (typeof to === 'object' &&
              (typeof to.path === 'string' || typeof to.name === 'string'))
          ) {
            // next('/') or next({ path: '/' }) -> redirect
            abort(createNavigationRedirectedError(current, route))
            if (typeof to === 'object' && to.replace) {
              this.replace(to)
            } else {
              this.push(to)
            }
          } else {
            // confirm transition and pass on the value
            // 下一个钩子
            next(to)
          }
        })
      } catch (e) {
        abort(e)
      }
    }

    // 依次调用钩子队列，如下规则
    /**   
     * 导航被触发。
      在被激活的组件里调用 beforeRouteEnter。
      调用全局的 beforeResolve 守卫 (2.5+)。
      导航被确认。
      调用全局的 afterEach 钩子。
      触发 DOM 更新。
      调用 beforeRouteEnter 守卫中传给 next 的回调函数，创建好的组件实例会作为回调函数的参数传入。
    */
    runQueue(queue, iterator, () => {
      const postEnterCbs = []
      const isValid = () => this.current === route
      // wait until async components are resolved before
      // extracting in-component enter guards
      // 提取beforeRouteEnter守卫
      const enterGuards = extractEnterGuards(activated, postEnterCbs, isValid)
      // 添加全局的beforeResolve守卫
      const queue = enterGuards.concat(this.router.resolveHooks)
      runQueue(queue, iterator, () => {
        if (this.pending !== route) {
          return abort(createNavigationCancelledError(current, route))
        }
        this.pending = null
        // 这里会确认导航，并且调用afterEach守卫
        onComplete(route)
        if (this.router.app) {
          //调用 beforeRouteEnter 守卫中传给 next 的回调函数
          this.router.app.$nextTick(() => {
            postEnterCbs.forEach(cb => {
              cb()
            })
          })
        }
      })
    })
  }

  // 更新路由，设置_route触发视图更新
  updateRoute (route: Route) {
    this.current = route
    // 这个回调会更改_route,有this.listen全局注册
    this.cb && this.cb(route)
  }

  setupListeners () {
    // Default implementation is empty
  }

  // 重置history对象
  teardown () {
    // clean up event listeners
    // https://github.com/vuejs/vue-router/issues/2341
    this.listeners.forEach(cleanupListener => {
      cleanupListener()
    })
    this.listeners = []

    // reset current history route
    // https://github.com/vuejs/vue-router/issues/3294
    this.current = START
    this.pending = null
  }
}

// base取值如果是/就是"",否则就是/XX
function normalizeBase (base: ?string): string {
  if (!base) {
    if (inBrowser) {
      // respect <base> tag
      const baseEl = document.querySelector('base')
      base = (baseEl && baseEl.getAttribute('href')) || '/'
      // strip full URL origin
      base = base.replace(/^https?:\/\/[^\/]+/, '')
    } else {
      base = '/'
    }
  }
  // make sure there's the starting slash
  // 格式化成/XX
  if (base.charAt(0) !== '/') {
    base = '/' + base
  }
  // remove trailing slash
  // 去掉尾部的/，如果只有'/'，会变成""
  return base.replace(/\/$/, '')
}

// 从当前路由的matched路由记录和将要进入的路由的matched路由记录中归类
function resolveQueue (
  current: Array<RouteRecord>,
  next: Array<RouteRecord>
): {
  updated: Array<RouteRecord>,
  activated: Array<RouteRecord>,
  deactivated: Array<RouteRecord>
} {
  let i
  const max = Math.max(current.length, next.length)
  // 比较前后记录的差异，找出哪些记录要更新，哪些是新进，哪些是移除
  for (i = 0; i < max; i++) {
    if (current[i] !== next[i]) {
      break
    }
  }
  return {
    updated: next.slice(0, i),
    activated: next.slice(i),
    deactivated: current.slice(i)
  }
}

// 提取路由守卫，获得所有路由记录的组件的守卫方法
function extractGuards (
  records: Array<RouteRecord>,
  name: string,
  bind: Function,
  reverse?: boolean
): Array<?Function> {
  // 得到所有路由记录中组件的指定名的钩子函数
  // 结构是[f,f,[f,f,f,f],[f,f]]，单f，和[f,f]各自是一个组件的钩子
  const guards = flatMapComponents(records, (def, instance, match, key) => {
    // 在当前组件中获得指定的路由守卫，比如beforerouterenter等
    const guard = extractGuard(def, name)
    if (guard) {
      // 给守卫方法绑定内容guard.apply(instance,[match, key])
      // 为什么是数组，因为vue的钩子函数合并策略
      return Array.isArray(guard)
        ? guard.map(guard => bind(guard, instance, match, key))
        : bind(guard, instance, match, key)
    }
  })
  // 反转的目的是什么？
  return flatten(reverse ? guards.reverse() : guards)
}

// 获得指定组件的路由守卫
function extractGuard (
  def: Object | Function,
  key: string
): NavigationGuard | Array<NavigationGuard> {
  if (typeof def !== 'function') {
    // extend now so that global mixins are applied.
    // 把组件选项生成构造函数，如果没有生成
    def = _Vue.extend(def)
  }
  // 获得组件的路由守卫方法
  return def.options[key]
}

// 从deactivated路由记录中提取beforeRouteLeave
function extractLeaveGuards (deactivated: Array<RouteRecord>): Array<?Function> {
  return extractGuards(deactivated, 'beforeRouteLeave', bindGuard, true)
}

function extractUpdateHooks (updated: Array<RouteRecord>): Array<?Function> {
  return extractGuards(updated, 'beforeRouteUpdate', bindGuard)
}

// 绑定守卫this和参数
function bindGuard (guard: NavigationGuard, instance: ?_Vue): ?NavigationGuard {
  if (instance) {
    return function boundRouteGuard () {
      return guard.apply(instance, arguments)
    }
  }
}

// 提取组件的beforeRouteEnter守卫
function extractEnterGuards (
  activated: Array<RouteRecord>,
  cbs: Array<Function>,
  isValid: () => boolean
): Array<?Function> {
  return extractGuards(
    activated,
    'beforeRouteEnter',
    (guard, _, match, key) => {
      // 给守卫方法绑定参数
      return bindEnterGuard(guard, match, key, cbs, isValid)
    }
  )
}

// 封装用户routeEnter的守卫方法
function bindEnterGuard (
  guard: NavigationGuard,
  match: RouteRecord,
  key: string,
  cbs: Array<Function>,
  isValid: () => boolean
): NavigationGuard {
  return function routeEnterGuard (to, from, next) {
    // 调用用户的守卫，cb是用户给的回调在vm实例化后调用
    return guard(to, from, cb => {
      // 这个方法是守卫的next方法，由用户主动调用
      if (typeof cb === 'function') {
        cbs.push(() => {
          // #750
          // if a router-view is wrapped with an out-in transition,
          // the instance may not have been registered at this time.
          // we will need to poll for registration until current route
          // is no longer valid.
          poll(cb, match.instances, key, isValid)
        })
      }
      next(cb)
    })
  }
}

// 轮询instance是否满足调用cb的时机，
// 这个是为了解决beforeRouteEnter钩子中获得vm实例
function poll (
  cb: any, // somehow flow cannot infer this is a function
  instances: Object,
  key: string,
  isValid: () => boolean
) {
  if (
    instances[key] &&
    !instances[key]._isBeingDestroyed // do not reuse being destroyed instance
  ) {
    cb(instances[key])
  } else if (isValid()) {
    setTimeout(() => {
      poll(cb, instances, key, isValid)
    }, 16)
  }
}
