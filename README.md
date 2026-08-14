# SaigeVision Project Converter

SaigeVision V1 / V2 项目文件的纯浏览器双向转换 Webapp。项目、标注和图片只在用户浏览器本机读取与写入，不经过服务器。

## 当前支持

已开放并经过真实样本与 round-trip 测试的项目类型：`Classification`、多边形 `Segmentation`（含多轮廓与孔洞）。

| 输入 | 可用输出 |
|---|---|
| V1 `.srproj` | V2 `.visionproj`、`.subvisionproj`、SVPA ZIP |
| V1 SVPA ZIP | V2 `.visionproj`、`.subvisionproj` |
| V2 `.visionproj` | V1 SVPA ZIP |
| V2 `.subvisionproj` | V1 `.srproj`、补图后的 SVPA ZIP |

`.visionproj` 与 SVPA ZIP 包含图片；`.subvisionproj` 与 `.srproj` 不包含图片。需要图片而源文件不带图时，页面会要求用户补充图片，并在 100% 唯一匹配后启用转换。

当前验证的图片格式为 PNG、JPEG、BMP、GIF 和 WebP。转换完整项目时会逐张校验格式、宽高和项目声明是否一致；不匹配时阻止写出。

- 桌面版 Edge / Chrome：优先选择一个或多个图片目录。
- 不支持目录读取的内置浏览器：可选择保留原目录结构的图片 ZIP（包括本工具导出的 SVPA ZIP）。ZIP 图片按需读取，不会整包上传或一次性解压到内存。
- 直接多选图片文件只适用于文件名全局唯一的项目；存在 `000.png` 等同名图片时会主动阻断，避免把错误图片写入项目。

V1 的训练参数和数据增强参数目前没有经过验证的 V2 对应字段，因此不会写入 V2 项目；图片、类别、标注几何和 Training / Validation 划分不受影响。导入 V2 后请重新确认训练设置。`MaskingParameter = Not set` 会作为“未启用遮罩”处理，不再显示为兼容性警告。

Segmentation 当前支持 V1 `Contours` 与 V2 `labelContour` 多边形，按环方向保留 `Outer/Inner` 与孔洞；bitmap-only mask、退化/方向不明确的环会明确阻断。Detection、ROD、OCR 等尚未验证类型仍会明确阻断，不会“尽力转换”或静默丢弃标注。

## 本地运行

```powershell
npm.cmd install
npm.cmd run dev
```

打开终端显示的本地地址。建议使用最新版桌面 Edge 或 Chrome，以获得目录选择和大文件流式写盘支持。

## 验证

```powershell
npm.cmd run check
npm.cmd run audit:dependencies
```

`check` 固定执行 typecheck、lint、单元/安全测试、全新生产构建和构建产物 SSR 测试。测试覆盖四格式内容识别、V1/V2 round-trip、原生 V2 2.7.8 fixture、SVPA/vision 容器、官方 SVPA 路径规则、图片目录匹配、图片真实性、ZIP/XML/JSON 资源限制、取消操作和大文件流式保存门禁。

`audit:dependencies` 执行 npm 官方审计，并验证 Vinext 使用的 `image-size` 下游安全补丁与生产构建边界。当前审计结果为 0 个已知漏洞；补丁来源与回移说明见安全文档。

## 设计资料

- [MVP 产品与格式规格](docs/MVP_SPEC.md)
- [实施与验收计划](docs/IMPLEMENTATION_PLAN.md)
- [安全边界、依赖例外与发布凭据](docs/SECURITY.md)

SVPA 包中的路径修复助手来自参考项目 `SaigeVision-v1-project-export`。应用在写入每个 SVPA 包之前会固定校验其大小和 SHA-256；当前固定值为 `A9831278CB21D6AFD627ABB55344545800829F2F5866AA34738609DD446F3A94`。应用不会执行输入 ZIP 中的任何可执行文件。

当前助手尚未取得可信 Authenticode 代码签名。内部/私有发布可通过上述哈希核验；公开或企业分发前仍需使用组织的代码签名证书和可信时间戳重新签名，并同步更新固定哈希。这是发布凭据事项，不应通过让用户绕过 SmartScreen 来处理。
