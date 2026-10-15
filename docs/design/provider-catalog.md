# Provider Catalog 配置策略

> Workspace 如何管理 Hermes 内置 provider 与自定义 provider。

## 原则

Hermes 内置 provider（如 `deepseek`、`anthropic`、`openrouter`）在 **hermes-agent 代码** 中注册：

- 认证与 endpoint：`hermes_cli/auth.py` → `PROVIDER_REGISTRY`
- 运行时行为：`plugins/model-providers/<name>/`
- 模型目录：`hermes_cli/models.py` → `_PROVIDER_MODELS`

因此 **不需要** 也不应该在 `config.yaml` 的 `providers:` 段重复定义它们。

## 两类 Provider

| 类型        | 示例                            | Workspace 写入 config.yaml               | 写入 .env                |
| ----------- | ------------------------------- | ---------------------------------------- | ------------------------ |
| **Builtin** | deepseek, anthropic, openrouter | ❌ 不写 `providers.<id>`                 | ✅ `DEEPSEEK_API_KEY` 等 |
| **Custom**  | tokenx, 自建网关                | ✅ `providers.<id>` + `custom_providers` | ✅ 对应 key_env          |

### Builtin 最小运行时配置

```yaml
# ~/.hermes/profiles/<name>/config.yaml
model:
  provider: deepseek
  default: deepseek-v4-flash
```

```bash
# ~/.hermes/profiles/<name>/.env
DEEPSEEK_API_KEY=sk-...
```

### Custom 完整配置

```yaml
providers:
  tokenx:
    base_url: https://model.example/v1
    key_env: TOKENX_API_KEY
    default_model: Kimi-K2.7-Code
    models:
      - Kimi-K2.7-Code
      - GLM-5.2
custom_providers:
  - name: tokenx
    title: tokenx
    base_url: https://model.example/v1
    api_mode: chat_completions
```

## Workspace 实现

| 组件                                           | 职责                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `BUILTIN_PROVIDER_PRESETS`                     | Catalog UI 元数据（name、key_env、展示用 models）                  |
| `provider-catalog.json`                        | 记录已配置的 catalog 条目与 key 状态                               |
| `upsertCatalogKey(builtin)`                    | 写 `.env` + catalog JSON；**不**写 `providers:`                    |
| `upsertCatalogProvider(custom)`                | 写 catalog + 同步所有 profile 的 `providers:` / `custom_providers` |
| `pruneRedundantBuiltinProvidersFromProfiles()` | 清理历史遗留的冗余 `providers.<builtin>` 块                        |

### 何时保留 `providers.<builtin>`

若用户对内置 provider 做了 **有意覆盖**（例如不同的 `base_url` 代理、inline `api_key`），Workspace **不会** 自动删除该块。仅当块内容与 preset 完全冗余时才 prune。

## 与 profile 默认模型的关系

- **Custom provider**（tokenx 等）：模型列表以对应 profile 的 `config.yaml` `providers:` 为定义源
- **Builtin provider**：模型列表以 hermes-agent 内置目录 + live `/models` 为准；默认模型仍由对应 profile 的 `model.provider` + `model.default` 管理

Swarm dispatch 不再从 roster 解析或注入 `provider/model-id`；它通过 `HERMES_HOME` 使用当前 profile 的默认模型。特殊模型直接修改 profile 配置后重启 worker。

```yaml
model: deepseek/deepseek-v4-flash
```

## 代码入口

- `src/server/provider-catalog.ts` — 权威策略实现
- `src/components/settings-dialog/model-provider-panel.tsx` — Settings UI 卡片
- `src/server/hermes-config-migration.ts` — `HERMES_PROVIDER_CATALOG` 状态归一化
