# YX — 万物模拟（在线版）

从本地 `../NEW` 同步源码，部署到 GitHub Pages。

| 链接 | 地址 |
|------|------|
| 在线运行 | https://62cm.github.io/YX/ |
| 仓库 | https://github.com/62cm/YX |

## 本地脚本（双击）

| 文件 | 作用 |
|------|------|
| `sync-from-NEW.bat` | 把 `NEW` 目录源码同步到本仓库 |
| `deploy-github.bat` | 同步 → 构建测试 → 推送到 GitHub（自动 Pages 部署） |
| `start-dev.bat` | 本地开发 `http://localhost:5180` |
| `start-server.bat` | 本地预览线上路径 `/YX/` |

## 首次部署

1. 双击 `deploy-github.bat`
2. 若仓库不存在，在已登录 `gh` 的终端执行：
   ```bat
   cd d:\TEST\YX
   gh repo create YX --public --source=. --remote=origin --push
   ```
3. GitHub 仓库 **Settings → Pages → Build and deployment → Source: GitHub Actions**

## 日常更新

改完 `NEW` 里的代码后，双击 `deploy-github.bat` 即可。
