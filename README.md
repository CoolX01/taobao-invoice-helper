# Taobao Invoice Helper

基于 Playwright 的淘宝 / 天猫订单发票辅助脚本。

这个项目的目标不是“无脑全自动”，而是在保留人工登录和人工兜底能力的前提下，把下面几类重复动作尽量自动化：

- 扫描订单列表，识别指定时间范围内的订单
- 判断订单当前是否可下载、可申请开票、可换开
- 对企业票执行自动填写和提交
- 对已可下载的发票执行自动下载
- 对个人票优先尝试换开，不能换开时保留为下载或人工处理
- 对“超过开票期限”订单自动联系商家，且避免重复发送
- 对已联系商家但发票不回写到淘宝发票页的订单，回访聊天窗口并识别/下载商家单独回复的发票附件或链接
- 对验证码 / 扫码 / 人机验证暂停，等待人工完成后继续
- 通过进度文件断点续跑，避免每次从头来

## 版本选择

- 最新版本：[`v1.2.0`](https://github.com/CoolX01/taobao-invoice-helper/releases/tag/v1.2.0)，包含错误分类增强、状态机、盘点报告、商家联系台账、聊天回访和新版测试脚本。
- 稳定功能版：[`v1.1.0`](https://github.com/CoolX01/taobao-invoice-helper/releases/tag/v1.1.0)，包含状态检查、修复和补处理脚本。
- 基础公开版：[`v1.0.0`](https://github.com/CoolX01/taobao-invoice-helper/releases/tag/v1.0.0)，保留最早公开发布的基础自动化能力。

详细更新记录见 [CHANGELOG.md](CHANGELOG.md)。

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

`invoice-config.json` 已加入 `.gitignore`，不要提交真实税号、地址、银行账户等个人配置。

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

生成只读盘点报告和拒绝原因分类：

```bash
npm run report:audit -- --write-contacted-ledger
```

回访已联系商家的聊天窗口，处理商家单独回复的发票：

```bash
npm run execute:chat -- --close-on-finish
```

只回访指定订单：

```bash
npm run execute:chat -- --order-id=ORDER_ID_EXAMPLE --close-on-finish
```

## 执行模式说明

`invoice-actions.js` 支持这些动作：

- `plan`：只识别，不提交
- `apply`：只处理“申请开票”
- `reissue`：只处理“换开”
- `download`：只处理“下载”
- `chat`：只回访已联系商家的聊天窗口，识别商家单独回复的发票附件/链接
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
- `--contacted-ledger=contacted-orders.json`：联系商家防重复台账
- `--downloaded-ledger=downloaded-invoices.json`：下载防重复台账
- `--modified-ledger=modified-orders.json`：修改/换开防重复台账
- `--chat-reply-ledger=seller-chat-replies.json`：商家聊天回访台账
- `--snapshot-dir=snapshots`：异常截图 / HTML / 文本快照目录
- `--force-contact`：忽略台账，强制重新联系商家
- `--force-download`：忽略下载台账，强制再次下载

## 状态机

主流程会给每个订单记录 `state` 和 `stateTrace.events`，中断后可通过进度文件续跑。

核心状态：

- `PENDING`：待处理
- `CHECKING`：正在打开订单页并识别状态
- `CAN_APPLY` / `APPLYING` / `APPLIED_WAITING`：可申请、申请中、已提交待商家处理
- `CAN_DOWNLOAD` / `DOWNLOADING` / `DOWNLOADED`：可下载、下载中、已下载
- `NEED_REISSUE` / `REISSUING` / `REISSUED`：需要换开、换开中、已提交换开
- `NEED_CONTACT_SELLER` / `CONTACTING_SELLER` / `CONTACTED_SELLER`：需要联系商家、联系中、已联系
- `NEED_PRICE_DIFF_CONFIRM`：识别到补差/金额差异，等待用户确认
- `NEED_MANUAL_SECURITY_CHECK`：登录、验证码、滑块、人机验证或风控，等待人工处理
- `NEED_MANUAL_PAYMENT_CONFIRM`：涉及真实付款，必须人工确认
- `FAILED_RETRYABLE` / `FAILED_FINAL`：可重试失败 / 最终失败

## 错误分类规则

页面识别由 `error-classifier.js` 统一处理，会综合页面正文、弹窗文案、按钮/链接候选、URL、发票信息和历史原因。当前规则覆盖：

| 分类 | 典型文案/信号 | 默认处理 |
| --- | --- | --- |
| 可申请 | 申请开票、开具发票、未开票 | 自动申请 |
| 可下载 | 已开票、下载发票、查看发票 | 自动下载 |
| 信息不符 | 个人票、抬头像税号、公司名/税号不匹配 | 修改申请或换开，无入口则联系商家 |
| 超期开票 | 订单超过可开票期限、超过开票日期 | 联系商家 |
| 商家拒绝 | 商家拒绝、审核不通过、申请失败 | 读取申请历史后分类处理 |
| 缺资料/邮箱 | 请补充信息、未提供邮箱、资料不完整 | 修改申请或联系商家 |
| 补差/金额差异 | 补差、差价、金额不符 | 记录金额和原因，不自动付款 |
| 聊天发票回复 | 聊天中出现 PDF/OFD/图片/压缩包/发票下载链接 | 自动尝试下载，并写入下载台账 |
| 聊天补充要求 | 商家在聊天里要求补邮箱、抬头、税号、资料 | 分类记录为需人工或后续补充规则处理 |
| 发票类型不支持 | 不支持开具、不能开专票 | 联系商家或最终失败 |
| 订单异常 | 订单不存在、已关闭、已退款 | 跳过并记录 |
| 安全验证 | 验证码、滑块、人机验证、风控 | 暂停等待人工 |
| 下载异常 | 下载失败、下载链接失效、文件已存在 | 重试、跳过或记录 |
| 未知错误 | 无法匹配规则 | 保存截图、HTML、页面文本，方便补规则 |

## 项目特点

- 使用持久化浏览器目录复用登录态
- 同一轮处理结束后自动关闭额外标签页，避免越跑越多
- 支持下载、提交、处理中、跳过等状态落盘
- 支持 `seller_contacted`、`manual_required`、`expired_deadline` 等更细的执行状态
- 支持状态机和错误分类规则，输出命中规则、页面原始提示、补差金额、截图/HTML 快照路径
- 支持只读生成总盘点报告和商家拒绝原因分类报告
- 支持独立联系商家台账，避免重复发送旺旺消息
- 支持独立下载台账，避免重复下载同一订单发票
- 支持独立修改/换开台账，避免已提交修正后再次重复换开或联系商家
- 支持独立商家聊天回访台账，处理淘宝发票页不展示、但商家在聊天里单独回复发票的场景
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
- `snapshots/`
- `downloaded-invoices*.json`
- `seller-chat-replies*.json`
- `seller-chat-followup*.json`

也就是说，这个仓库默认只提交脚本和文档，不提交你的登录态、公司配置、下载件和运行过程数据。

## 已知限制

- 淘宝 / 天猫页面结构会变化，选择器需要持续维护
- 个人票是否能换开，取决于订单页是否给出换开入口
- 飞猪、特殊交易、备忘录页等非标准订单详情页，可能只能识别为跳过或人工处理
- “自动提交”只覆盖当前已识别的企业表单模板，仍然建议先小批量测试后再扩大范围
- 商家聊天窗口结构差异较大，`联系商家` 已做兜底，但仍可能回落到人工处理
- 商家聊天回访只能处理网页聊天里能读取到的文本、附件和链接；如果商家只通过外部客户端、图片二维码或口头说明处理，仍会记录为需人工确认
- 不会绕过验证码、扫码、人机验证；遇到这些情况会暂停等待人工完成
- 不会自动付款；补差、支付、退款、授权类动作只会记录为待人工确认
- OCR 结果字段已预留，但仓库没有内置 OCR 引擎；后续可接入本地 OCR 后把识别文本传给分类器

## 测试

```bash
npm run test:syntax
npm run test:classifier
```

新增规则时，优先补 `test-error-classifier.js` 的纯文本用例，再跑上面的测试。

## 后续补规则方式

1. 在异常订单的 `snapshots/` 中查看 `.txt` 或 `.html`。
2. 把稳定文案加入 `error-classifier.js` 的 `ERROR_RULES`。
3. 如果是金额类提示，优先补 `extractPriceDiff()` 的测试。
4. 如果是新动作入口，补 `ACTION_KEYWORDS` 或 `collectActionCandidates()` 的兜底选择器。
5. 小批量运行 `npm run execute:all -- --test=3 --fresh --close-on-finish` 验证。

## 发布前建议

- 只提交脚本、`README.md`、`package.json`、`package-lock.json`、`invoice-config.example.json`、`.gitignore`
- 不提交任何真实配置、浏览器状态、下载件和运行结果
- 在新环境先用 `npm run test:actions` 小批量验证
