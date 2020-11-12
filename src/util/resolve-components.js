/* @flow */

import { _Vue } from '../install'
import { warn } from './warn'
import { isError } from '../util/errors'

// 异步组件获取
export function resolveAsyncComponents (matched: Array<RouteRecord>): Function {
  return (to, from, next) => {
    let hasAsync = false
    let pending = 0
    let error = null

    flatMapComponents(matched, (def, _, match, key) => {// 组件定义,vm实例,match匹配,key组件名
      // if it's a function and doesn't have cid attached,
      // assume it's an async component resolve function.
      // we are not using Vue's default async resolving mechanism because
      // we want to halt the navigation until the incoming component has been
      // resolved.
      /**
       * 如果是一个方法且没有cid，那么认为是一个异步组件获取方法
       * 我们不适用vue默认的异步函数解决机制，是因为我们想停止导航，直到组件获取完成
       * 也就是说利用pending计数来判断是否要调用next来执行下一个阶段的钩子
       * 
       */
      if (typeof def === 'function' && def.cid === undefined) {
        hasAsync = true
        pending++ //在同一次路由切换中，异步组件请求次数计数

        const resolve = once(resolvedDef => {
          if (isESModule(resolvedDef)) {
            resolvedDef = resolvedDef.default
          }
          // save resolved on async factory in case it's used elsewhere
          def.resolved = typeof resolvedDef === 'function'
            ? resolvedDef
            : _Vue.extend(resolvedDef)
            // 替换原来的异步函数为组件构造函数
          match.components[key] = resolvedDef
          pending--
          if (pending <= 0) {
            next()
          }
        })

        const reject = once(reason => {
          // 组件加载错误会在这里中断
          const msg = `Failed to resolve async component ${key}: ${reason}`
          process.env.NODE_ENV !== 'production' && warn(false, msg)
          if (!error) {
            error = isError(reason)
              ? reason
              : new Error(msg)
            next(error)
          }
        })

        let res
        try {
          res = def(resolve, reject)
        } catch (e) {
          reject(e)
        }
        if (res) {
          if (typeof res.then === 'function') {
            res.then(resolve, reject)
          } else {
            // new syntax in Vue 2.3
            const comp = res.component
            if (comp && typeof comp.then === 'function') {
              comp.then(resolve, reject)
            }
          }
        }
      }
    })

    // 没有异步组件
    if (!hasAsync) next()
  }
}

// 提取所有matched的路由记录的组件，并且放入一维数组中
export function flatMapComponents (
  matched: Array<RouteRecord>,
  fn: Function
): Array<?Function> {
  // flatten之前的结构是[[fn,fn],[fn]],最里面的钩子函数，所以这里出现了2次flatten
  return flatten(matched.map(m => {
    // 根据fn的功能，比如提取components中指定的钩子函数，结构是[[[f,f,f],f],[f,f,[f,f]]]
    return Object.keys(m.components).map(key => fn(
      m.components[key],
      m.instances[key],
      m, key
    ))
  }))
}

// 二维数组转一维数组
export function flatten (arr: Array<any>): Array<any> {
  return Array.prototype.concat.apply([], arr)
}

const hasSymbol =
  typeof Symbol === 'function' &&
  typeof Symbol.toStringTag === 'symbol'

function isESModule (obj) {
  return obj.__esModule || (hasSymbol && obj[Symbol.toStringTag] === 'Module')
}

// in Webpack 2, require.ensure now also returns a Promise
// so the resolve/reject functions may get called an extra time
// if the user uses an arrow function shorthand that happens to
// return that Promise.
// 只允许调用一次
function once (fn) {
  let called = false
  return function (...args) {
    if (called) return
    called = true
    return fn.apply(this, args)
  }
}
