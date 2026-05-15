# Taobao Invoice Helper

基于 Playwright 的淘宝 / 天猫订单发票辅助脚本。

这个项目的目标不是“无脑全自动”，而是在保留人工登录和人工兜底能力的前提下，把下面几类重复动作尽量自动化：

- 扫描订单列表，识别指定时间范围内的订单
- 判断订单当前是否可下载、可申请开票、可换开
- 对企业票执行自动填写和提交
- 对已可下载的发票执行自动下载
- 对个人票优先尝试换开，不能换开时保留为下载或人工处理
- 对“超过开票期限”订单自动联系商家，且避免重复发送
- 对验证码 / 扫码 / 人机验证暂停，等待人工完成后继续
- 通过进度文件断点续跑，避免每次从头来

## 当前入口

主脚本：

- `invoice-actions.js`

调试脚本：

- `debug-order-list.js`：核对订单列表实际显示内容、分页和筛选状态
- `debug-invoice-form.js`：打开某个订单的开票 / 换开页并导出控件结构，不提交表单

归档脚本：

- `archive/check-invoices-detail-recoverable.js`
- `archive/check-invoices-detail-extended.js`
- `archive/check-invoices-detail-basic.js`
- `archive/check-invoices-prototype.js`

这些归档脚本保留在仓库里，方便回看演进过程，但新功能默认以 `invoice-actions.js` 为准。

## 安装

```bash
npm install
```

## 配置

复制示例配置并填写公司抬头信息：

```bash
cp invoice-config.example.json invoice-config.json
```

`invoice-config.json` 已加入 `.gitignore`，不要提交真实税号、地址、银行账户等敏感信息。

## 常用命令

只做规划，不提交：

```bash
npm run plan -- --start-date=2025-01-01 --end-date=2025-12-31
```

执行自动处理：

```bash
npm run execute:all -- --start-date=2025-01-01 --end-date=2025-12-31 --max-pages=60 --close-on-finish --results-csv=invoice-results.csv
```

测试前几个订单：

```bash
npm run test:actions
```

检查订单列表实际显示内容：

```bash
npm run debug:order-list
```

检查单个订单开票页结构：

```bash
npm run debug:invoice-form -- --plan-file=invoice-action-progress.json --order-id=ORDER_ID_EXAMPLE
```

## 执行模式说明

`invoice-actions.js` 支持这些动作：

- `plan`：只识别，不提交
- `apply`：只处理“申请开票”
- `reissue`：只处理“换开”
- `download`：只处理“下载”
- `all`：按页面状态自动决策

执行结果会同时输出：

- JSON 结果：默认跟 `--output` 同名
- CSV 结果表：默认跟 `--output` 同名 `.csv`

执行模式需要显式确认：

```bash
--execute --confirm=YES_EXECUTE_TAOBAO_INVOICE_ACTIONS
```

如果不传 `--start-date` 和 `--end-date`，脚本默认处理“今年 1 月 1 日到今天”。

可选参数：

- `--results-csv=xxx.csv`：指定 CSV 结果表路径
- `--max-retries=2`：可修正失败时最多重试次数
- `--manual-timeout-ms=900000`：人工验证等待超时

## 项目特点

- 使用持久化浏览器目录复用登录态
- 同一轮处理结束后自动关闭额外标签页，避免越跑越多
- 支持下载、提交、处理中、跳过等状态落盘
- 支持 `seller_contacted`、`manual_required`、`expired_deadline` 等更细的执行状态
- 支持中断后从进度文件恢复
- 对旧版开票页面做了兼容
- 对“超过开票日期”类提示增加了同月提前截断逻辑，减少无效尝试
- 对真实下载文件自动清理文件名，且遇到重名文件自动加序号

## 本地运行产物

以下内容默认不会进入 GitHub：

- `.playwright-browser/`
- `invoice-config.json`
- `downloads/`
- `invoice-action*.json`
- `progress*.json`
- `debug-*.json`
- `debug-*.png`
- `debug-*.html`

也就是说，这个仓库默认只提交脚本和文档，不提交你的登录态、公司配置、下载件和运行过程数据。

## 已知限制

- 淘宝 / 天猫页面结构会变化，选择器需要持续维护
- 个人票是否能换开，取决于订单页是否给出换开入口
- 飞猪、特殊交易、备忘录页等非标准订单详情页，可能只能识别为跳过或人工处理
- “自动提交”只覆盖当前已识别的企业表单模板，仍然建议先小批量测试
- 商家聊天窗口结构差异较大，`联系商家` 已做兜底，但仍可能回落到人工处理
- 不会绕过验证码、扫码、人机验证；遇到这些情况会暂停等待人工完成

## 发布前建议

- 只提交脚本、`README.md`、`package.json`、`package-lock.json`、`invoice-config.example.json`、`.gitignore`
- 不提交任何真实配置、浏览器状态、下载件和运行结果
- 在新环境先用 `npm run test:actions` 小批量验证
