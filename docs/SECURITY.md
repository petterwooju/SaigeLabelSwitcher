# 安全发布说明

## 当前边界

- 项目文件、标注和图片只在浏览器中读取、解析和写出；Worker 仅提供页面与静态资源。
- ZIP、XML、JSON、路径、数量、深度、解压后字节数及图片尺寸均有门禁；完整输出使用可取消的流式读写。
- SVPA 路径修复助手在打包前固定校验大小与 SHA-256，应用不会执行输入包中的程序。

## 上游 image-size 安全补丁

截至 2026-08-14，`vinext@1.0.0-beta.2` 原本固定依赖 `image-size@2.0.2`。GitHub 的两个高危拒绝服务公告覆盖该版本，且都明确标注“无已修复版本”：

- `GHSA-w3rx-r6r6-pgpr`：ICNS 解析循环。
- `GHSA-5p2g-fcmc-qvqq`：JXL/HEIF 解析循环。

本仓库提供可审阅的 `vendor/image-size-safe` 下游补丁，并以本地 tarball 覆盖 Vinext 的间接依赖：

- ICNS 条目长度小于头部时立即拒绝；
- HEIF `ispe` box 尺寸无效或无法推进偏移时立即拒绝；
- JXL `jxlp` box 尺寸无效或无法推进偏移时立即拒绝。

三个官方/公开 PoC 路径均在独立子进程内测试，回归时即使再次出现死循环也会在 2 秒超时后失败，而不会挂死测试套件。覆盖后 `npm audit` 为 0。

固定 tarball：`vendor/image-size-2.0.3-saige.2.tgz`（SHA-256 `D1A78990B854CB3E7D872F7B09858293A962A1A2A87D49FC9BB5E9C72EC7BFD4`）。`package-lock.json` 另含 npm integrity 校验。

应用仍不使用 Vinext 图片优化端点，也没有文件式图片 metadata route；用户选择的项目图片不会进入 Worker。生产构建中不包含上述解析器。`npm run audit:dependencies` 同时验证：

1. npm 官方审计没有任何漏洞；
2. Vinext 和下游修复包的锁定版本没有悄然变化；
3. 图片优化端点没有重新启用；
4. 已知相关解析器没有进入 `dist/server`。

上游发布修复版本后，应升级依赖并删除下游补丁；不要使用 npm 建议的 Vinext `0.0.45` 强制降级。

## 仍需发布凭据处理的事项

`public/downloads/SaigeVisionProjectAssistant.ZipFixer.exe` 当前没有 Authenticode 签名，本机也没有可用的组织代码签名证书。内部、所有者私有部署可依赖固定 SHA-256 检查；面向公众或企业分发前必须：

1. 使用组织证书签名；
2. 添加可信时间戳；
3. 更新 `.sha256`、代码中的固定摘要和测试；
4. 在 Windows CI 中验证签名发布者与时间戳。

不得引导用户绕过 SmartScreen 或企业安全策略。
