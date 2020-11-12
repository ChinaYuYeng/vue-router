/* @flow */

// 不满足条件就报错
export function assert (condition: any, message: string) {
  if (!condition) {
    // 和console.error()不同的是，Error会记录错误的详细信息，不光是提供的文本
    throw new Error(`[vue-router] ${message}`)
  }
}

// 在开发环境下，不满足条件就报警告
export function warn (condition: any, message: string) {
  if (process.env.NODE_ENV !== 'production' && !condition) {
    typeof console !== 'undefined' && console.warn(`[vue-router] ${message}`)
  }
}

