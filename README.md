# Taobao Invoice Helper

基于 Playwright 的淘宝 / 天猫订单发票辅助脚本，用来半自动完成订单扫描、发票申请、换开、下载和异常跟进。

这个项目的定位不是绕过平台限制的全自动机器人，而是把重复点击、状态判断和结果记录交给脚本处理，同时保留人工登录、人工验证和异常接管能力。

## 核心能力

- 按时间范围扫描淘宝 / 天猫订单，识别可申请、可下载、可换开和需人工处理的状态。
- 自动填写企业发票信息，并提交申请、换开或下载动作。
- 对超过开票期限、商家拒绝、资料缺失、补差金额等常见异常做分类处理。
- 对已联系商家的订单进行聊天回访，识别商家单独回复的发票附件或下载链接。
- 使用进度文件和台账避免重复处理，支持中断后继续运行。
- 遇到验证码、扫码、人机验证、付款确认等高风险动作时暂停，等待人工处理。
- 使用自适应限速、页面导航重试和单订单超时保护，降低长批次运行时卡住或被风控打断的概率。

## 版本选择

- 最新版本：[`v1.3.0`](https://github.com/CoolX01/taobao-invoice-helper/releases/tag/v1.3.0)，包含模块化辅助组件、页面导航重试、自适应限速、单订单超时保护和更轻量的进度文件。
- 上一稳定版：[`v1.2.0`](https://github.com/CoolX01/taobao-invoice-helper/releases/tag/v1.2.0)，包含错误分类增强、状态机、盘点报告、商家联系台账、聊天回访和新版测试脚本。
- 稳定功能版：[`v1.1.0`](https://github.com/CoolX01/taobao-invoice-helper/releases/tag/v1.1.0)，包含状态检查、修复和补处理脚本。
- 基础公开版：[`v1.0.0`](https://github.com/CoolX01/taobao-invoice-helper/releases/tag/v1.0.0)，保留最早公开发布的基础自动化能力。

详细更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 安装

```bash
npm install
```

## 配置

复制示例配置并填写公司抬头信息：

```bash
cp invoice-config.example.json invoice-config.json
```

`invoice-config.json` 用于保存本地发票抬头、税号、邮箱、电话、地址、开户行和银行账号等信息。

## 常用命令

只扫描和规划，不提交：

```bash
npm run plan -- --start-date=2025-01-01 --end-date=2025-12-31
```

按页面状态自动处理：

```bash
npm run execute:all -- --start-date=2025-01-01 --end-date=2025-12-31 --max-pages=60 --close-on-finish --results-csv=invoice-results.csv
```

回访已联系商家的聊天窗口：

```bash
npm run execute:chat -- --close-on-finish
```

生成只读盘点报告和拒绝原因分类：

```bash
npm run report:audit -- --write-contacted-ledger
```

调试订单列表显示内容：

```bash
npm run debug:order-list
```

调试单个订单开票页结构：

```bash
npm run debug:invoice-form -- --plan-file=invoice-action-progress.json --order-id=ORDER_ID_EXAMPLE
```

## 执行模式

`invoice-actions.js` 支持这些动作：

- `plan`：只识别和规划，不提交。
- `apply`：只处理“申请开票”。
- `reissue`：只处理“换开”。
- `download`：只处理“下载”。
- `chat`：只回访已联系商家的聊天窗口，识别商家单独回复的发票附件或链接。
- `all`：按页面状态自动决策。

真正执行提交或下载动作时需要显式确认：

```bash
--execute --confirm=YES_EXECUTE_TAOBAO_INVOICE_ACTIONS
```

如果不传 `--start-date` 和 `--end-date`，脚本默认处理“今年 1 月 1 日到今天”。

常用参数：

- `--results-csv=xxx.csv`：指定 CSV 结果表路径。
- `--max-retries=2`：可修正失败时最多重试次数。
- `--manual-timeout-ms=900000`：人工验证等待超时。
- `--force-contact`：强制重新联系商家。
- `--force-download`：强制再次下载。

## 状态和分类

主流程会记录每个订单的处理状态，方便中断后继续运行，也方便后续查看为什么某个订单被下载、换开、联系商家或交给人工处理。

常见状态包括：

- `CAN_APPLY` / `APPLYING` / `APPLIED_WAITING`：可申请、申请中、已提交待商家处理。
- `CAN_DOWNLOAD` / `DOWNLOADING` / `DOWNLOADED`：可下载、下载中、已下载。
- `NEED_REISSUE` / `REISSUING` / `REISSUED`：需要换开、换开中、已提交换开。
- `NEED_CONTACT_SELLER` / `CONTACTING_SELLER` / `CONTACTED_SELLER`：需要联系商家、联系中、已联系。
- `NEED_MANUAL_SECURITY_CHECK`：遇到登录、验证码、滑块、人机验证或风控。
- `NEED_MANUAL_PAYMENT_CONFIRM`：涉及真实付款，必须人工确认。
- `FAILED_RETRYABLE` / `FAILED_FINAL`：可重试失败 / 最终失败。

页面识别由 `error-classifier.js` 统一处理，当前覆盖可申请、可下载、信息不符、超期开票、商家拒绝、资料缺失、补差金额、聊天发票回复、订单异常、安全验证、下载异常等常见情况。

`v1.3.0` 起，部分通用能力已经拆到 `src/logger.js`、`src/rate-limiter.js` 和 `src/page-navigator.js`，后续补导航、日志或节流策略时会更容易维护。

## 已知限制

- 淘宝 / 天猫页面结构会变化，选择器需要持续维护。
- 个人票是否能换开，取决于订单页是否给出换开入口。
- 飞猪、特殊交易、备忘录页等非标准订单详情页，可能只能识别为跳过或人工处理。
- 自动提交只覆盖当前已识别的企业表单模板，建议先小批量测试后再扩大范围。
- 商家聊天窗口结构差异较大，部分场景仍可能回落到人工处理。
- 不会绕过验证码、扫码、人机验证；遇到这些情况会暂停等待人工完成。
- 不会自动付款；补差、支付、退款、授权类动作只会记录为待人工确认。

## 测试

```bash
npm run test:syntax
npm run test:classifier
```

## License

MIT
