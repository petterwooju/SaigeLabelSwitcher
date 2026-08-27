# SaigeVision Project Converter

SaigeVision V1 / V2 项目文件的纯浏览器双向转换 Webapp。项目、标注和图片只在用户浏览器本机读取与写入，不经过服务器。

> 当前发布：`v0.0.3`。本版本只开放经过真实样本验证的 `Classification` 和多边形 `Segmentation`；其他项目类型留待后续版本。

## 当前支持

已开放并经过真实样本与 round-trip 测试的项目类型：`Classification`、多边形 `Segmentation`（含多轮廓与孔洞）。

| 输入 | 可用输出 |
|---|---|
| V1 `.srproj` | V2 `.visionproj`、`.subvisionproj`、SVPA ZIP |
| V1 SVPA ZIP | V2 `.visionproj`、`.subvisionproj` |
| V2 `.visionproj` | V1 SVPA ZIP |
| V2 `.subvisionproj` | V1 `.srproj`、补图后的 SVPA ZIP |

`.visionproj` 与 SVPA ZIP 包含图片；`.subvisionproj` 与 `.srproj` 不包含图片。需要图片而源文件不带图时，页面会要求用户补充图片，并在 100% 唯一匹配后启用转换。

当前验证的图片格式为 PNG、JPEG、BMP、GIF 和 WebP。转换完整项目时会逐张校验格式、宽高和项目声明是否一致。若图片内容有效、尺寸一致，只是文件扩展名写错，`.visionproj` 和 SVPA ZIP 会保留原始图片字节，并在新包内改用与文件头一致的扩展名、同步更新引用；源项目与源图片不会被修改。损坏图片、未知格式或尺寸不一致仍会阻止写出。轻量 `.subvisionproj` / `.srproj` 不含图片，因此不会执行包内扩展名修复。

- 桌面版 Edge / Chrome：优先选择一个或多个图片目录。
- 不支持目录读取的内置浏览器：可选择保留原目录结构的图片 ZIP（包括本工具导出的 SVPA ZIP）。ZIP 图片按需读取，不会整包上传或一次性解压到内存。
- 直接多选图片文件只适用于文件名全局唯一的项目；存在 `000.png` 等同名图片时会主动阻断，避免把错误图片写入项目。

V1 的训练参数和数据增强参数目前没有经过验证的 V2 对应字段，因此不会写入 V2 项目；图片、类别、标注几何和 Training / Validation 划分不受影响。导入 V2 后请重新确认训练设置。

ROI 当前支持“未启用”和经过真实样本验证的 `Simple + Rectangle`：V1 的归一化 `X/Y/Width/Height` 会转换为 V2 的 `left/top/right/bottom`（V2 原始字段名仍为 `roiPosX/roiPosY/roiWidth/roiHeight`）。Advanced、Ellipse、Blind、非默认 ROI 设置及未知形状会明确阻断，绝不通过确认框静默丢弃。V1→V2 会按目标图像尺寸重建可编辑的矩形 `roiShape`；派生 `roiBitmap` 不伪造。生成结果已在目标 V2 完成 ROI 打开、显示与重新保存的实机验收。

Segmentation 当前支持 V1 `Contours` 与 V2 `labelContour` 多边形，按环方向保留 `Outer/Inner` 与孔洞。V2 浮点轮廓在写入 V1 时会按最近像素取整，并在去除取整产生的相邻重复点后重新校验点数、面积和方向；取整后退化的轮廓会明确阻断。bitmap-only mask、方向不明确的环、Detection、ROD、OCR 等尚未验证内容同样不会被静默转换。

浏览器安全处理边界为：V1 XML 项目文本 32 MiB、V2 JSON 项目文本 16 MiB，单个项目累计最多 500,000 个多边形轮廓点。超过边界时页面会明确说明项目规模暂不支持；这不代表源项目已经损坏，源文件也不会被修改。

## 本地运行

需要 Node.js 22.13 或更高版本。

```powershell
npm.cmd ci
npm.cmd run dev
```

打开终端显示的本地地址。建议使用最新版桌面 Edge 或 Chrome，以获得目录选择和大文件流式写盘支持。

## 发布

生产站点通过 GitHub Pages 从 `main` 分支自动构建和发布：
<https://saige-label-switcher-beta.saigeai.com/>。

该站点是公开静态页面，但项目文件、标注和图片仍只由浏览器本机读取与写入；应用没有项目上传接口、数据库或对象存储。上线时自定义域名的 DNS CNAME 目标为 `petterwooju.github.io`，与 `svpa-export-beta.saigeai.com` 使用相同的发布方式。

GitHub Pages 与上述自定义域名是正式生产发布的唯一来源。仓库保留 `.openai/hosting.json` 和 Vinext 配置，仅用于 Sites 兼容的备用预览/应急构建，不作为正式域名的发布链路。现有 Sites 备用部署可能落后于 `main`，属于陈旧备用环境，不能作为发布验收依据。

GitHub Pages 不能为单个仓库配置任意 HTTP 响应安全头；页面内保留 CSP `meta` 和 Referrer Policy 作为浏览器侧补充，但它们不等同于服务器响应头。若未来需要 HSTS、完整 CSP 等响应头门禁，应迁移到可控制响应头的静态托管服务，并单独完成安全评审。

发布 tag 必须使用 `vX.Y.Z`，与 `package.json` 完全一致并指向 Actions 实际检出的同一提交；CI 在 tag 事件中强制验证这三者，普通 `main`/PR 构建只做常规版本一致性验证。

## 验证

```powershell
npm.cmd run check
npm.cmd run test:pages
npm.cmd run test:e2e:prepared
npm.cmd run audit:dependencies
```

`check` 固定执行 typecheck、lint、单元/安全测试、全新生产构建和构建产物 SSR 测试。测试覆盖四格式内容识别、V1/V2 round-trip、原生 V2 2.7.8 fixture、SVPA/vision 容器、官方 SVPA 路径规则、图片目录匹配、图片真实性、ZIP/XML/JSON 资源限制、取消操作和大文件流式保存门禁。

`test:pages` 生成并核验 GitHub Pages 静态站点，包括正式域名元数据、当前 `APP_VERSION` 页面内容和路径修复助手的 SHA-256。

`test:e2e:prepared` 使用桌面 Chrome 加载刚生成的 `out` 静态产物，实际下载并回读 `.srproj` 与 `SVPA.zip`；请先运行 `test:pages`。也可运行 `npm.cmd run test:e2e` 一次完成静态构建和浏览器验收。

`audit:dependencies` 执行 npm 官方审计，并验证 Vinext 使用的 `image-size` 下游安全补丁与生产构建边界。当前审计结果为 0 个已知漏洞；补丁来源与回移说明见安全文档。

## 设计资料

- [MVP 产品与格式规格](docs/MVP_SPEC.md)
- [实施与验收计划](docs/IMPLEMENTATION_PLAN.md)
- [安全边界、依赖例外与发布凭据](docs/SECURITY.md)
- [第三方依赖、vendored 组件与许可证状态](THIRD_PARTY_NOTICES.md)

SVPA 包中的路径修复助手来自参考项目 `SaigeVision-v1-project-export`。应用在写入每个 SVPA 包之前会固定校验其大小和 SHA-256；当前固定值为 `A9831278CB21D6AFD627ABB55344545800829F2F5866AA34738609DD446F3A94`。应用不会执行输入 ZIP 中的任何可执行文件。

当前公开 beta 与公开源码仓库中的助手尚未取得可信 Authenticode 代码签名；固定哈希只能确认下载内容与本仓库发布物一致，不能证明发布者身份，Windows 或企业安全策略可能阻止运行。不得引导用户绕过 SmartScreen 或企业策略。组织签名和可信时间戳仍是稳定版或企业分发的发布阻断项；完成签名后还必须同步更新固定哈希与 CI 验签。该治理风险只在发布文档和流水线中处理，不重新增加普通转换页面警告。
