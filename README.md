# DeepSeek Chat Migration

第三方 DeepSeek Harness 插件：将官网导出的 ZIP 或 `conversations.json` 导入为可继续聊天的原生会话。支持预览选择、分支保留、去重重试和迁移记录清理。

本仓库仅提供源码。

## 开发

- 已验证：DeepSeek Harness **0.2.0-rc.2**，内置 JSONL 会话存储，Session format **4**。
- Node.js：`^22.19.0 || >=24.0.0`。

```sh
npm ci
npm run typecheck
npm test
npm run pack:release
```

构建产物：`dist/deepseek-chat-migration-1.0.2.tgz`。在 Harness「插件 → 添加插件」中粘贴该文件的完整路径，安装并启用。

## 代码结构

- `src/archive.ts`：导出解析与分支提取。
- `src/engine.ts`：导入任务、持久去重与重试。
- `src/harness.ts`：原生会话写入。
- `src/http.ts`、`src/client.tsx`：认证请求与插件界面。
- `src/session-cleanup.ts`：迁移会话删除与中断恢复。

Host / Client 分开构建和检查类型。`test/` 使用合成数据；真实导出验收可运行：

```sh
DEEPSEEK_EXPORT='/absolute/path/deepseek_data.zip' node scripts/harness-smoke.mjs
```

## 边界

- 文件在本机处理，导入不调用模型；属于文件迁移，不提供实时同步。
- 官网导出不含附件原文件，仅迁移提供的附件名称与引用信息。
- 永久删除会话已在 macOS 验证，Linux 尚未实测；Windows 暂不支持此操作。未来 Harness 版本尚未验证。

## 参考与许可

[Harness 源码](https://github.com/deepseek-ai/deepseek-harness) · [插件文档](https://github.com/deepseek-ai/deepseek-harness/blob/v0.2.0-rc.2/docs/subsystems/plugins.md)

MIT，见 [LICENSE](LICENSE)；第三方依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
