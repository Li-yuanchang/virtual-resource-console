# 项目协作规范

## UI 原型实现限制

1. 所有 UI 原型必须统一使用纯 HTML、CSS 和原生 JavaScript 实现，入口文件放在 `apps/web/*-prototype.html`。
2. 禁止为原型新增 Vue 组件、`*-prototype.ts` 挂载入口、Vue Router 路由或 Element Plus 运行时依赖。
3. 原型可以直接引用 `apps/web/src/styles.css` 中的 VRC 设计变量，并优先复用 `apps/web/public/prototype-base.css` 和 `prototype-base.js`。
4. 原型使用的 CSS、JavaScript、图片和字体必须采用相对路径，保证通过 Vite HTTP 地址和 `file://` 直接打开时都能正常加载。
5. 页面专属样式和交互应保留在对应 HTML 或 `apps/web/public` 下的同名静态文件中，不得让正式业务组件依赖原型文件。
6. 完成原型后必须运行 `npm run check:prototypes`，并检查布局、交互、图片、控制台错误和窄屏溢出。
7. 原型方案确认后，应将设计明确还原到正式业务组件；不得直接把原型文件作为生产功能入口。

## 桌面托盘交互规则

1. macOS 状态栏图标点击不得直接显示主界面，用户需要通过托盘菜单的“显示主界面”进入主窗口；状态栏点击触发的 `app.activate` 事件也必须被隐藏态拦截，不能间接 show 主窗口。
2. Windows 托盘图标左键点击应直接显示主界面，菜单仍通过系统托盘上下文菜单入口展示，符合 Windows 常见操作习惯。
3. 默认托盘菜单只保留 4 项：`显示主界面`、`打开 Web 界面`、`查看日志文件`、`退出`；新增菜单项必须先确认需求。
4. macOS 点击窗口红绿灯的关闭按钮时，只隐藏主窗口和 Dock 图标，应用继续保留在状态栏运行；只有执行“退出”才关闭应用和后台 Node 服务。
5. 未经明确确认，不得把 macOS 与 Windows 的托盘点击行为统一成同一套逻辑。
