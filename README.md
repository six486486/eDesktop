# eDesktop

eDesktop 是一个 Windows 桌面整理工具。我写它的初衷很简单：桌面上的文件越来越多，但我又不想为了整理文件不停地打开资源管理器。

它可以把文件、快捷方式和常用的系统图标放进桌面收纳盒，也提供便签、待办列表和番茄钟。所有组件都贴在桌面壁纸层，不会像普通窗口一样挡在其他软件前面。

## 能做什么

- 用收纳盒整理桌面文件、快捷方式和文件夹
- 收纳“此电脑”“回收站”“网络”等 Windows 系统图标
- 单击选中、双击打开，右键菜单和 Windows 的使用习惯一致
- 在不同收纳盒之间拖动项目，并自由调整排列顺序
- 添加便签、待办列表和番茄钟
- 待办支持“我的一天”和“临时安排”，可以排序、跨分组拖动和每日重置
- 组件可以拖动、缩放，也可以跨显示器摆放
- 保存配置快照，需要时恢复组件布局和内容
- 支持开机启动，以及暂时隐藏全部桌面组件

目前只支持 Windows 10/11 x64。

## 下载和使用

在 [Releases](https://github.com/six486486/eDesktop/releases) 页面下载最新的 Windows x64 压缩包，完整解压后运行 `eDesktop.exe`。

首次启动后，控制中心会出现在任务栏托盘中。桌面上的组件可以直接拖动和缩放；要新建、重命名或删除组件，请打开控制中心。

如果开启了开机启动，之后又移动了软件文件夹，请在控制中心里关闭一次开机启动再重新开启，让 Windows 记录新的路径。

当前版本没有商业代码签名，Windows 可能显示 SmartScreen 提示。请确认文件来自本仓库，并核对 Release 页面提供的 SHA-256。

## 关于收纳盒里的文件

这部分值得单独说明：把文件放进收纳盒时，eDesktop 会把真实文件移动到下面的目录，而不是只生成一个视觉上的副本。

```text
%USERPROFILE%\Documents\eDesktop\收纳文件
```

正常退出软件时，文件会尽量回到收纳前的位置；如果有同名文件，不会直接覆盖。配置快照只记录组件、设置和文件位置，不会复制文件内容，所以它不能替代日常备份。

工作区配置保存在：

```text
%APPDATA%\eDesktop\desktop-workspace.json
```

卸载或更新软件不会主动删除这些数据。

## 从源码运行

需要 Node.js 20 或更高版本。项目使用 Electron、React、TypeScript 和 Vite。

```powershell
git clone https://github.com/six486486/eDesktop.git
cd eDesktop
npm install
npm run dev
```

检查类型并构建前端：

```powershell
npm run build
```

生成 Windows 程序：

```powershell
npm run package:win
npm run make:win
npm run package:portable
```

常用回归测试：

```powershell
npm run test:desktop-host
npm run test:organizer-promotion
npm run test:snapshots:integration
npm run test:restore-guardian
```

桌面窗口、Explorer 图标位置和多屏缩放都涉及 Windows 原生接口。如果你准备修改这部分，建议先完整跑一遍上述测试，再用真实的多显示器环境验证。

## 参与项目

遇到问题可以提交 [Issue](https://github.com/six486486/eDesktop/issues)。如果问题和多屏、缩放或桌面图标恢复有关，请附上 Windows 版本、各屏幕的分辨率与缩放比例，以及复现步骤。

也欢迎直接提交 Pull Request。尽量让一次提交只解决一个问题，这样更容易检查和回退。

## License

[MIT](LICENSE)
