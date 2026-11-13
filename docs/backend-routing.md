# 作者搜索后端路由

新接口以 `/socialdatax/api` 为统一前缀，接口的业务路径如下：

- `POST /v1/feishu/blogger/search/task`
- `GET /v1/feishu/blogger/search/task`
- `POST /v1/feishu/blogger/search/list`
- `POST /v1/feishu/blogger/search/task/cancel`
- `GET /v1/feishu/profile-fetch/table-output-configs`
- `PUT /v1/feishu/profile-fetch/table-output-config`

新任务在原有飞书 bridge 进度中保存 `apiBaseUrl` 和 `apiPathPrefix`。恢复、结果分页和停止均使用这份来源快照；缺少来源的历史任务继续使用 `VITE_API_BASE_URL` 与 `/social/api`。已有存储键、任务 ID、游标、目标表、字段映射和写入方式保持不变，无需新建 Mongo 表。不要清除任务存储来切换后端。

## 域名与构建

| 环境 | 新接口基址 | 原接口基址 |
| --- | --- | --- |
| 生产 | `https://api.socialdatax.com` | `https://api.52choujiang.cn` |
| 测试 | `https://test-lotto.weiyoubot.cn` | 沿用该环境的 `VITE_API_BASE_URL` |
| 本地开发 | `/`，由 Vite 的 `/socialdatax/api` 代理到测试服 | 沿用 `/social/api` 代理 |

生产构建在 `.env.production` 中分别配置 `VITE_FEISHU_API_BASE_URL` 和 `VITE_API_BASE_URL`；用户 API Key 由插件输入，不能写入环境变量或产物。源码与 `dist/` 一起提交。构建完成后才更新插件发布版本：

```sh
npm test
npm run build
```

GitLab 同步会保留 GitHub 自己的环境文件，并同步内部已经构建好的 `dist/`。直接使用该产物无需再次设置变量；若在 GitHub 或本地重新构建，须显式提供两个基址，或在该仓库的生产环境文件中配置：

```sh
VITE_API_BASE_URL=https://api.52choujiang.cn \
VITE_FEISHU_API_BASE_URL=https://api.socialdatax.com npm run build
```

更改环境变量后需要重新构建或重启 Vite。已有表结构、映射和版本参数沿用现有契约。自动化测试使用 SDK 与 HTTP 边界替身；真实飞书侧栏的采集、停止和写表仍需发布后实测。
