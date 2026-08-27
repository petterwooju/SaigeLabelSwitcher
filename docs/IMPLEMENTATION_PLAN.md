# SaigeVision 项目双向转换器 — 实施与验收计划

> v0.0.3 发布范围（2026-08-27）：Classification 与多边形 Segmentation 的四格式解析、双向 Writer、流式容器、安全门禁和单页 UI 已完成。Segmentation 已用真实 V1 contour 样本、原生 V2 `.visionproj/.subvisionproj` 对照包及生成项目 round-trip 验证；No ROI 与 Simple Rectangle ROI 已完成字段级双向映射，生成的 V2 编辑态 `roiShape` 也已通过目标版本的打开、显示与重新保存实机验收。Detection 及其他类型继续保持阻断，留待后续版本。

## 建议代码结构

```text
app/
components/
  ProjectConverter.tsx
lib/
  input/
    detectInput.ts
    srprojAdapter.ts
    svpaZipAdapter.ts
    visionprojAdapter.ts
    subvisionprojAdapter.ts
  model/
    projectIR.ts
    imageSource.ts
    compatibilityReport.ts
  images/
    directoryPicker.ts
    imageResolver.ts
    imageMetadata.ts
  convert/
    v1ProjectBuilder.ts
    v2ProjectBuilder.ts
    classificationMapper.ts
    detectionMapper.ts
    segmentationMapper.ts
  output/
    srprojWriter.ts
    svpaZipWriter.ts
    visionprojWriter.ts
    subvisionprojWriter.ts
    saveTarget.ts
  security/
    archiveValidation.ts
    pathValidation.ts
tests/
  fixtures/
    classification/
      source-v1.srproj
      source-v1-svpa.zip
      native-v2.visionproj
      native-v2.subvisionproj
      expected-ir.json
  unit/
  golden/
  roundtrip/
  browser/
```

## 推荐开发批次

1. **Classification 四件套 fixtures**：从同一个语义项目得到 V1 `.srproj`、SVPA ZIP、V2 两种导出，并记录实机统计。
2. **格式探针与 canonical IR**：完成四种输入解析、容器验证、允许差异清单和 round-trip 比较器。
3. **输入统一化**：四种 InputAdapter 统一输出 `ProjectIR + ImageSource + CompatibilityReport`。
4. **保留现有 V1 ZIP 能力**：迁移目录匹配、manifest、ZipFixer、ZIP64 流式保存并通过旧包兼容测试。
5. **Classification V1→V2**：打通两种 V2 Writer 和目标 V2 导入。
6. **Classification V2→V1**：打通 `.srproj` / SVPA ZIP、路径策略、降级报告和目标 V1 导入。
7. **极简单页 UI**：自动识别输入，动态显示合法输出，按需补图并确认兼容性降级。
8. **Segmentation / Detection**：Segmentation 多边形与孔洞已建立 native schema 和 round-trip 门禁；Detection 待独立 golden 后启用。
9. **大文件与安全硬化**：ZIP64、流式 ZIP→ZIP、ZIP bomb/穿越/冲突、磁盘中断和取消。

## 首个开发迭代完成定义

- 页面能够识别四种扩展名、magic 与 schema，并显示版本和项目摘要。
- 四种 InputAdapter 对 Classification / Segmentation fixture 产生一致的 canonical `ProjectIR`。
- `.srproj` 可补选图片并生成兼容现有工具的 SVPA ZIP。
- `.visionproj` 可直接生成 V1 SVPA ZIP；修复后由目标 V1 打开。
- `.subvisionproj` 可生成 `.srproj`，或补选图片生成 SVPA ZIP。
- Classification 与多边形 Segmentation 可在两代格式间往返；canonical IR 只出现规格允许的差异。
- 所有丢弃、重建、降级和阻断字段均进入报告，不静默处理。
- 自动测试覆盖正常、缺图、歧义、损坏 ZIP、路径穿越、未知 V2 标签、多 dataset、取消保存和大文件流式路径。

## 应复用的参考实现

- `lib/srproj.ts`：V1 摘要解析、路径规范化和最长尾路径匹配。
- `lib/directoryPicker.ts`：浏览器目录授权及递归读取。
- `lib/packagePreparation.ts`：在用户手势仍有效时先取得保存目标。
- `lib/zipPackage.ts`：ZIP64、流式写盘、Blob 回退、图片 STORE 和进度。
- `components/ProjectPackager.tsx`：拖放、状态、多语言和问题列表。

这些代码只作为文件处理底座。完整 V1 XML parser、V2 JSON parser、双向 builder 和兼容性分析必须是独立模块。
