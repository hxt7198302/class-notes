# 第三方组件与许可说明

本项目自身代码默认以 MIT 许可证发布（见 LICENSE）。以下为运行时/开发期依赖，均未打包进仓库：

## Node.js（webapp）

| 组件 | 用途 | 许可 |
|---|---|---|
| Node.js 内置模块 | HTTP/文件/加密等 | MIT（Node.js） |
| zfnew-node ^1.1.2 | 正方教务系统客户端（webapp/lib/zhengfang.js） | MIT（github.com/maxchang3/zfnew-node） |

webapp 采用零框架写法；npm install 只用于安装上述依赖。

## Python（webapp / pc-agent）

| 组件 | 用途 | 许可 |
|---|---|---|
| faster-whisper | 语音转写 | MIT |
| CTranslate2 | 推理后端（faster-whisper 依赖） | MIT |
| requests | HTTP 客户端（学习通 sidecar） | Apache-2.0 |
| numpy | 数值计算 | BSD-3-Clause |
| opencv-python-headless | 二维码识别（学习通 sidecar） | Apache-2.0 |
| imageio-ffmpeg / ffmpeg | 音频解码 | BSD / LGPL-2.1+（ffmpeg 依构建选项） |

## 模型

- Whisper 模型权重（tiny/small/large-v3）由 OpenAI 发布（MIT），未包含在本仓库，运行时自行下载。
- faster-whisper 模型转换格式，遵循上游许可。

## 学习通客户端

- pc-agent/chaoxing/ 为自写只读实现（协议参考公开资料与 MIT 项目思路，未整仓引入 GPL/AGPL 代码）。
- 仅做只读查询，不包含签到、刷课、答题、提交等写操作。使用需遵守学习通服务条款与所在学校规定。

## Android

- 安卓壳仅使用 Android Framework API，无第三方依赖；demo 签名 keystore 仅在本地构建时生成，不入库。

## 说明

如上游许可证表述有误，请以各项目官方仓库为准。
