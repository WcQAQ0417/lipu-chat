# 离谱聊天室 Demo

这是“离谱聊天室”的全栈实时版本。根目录原有 `index.html` 保留为早期单机 Demo；真实应用位于 `apps/web` 与 `apps/api`。

## 一键启动完整应用

```bash
cp .env.example .env
docker compose up -d --build
```

打开：`http://localhost:8080`

默认 `LLM_MOCK_MODE=true`，无需密钥即可体验完整流程。接入 OpenAI-compatible 模型时，在 `.env` 中设置：

```text
LLM_BASE_URL=https://你的模型服务/v1
LLM_API_KEY=你的密钥
LLM_MODEL=模型名称
LLM_MOCK_MODE=false
```

修改构建相关环境变量后重新执行 `docker compose up -d --build`。

完整应用包含人物 CRUD、房间搜索和创建、WebSocket 实时通信、3 秒转换预览、暗线冲突任务、失控指数以及手机端响应式界面。

## v1 多人系统架构

升级后的完整方案见 [`完整技术架构文档-v1.0.md`](./完整技术架构文档-v1.0.md)，包含人物 CRUD、人物版本、临时房间、WebSocket 协议、主题任务、AI 转换、空房销毁、MySQL/Redis 数据结构、安全、测试和上线演进。

本地基础设施已经过实际启动验证：

```bash
cp .env.example .env
docker compose up -d
docker compose ps
```

当前 Compose 会启动：

- MySQL 8.4 LTS：`127.0.0.1:3306`
- Redis 8.2：`127.0.0.1:6379`

首次启动会自动执行 `infra/mysql/init/001_schema.sql` 创建业务表。开发密码只用于本机，生产环境必须替换。

## 打开方式

若只查看旧版静态 Demo，可以直接双击根目录 `index.html`。

## 已实现

- 选择程序员、英语老师、古风文人、霸道总裁、热血主角等身份。
- 创建自定义身份并保存到浏览器本地。
- 选择三个模拟聊天室。
- 输入原话并转换成当前身份的表达。
- 程序员代码块等角色专属消息样式。
- 查看原话、换个说法、聊天中切换身份。
- 模拟房间成员自动回复。
- 桌面与手机响应式布局。
- 键盘发送、焦点样式和减少动态效果支持。

## 演示建议

1. 选择“程序员”。
2. 进入“甲方今晚不睡”。
3. 输入“我吃了3个鸡蛋”，观察代码块结果。
4. 点击“查看原话”和“换个说法”。
5. 切换为英语老师，再输入“我今天不想上班”。
6. 返回首页创建一个自定义身份。

## 当前边界

消息和角色转换均为本地模拟，不涉及真实用户、数据库或大模型。`index.html` 中的 `transformMessage()` 是未来替换为后端 AI 接口的位置。
