# Third-Party Notices

本清单对应 SaigeVision Project Converter `v0.0.3`。版本以 `package-lock.json` 为准；锁文件也是全部间接依赖的可复现清单。这里列出正式 GitHub Pages 构建直接使用的生产依赖，以及仓库中随源代码或导出包分发的特殊 vendored 组件。

## 根项目许可证状态

仓库根目录目前没有 `LICENSE`。SaigeVision Project Converter 自有源代码采用何种许可证，仍需仓库所有者明确决定；本文件不授予根项目代码的使用、复制或再分发许可，也不把任何第三方许可证推定为根项目许可证。

## 直接生产依赖

| 组件 | 固定版本 | 用途 | 许可证 / 上游 |
|---|---:|---|---|
| `next` | `16.3.3` | GitHub Pages 静态构建与应用框架 | MIT；Copyright © Vercel, Inc.；<https://github.com/vercel/next.js> |
| `react` | `19.2.8` | 浏览器 UI runtime | MIT；Copyright © Meta Platforms, Inc. and affiliates；<https://github.com/facebook/react> |
| `react-dom` | `19.2.8` | 浏览器 DOM renderer | MIT；Copyright © Meta Platforms, Inc. and affiliates；<https://github.com/facebook/react> |
| `@zip.js/zip.js` | `2.8.60` | 浏览器内 ZIP/ZIP64 读取与流式写入 | BSD-3-Clause；Copyright © 2023 Gildas Lormeau；<https://github.com/gildas-lormeau/zip.js> |

这些包及其间接依赖的许可证文本随 npm 包提供。任何发布审计都应同时以锁文件和实际安装树为准，不能只依赖本摘要。

## Vendored 安全分支：`image-size`

- 仓库文件：`vendor/image-size-2.0.3-saige.2.tgz` 与 `vendor/image-size-safe/`。
- 版本：`2.0.3-saige.2`，从上游 `image-size@2.0.2` 做的窄范围安全回移。
- 许可证：MIT；Copyright © 2013–Present Aditya Yadav。
- 上游：<https://github.com/image-size/image-size>。
- 变更：为 ICNS、HEIF、JXL 解析循环增加无进度/非法尺寸拒绝；细节见 `vendor/image-size-safe/SECURITY-PATCH.md`。
- 使用范围：仅供 Vinext/Sites 备用构建链锁定其间接依赖；GitHub Pages 浏览器产物和当前 Worker server bundle 不包含这些解析器。

上游发布覆盖相关安全问题的正式版本后，应移除本地分支并重新完成依赖、构建产物和许可证审计。

## 随包分发的路径修复助手

`public/downloads/SaigeVisionProjectAssistant.ZipFixer.exe` 是从本机参考项目 `SaigeVision-v1-project-export` 复用的 Windows x64 NativeAOT 辅助程序，并会复制到完整 SVPA ZIP。当前仓库固定的 SHA-256 为：

```text
A9831278CB21D6AFD627ABB55344545800829F2F5866AA34738609DD446F3A94
```

该参考项目和本仓库均未附带助手的独立许可证或源代码授权声明，因此不能把它标记为某个开源第三方许可证。仓库所有者必须确认该二进制的所有权与再分发授权；这一确认与根项目许可证选择都是外部决策项。

助手目前也没有 Authenticode 组织签名或可信时间戳。固定哈希只验证字节一致性，不验证发布者身份；组织签名、可信时间戳及相应 CI 验签仍是稳定版和企业分发的发布阻断项。

## 许可证文本

### MIT（Next.js、React、React DOM、image-size）

适用版权声明：

- Copyright (c) 2025 Vercel, Inc.
- Copyright (c) Meta Platforms, Inc. and affiliates.
- Copyright © 2013-Present Aditya Yadav, <http://netroy.in>

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### BSD-3-Clause（zip.js）

Copyright (c) 2023, Gildas Lormeau

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice,
> this list of conditions and the following disclaimer.
>
> 2. Redistributions in binary form must reproduce the above copyright notice,
> this list of conditions and the following disclaimer in the documentation
> and/or other materials provided with the distribution.
>
> 3. Neither the name of the copyright holder nor the names of its contributors
> may be used to endorse or promote products derived from this software without
> specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.
