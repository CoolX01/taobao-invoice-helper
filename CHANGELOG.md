# Changelog

## v1.2.0

这个版本对应脚本脱敏处理后的当前版本，重点是降低公开仓库里的敏感信息风险，并补齐更完整的错误分类、盘点和聊天回访能力。

### Added

- 新增 `error-classifier.js`，集中管理发票状态、拒绝原因、补差、安全验证、聊天回复等分类规则。
- 新增 `order-state-machine.js`，为订单处理流程记录更明确的状态和状态轨迹。
- 新增 `invoice-audit-report.js`，支持生成只读盘点报告和联系商家台账。
- 新增 `test-error-classifier.js`、`test-rejection-classifier.js`、`test-chat-reply-classifier.js`，覆盖主要分类规则。
- 新增商家聊天回访流程，支持识别聊天中的发票附件、链接和补资料要求。

### Changed

- 完成脚本脱敏处理，示例配置、测试用例、README 命令示例和脚本输出避免暴露真实订单号、税号、公司信息等敏感内容。
- 扩展 `.gitignore`，继续排除登录态、下载件、快照、台账、结果 CSV 和本地运行数据。
- 更新 `invoice-actions.js`，增强状态机、错误分类、联系商家、防重复下载和人工验证等待逻辑。
- 更新 `README.md`，补充新版入口、执行参数、状态机、错误分类规则和版本选择说明。
- 将项目版本号更新为 `1.2.0`，并保持 MIT License 元信息一致。

### Choose This Version If

- 你希望使用当前最新、适合公开仓库分发的脱敏版本。
- 你需要更完整的错误分类、盘点报告、商家联系台账和聊天回访能力。
- 你希望基于测试脚本继续补规则或二次开发。

## v1.1.0

这个版本是一次较大的脚本能力更新，重点增强发票状态检查、异常修复和补处理能力。

### Added

- 新增 `repair-paper-invoices.js`，用于处理纸质票相关修复流程。
- 新增 `repair-pending-invoices.js`，用于处理待修复 / 待补处理发票。
- 新增 `status-check-current.js`，用于检查当前订单或发票处理状态。
- 新增 `status-check-invoice-page.js`，用于检查发票页面状态。
- 新增 `inspect-invoice-history.js`，用于检查发票历史记录。
- 新增 `debug-download-entry.js`，用于调试下载入口。

### Changed

- 大幅更新 `invoice-actions.js` 的自动化处理逻辑。
- 更新 README、示例配置、npm 脚本和语法检查范围。

## v1.0.0

首个公开版本，适合作为基础稳定版本保留。

### Included

- 基于 Playwright 的淘宝 / 天猫订单发票辅助脚本。
- 支持订单扫描、发票规划、申请开票、换开与下载。
- 支持进度文件断点续跑。
- 提供 `debug-order-list.js` 和 `debug-invoice-form.js` 调试脚本。
- 提供示例配置 `invoice-config.example.json`。
- 使用 MIT License。
