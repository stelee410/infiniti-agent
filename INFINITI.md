# INFINITI — 项目层说明

本文件面向**当前仓库 / 工作区**的运行约定；与模型人格、语气相关的设定统一写在 **[SOUL.md](./SOUL.md)**，运行时会把 **SOUL.md 与 INFINITI.md** 一并注入系统提示（先 SOUL，后 INFINITI）。

## 你可以在这里写

- 技术栈、目录结构、构建与测试命令
- 与业务相关的术语表或禁区
- 希望 Agent 默认遵守的仓库级规范

## 覆盖方式

- 若在项目根目录放置自己的 `SOUL.md` / `INFINITI.md`，将**优先于** `infiniti-agent` 包内默认文件使用。
