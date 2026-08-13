# SaigeVision Project Converter

SaigeVision V1 / V2 项目文件的纯浏览器双向转换 Webapp。项目、标注和图片只在用户浏览器本机读取与写入，不经过服务器。

## 当前支持

已开放并经过真实样本与 round-trip 测试的项目类型：`Classification`。

| 输入 | 可用输出 |
|---|---|
| V1 `.srproj` | V2 `.visionproj`、`.subvisionproj`、SVPA ZIP |
| V1 SVPA ZIP | V2 `.visionproj`、`.subvisionproj` |
| V2 `.visionproj` | V1 SVPA ZIP |
| V2 `.subvisionproj` | V1 `.srproj`、补图后的 SVPA ZIP |

`.visionproj` 与 SVPA ZIP 包含图片；`.subvisionproj` 与 `.srproj` 不包含图片。需要图片而源文件不带图时，页面会要求用户授权一个或多个图片目录，并在 100% 唯一匹配后启用转换。

Detection、Segmentation、ROD、OCR 等类型会明确阻断，不会“尽力转换”或静默丢弃标注。

## 本地运行

```powershell
npm.cmd install
npm.cmd run dev
```

打开终端显示的本地地址。建议使用最新版桌面 Edge 或 Chrome，以获得目录选择和大文件流式写盘支持。

## 验证

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

测试覆盖四格式内容识别、V1/V2 round-trip、SVPA/vision 容器、官方 SVPA 路径规则、图片目录匹配、图片尺寸探测、ZIP 安全、XML 安全和大文件保存门禁。

## 设计资料

- [MVP 产品与格式规格](docs/MVP_SPEC.md)
- [实施与验收计划](docs/IMPLEMENTATION_PLAN.md)

SVPA 包中的路径修复助手来自参考项目 `SaigeVision-v1-project-export`，构建时作为静态资源打包；应用不会执行输入 ZIP 中的任何可执行文件。
