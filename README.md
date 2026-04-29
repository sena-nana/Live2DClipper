# Live2D Clipper

一个 Vue 3 + TypeScript 的 Live2D 立绘拆分工作台原型，视觉风格参考 Linear：深色中性界面、紧凑工具栏、细边框状态反馈。软件用于根据用户维护的图层树，把原始立绘拆分为可审核、可导出的图层结果。

## 当前能力

- 左侧图层树：新增图层/分组、重命名、部件类型、隐藏、单独显示、上移、下移、缩进、提升。
- 右侧预览：原图、RGBA 结果、Alpha 蒙版、背景版本预览。
- 审核流：图层结构修改后进入 `dirty`，点击生成后锁定编辑，生成结果进入 `pendingReview`，确认后写入已应用图层。
- 三档生图拆分：估算、标准、精确。
- 内置 Live2D 拆分提示词，并按头发、脸部、眼睛、服装、肢体、饰品、阴影、特效等部件类型优化。
- PSD 导出：基于 `ag-psd` 输出已确认图层。
- OpenAI 兼容接口：通过设置面板配置 Base URL、API Key、生图模型和 LLM 模型。

## 三档算法

### 估算

- 生成数量：1 张。
- 背景：高频棋盘/检查背景。
- 透明度：不支持真实透明，输出不透明 RGBA，仅作为快速拆层和边界检查。
- 用途：低成本草稿、纯不透明部件、快速验证图层树。

### 标准

- 生成数量：2 张。
- 背景：纯黑 `#000000`、纯白 `#FFFFFF`。
- 算法：black-white matting。
- 公式：

```text
C1 = alpha * F + (1 - alpha) * B1
C2 = alpha * F + (1 - alpha) * B2
alpha = 1 - dot(C1 - C2, B1 - B2) / dot(B1 - B2, B1 - B2)
F = (C1 - (1 - alpha) * B1) / alpha
```

### 精确

- 生成数量：5 张。
- 背景：黑、白、红、绿、蓝。
- 算法：多背景最小二乘。
- 用途：复杂透明、发光、高光、薄纱、玻璃、烟雾、发丝边缘。
- 优点：比单纯黑白差分更抗前景颜色干扰。

## 推荐真实模型工作流

1. 用户上传原始立绘。
2. 用户编辑 `draftTree`，软件标记未应用修改。
3. 点击生成时，发送：
   - 原始立绘；
   - 修改后的图层树；
   - dirty 图层；
   - 部件类型；
   - 当前档位对应的背景序列；
   - 内置拆分 prompt。
4. 图像模型通过 OpenAI 兼容接口输出多个背景版本。
5. 前端按档位提取 Alpha 和 RGBA。
6. LLM 通过 OpenAI 兼容 `/chat/completions` 输出结构化 merge recipe。
7. 固定合成器应用 recipe，生成待审核图层。
8. 用户确认后写入 `appliedTree`。

> 为了安全，当前实现让 LLM 输出 JSON recipe，而不是直接执行任意代码。若必须执行代码，建议放入 Web Worker 沙盒并限制 API、超时和内存。

## 开发

```bash
npm install
npm run dev
```

## 接口设置

打开应用右上角“设置”，填写：

- Base URL：例如 `https://api.openai.com/v1`，也可以是兼容 OpenAI API 的代理服务。
- API Key：浏览器本地保存到 `localStorage`。
- 生图模型：用于 `/images/edits` 或 `/images/generations`。
- LLM 模型：用于 `/chat/completions` 生成合并 recipe。
- 生图接口：默认 `/images/edits`，会把用户上传立绘作为参考图发送；如服务不支持 edits，可切换 `/images/generations`。

浏览器直连第三方 API 可能遇到 CORS 限制。生产环境建议把 Base URL 指向自己的后端代理，由后端保存 API Key 并转发请求。

本环境中已经通过：

```bash
npm run typecheck
```

生产构建在当前沙盒里被 `esbuild` 子进程权限拦截，普通本地环境应可通过 `npm run build` 验证。
