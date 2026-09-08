# README 截图

这些图片由 eDesktop 的实际界面渲染，文件、待办、聊天、天气设置和记忆使用演示数据。它们用来展示界面，不是模型执行效果的测试记录。

| 图片 | 展示内容 |
| --- | --- |
| `desktop-components.png` | 收纳盒、便签、待办、番茄钟、小栖和提醒气泡 |
| `control-center.png` | 控制中心基础设置 |
| `control-center-add.png` | 添加四类桌面组件 |
| `control-center-widgets.png` | 按类型管理已有组件 |
| `control-center-snapshots.png` | 自动快照设置和历史记录 |
| `pet-chat.png` | 小栖聊天、天气与待办提醒设置 |
| `pet-voice.png` | 语音输入状态与桌面气泡回复 |
| `pet-memory.png` | 已保存的习惯、原话来源和最近操作 |

## 重新生成

在 Windows 上安装项目依赖后，运行：

```powershell
npm run build
npx electron scripts/capture-readme.cjs
```

脚本使用独立的 Electron 进程，加载构建后的界面和专用演示接口。它不会启动正式应用的后台，也不会读取真实桌面、个人工作区或聊天记录；网络请求与麦克风权限均关闭。无需退出正在使用的 eDesktop。

最终图片写入本目录；临时文件、演示样本和尺寸清单写入被 Git 忽略的 `.artifacts/readme-capture/`。脚本会覆盖本目录中列出的八张图片。

为便于在 README 中查看，多窗口界面组合在同一张图片里，使用统一的渐变背景和留白。语音图上方的两行说明是图片标注，其余界面内容来自实际渲染。截图固定动画帧、隐藏输入光标；系统字体和文件图标仍可能随 Windows 环境略有不同。

修改界面后，请重新生成并逐张查看，确认文字没有截断、面板没有遮挡，再提交图片。
