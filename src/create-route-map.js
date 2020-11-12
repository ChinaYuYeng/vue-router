/* @flow */

import Regexp from 'path-to-regexp'
import { cleanPath } from './util/path'
import { assert, warn } from './util/warn'

// 建立路由映射
export function createRouteMap (
  routes: Array<RouteConfig>,
  oldPathList?: Array<string>,
  oldPathMap?: Dictionary<RouteRecord>,
  oldNameMap?: Dictionary<RouteRecord>
): {
  pathList: Array<string>,
  pathMap: Dictionary<RouteRecord>,
  nameMap: Dictionary<RouteRecord>
} {
  // the path list is used to control path matching priority
  // 所有路由的path数组，用来控制path匹配优先级
  // oldxxx是给与动态添加路由设计的
  const pathList: Array<string> = oldPathList || []
  // $flow-disable-line
  const pathMap: Dictionary<RouteRecord> = oldPathMap || Object.create(null)
  // $flow-disable-line
  const nameMap: Dictionary<RouteRecord> = oldNameMap || Object.create(null)

  // 生成路由记录，已经path和记录，name和记录等关系映射
  routes.forEach(route => {
    addRouteRecord(pathList, pathMap, nameMap, route)
  })

  // ensure wildcard routes are always at the end
  // 移动通配符*到数组的最后面
  // 这里迭代的时候会改变数组，特别是i指针的位置问题
  for (let i = 0, l = pathList.length; i < l; i++) {
    if (pathList[i] === '*') {
      pathList.push(pathList.splice(i, 1)[0])
      l--
      i-- //当前指向别移动到了最后，需要修正到前一个元素，然后在i++
    }
  }

  if (process.env.NODE_ENV === 'development') {
    // warn if routes do not include leading slashes
    const found = pathList
    // check for missing leading slash
      .filter(path => path && path.charAt(0) !== '*' && path.charAt(0) !== '/')

    if (found.length > 0) {
      const pathNames = found.map(path => `- ${path}`).join('\n')
      warn(false, `Non-nested routes must include a leading slash character. Fix the following routes: \n${pathNames}`)
    }
  }

  return {
    pathList,
    pathMap,
    nameMap
  }
}

function addRouteRecord (
  pathList: Array<string>, //存储每个路由的path
  pathMap: Dictionary<RouteRecord>, //path和record的映射关系
  nameMap: Dictionary<RouteRecord>,  //name和record的映射关系
  route: RouteConfig, //路由定义
  parent?: RouteRecord, //父路由记录
  matchAs?: string //和路由别名有关，
) {
  const { path, name } = route
  if (process.env.NODE_ENV !== 'production') {
    assert(path != null, `"path" is required in a route configuration.`)
    assert(
      typeof route.component !== 'string',
      `route config "component" for path: ${String(
        path || name
      )} cannot be a ` + `string id. Use an actual component instead.`
    )
  }

  //编译正则的选项
  const pathToRegexpOptions: PathToRegexpOptions =
    route.pathToRegexpOptions || {}
    // 获得当前路由的完整path
  const normalizedPath = normalizePath(path, parent, pathToRegexpOptions.strict)

  if (typeof route.caseSensitive === 'boolean') {
    pathToRegexpOptions.sensitive = route.caseSensitive
  }

  const record: RouteRecord = {
    path: normalizedPath, //route的完整的path
    regex: compileRouteRegex(normalizedPath, pathToRegexpOptions), //匹配这个path的正则表达式
    components: route.components || { default: route.component },//路由对应的组件，默认是default，还可以是其他命名。类似slot
    instances: {}, //与components对应的vm组件实例
    name, //路由名
    parent, //父级路由
    matchAs, //设置别名的路由，在创建别名路由是用于保存真实路由（暂定）
    redirect: route.redirect, //重定向设置
    beforeEnter: route.beforeEnter, //路由配置中定义的钩子
    meta: route.meta || {}, //额外的参数
    props:   //传递给组件的props属性
      route.props == null
        ? {}
        : route.components
          ? route.props
          : { default: route.props }
  }
  //子路由处理
  // 递归建立子节点的RouteRecord
  if (route.children) {
    // Warn if route is named, does not redirect and has a default child route.
    // If users navigate to this route by name, the default child will
    // not be rendered (GH Issue #629)
    if (process.env.NODE_ENV !== 'production') {
      if (
        route.name &&
        !route.redirect &&
        route.children.some(child => /^\/?$/.test(child.path))
      ) {
        warn(
          false,
          `Named Route '${route.name}' has a default child route. ` +
            `When navigating to this named route (:to="{name: '${
              route.name
            }'"), ` +
            `the default child route will not be rendered. Remove the name from ` +
            `this route and use the name of the default child route for named ` +
            `links instead.`
        )
      }
    }
    route.children.forEach(child => {
      // 是否是别名路由，是的话就设置matchas
      const childMatchAs = matchAs
        ? cleanPath(`${matchAs}/${child.path}`)
        : undefined
        // 建立子路由记录包括别名记录
      addRouteRecord(pathList, pathMap, nameMap, child, record, childMatchAs)
    })
  }

  // 存储数据供后续使用
  if (!pathMap[record.path]) {
    pathList.push(record.path)
    // 建立path和record的映射
    pathMap[record.path] = record
  }

  // 路由别名处理
  //有别名的时候也会生成别名的路由记录（是正常路由记录的拷贝，只是path不一样）
  if (route.alias !== undefined) {
    const aliases = Array.isArray(route.alias) ? route.alias : [route.alias]
    for (let i = 0; i < aliases.length; ++i) {
      const alias = aliases[i]
      if (process.env.NODE_ENV !== 'production' && alias === path) {
        warn(
          false,
          `Found an alias with the same value as the path: "${path}". You have to remove that alias. It will be ignored in development.`
        )
        // skip in dev to make it work
        continue
      }

      // 别名其实就是额外创建了路由记录，但children保持原状
      const aliasRoute = {
        path: alias,
        children: route.children
      }
      addRouteRecord(
        pathList,
        pathMap,
        nameMap,
        aliasRoute,
        parent,
        record.path || '/' // matchAs
      )
    }
  }

  // 路由名处理
  if (name) {
    // 建立name和record的映射，路由命名去重
    if (!nameMap[name]) {
      nameMap[name] = record
    } else if (process.env.NODE_ENV !== 'production' && !matchAs) {
      warn(
        false,
        `Duplicate named routes definition: ` +
          `{ name: "${name}", path: "${record.path}" }`
      )
    }
  }
}

// 生成一个匹配给定path的正则表达式
function compileRouteRegex (
  path: string,
  pathToRegexpOptions: PathToRegexpOptions
): RouteRegExp {
  // 生成一个匹配给定path的正则表达式，这个正则表达式用来匹配runtime中路由，比如忽视大小写，比如动态路由 /foo/:id ，可见不是 == 这么简单匹配。
  const regex = Regexp(path, [], pathToRegexpOptions)
  if (process.env.NODE_ENV !== 'production') {
    // 帮你去重，或者判断是否重复
    const keys: any = Object.create(null)
    regex.keys.forEach(key => {
      warn(
        !keys[key.name],
        `Duplicate param keys in route with path: "${path}"`
      )
      keys[key.name] = true
    })
  }
  return regex
}

// 生成各个层级下的完整path
function normalizePath (
  path: string,
  parent?: RouteRecord,
  strict?: boolean
): string {
  if (!strict) path = path.replace(/\/$/, '') //非严格下去掉尾部/
  if (path[0] === '/') return path
  if (parent == null) return path
  // 格式化下
  return cleanPath(`${parent.path}/${path}`)
}
