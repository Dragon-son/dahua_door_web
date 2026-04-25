# Dahua Door Web

> 一个基于 **Flask + Dahua NetSDK + HTTP Digest CGI** 的大华门禁 Web 管理系统。  
> 用一个本地网页控制台，统一完成 **设备管理、远程开门、人员管理、人脸下发、批量导入、日志查询**。

![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![Flask](https://img.shields.io/badge/Flask-Web%20API-black)
![Platform](https://img.shields.io/badge/Platform-Linux-green)
![Status](https://img.shields.io/badge/Status-Internal%20Project-orange)

## ✨ 项目亮点

- **一套 Web 控制台** 管设备、人员、人脸、日志，不用每次都手动跑脚本
- **支持远程开门**，可直接对指定设备通道执行开门操作
- **设备按用户隔离管理**，不同账号拥有各自的设备清单和区域配置
- **公共人员库** 统一维护人员资料，支持跨设备关联
- **支持 Excel + 图片批量导入**，适合批量录入门禁人员
- **底层同时接入 NetSDK 与 CGI**，覆盖门禁与人脸相关能力
- **连接池复用** 设备登录状态，减少频繁登录设备的开销

## 📸 界面预览

当前仓库未附带页面截图。建议后续补充：

- 登录页
- 设备管理页
- 人员管理页
- 开门日志页

你可以把截图放到例如：

```text
assets/
├── login.png
├── devices.png
├── persons.png
└── logs.png
```

然后在 README 中加入：

```md
![登录页](assets/login.png)
![设备管理](assets/devices.png)
```

## 🧭 目录

- [功能概览](#-功能概览)
- [适用场景](#-适用场景)
- [项目结构](#-项目结构)
- [技术架构](#-技术架构)
- [核心能力说明](#-核心能力说明)
- [运行环境](#-运行环境)
- [快速开始](#-快速开始)
- [API 概览](#-api-概览)
- [请求示例](#-请求示例)
- [Excel 批量导入说明](#-excel-批量导入说明)
- [命令行工具](#-命令行工具)
- [安全说明](#-安全说明)
- [后续优化方向](#-后续优化方向)
- [License](#-license)

## 🚀 功能概览

### 1. 账号与数据隔离

- 支持注册、登录、退出
- 使用 `session` + `auth` Cookie 维持登录状态
- 每个登录账号拥有独立的：
  - `data/<username>/devices.json`
  - `data/<username>/areas.json`

### 2. 门禁设备管理

- 新增设备
- 编辑设备
- 删除设备
- 按区域归类管理
- 自动检测设备在线状态
- 使用 `device_map.json` 为同一 `IP:Port` 维护全局设备 ID

### 3. 远程开门

- 通过 Dahua NetSDK 对指定门禁设备发起远程开门
- 支持传入 `channel`

### 4. 人员管理

- 添加人员
- 删除人员
- 按用户 ID 精确查询
- 按姓名关键字模糊搜索
- 分页查询设备内全部人员

### 5. 人脸管理

- 上传并下发人脸图片
- 删除指定用户的人脸数据
- 使用 HTTP CGI + Digest 认证调用设备接口

### 6. 公共人员库

- `persons.json` 维护公共人员资料
- 同一人员可以关联多个设备 ID
- 记录姓名、有效期、状态、人脸状态等信息

### 7. 批量导入

- 上传 `user.xlsx`
- 搭配多张人脸图片一起导入
- 根据 Excel 中的门名称自动匹配目标设备
- 返回逐条处理明细

### 8. 开门日志查询

- 按时间范围查询日志
- 返回时间、门号、用户 ID、姓名、开门方式、结果状态
- 自动将设备 UTC 时间转换为东八区时间

### 9. 设备连接复用

- `DeviceManager` 维护连接池
- 避免每次请求都重复登录设备
- 空闲连接自动清理

## 🎯 适用场景

这个项目比较适合：

- 工厂 / 园区 / 办公区门禁管理
- 内网值班电脑或门卫室使用
- 局域网内的轻量门禁控制后台
- 需要批量录入人员与人脸的场景
- 需要快速做一个本地可用的大华门禁管理界面

## 📁 项目结构

```text
/vol2/1000/hdd/dahua/door_web
├── server.py             # Flask 服务入口，提供 API 与静态页面
├── access_control.html   # 单页前端管理界面
├── device_manager.py     # 设备连接池与空闲清理
├── device_client.py      # Dahua SDK / CGI 操作封装
├── access2.py            # 命令行版门禁操作工具
├── README.md             # 项目说明文档
├── users.json            # 登录账号与密码哈希
├── persons.json          # 公共人员资料库
├── device_map.json       # 全局设备 ID 映射（IP:Port -> ID）
├── user.xlsx             # 批量导入模板
├── data/                 # 各登录用户独立的数据目录
│   └── <username>/
│       ├── devices.json  # 当前用户的设备列表
│       └── areas.json    # 当前用户的区域列表
└── __pycache__/          # Python 缓存
```

## 🏗 技术架构

### 后端技术栈

- Python 3
- Flask
- Werkzeug Security（密码哈希）
- openpyxl（Excel 解析）
- requests + HTTP Digest Auth（设备 CGI）
- Pillow（图片处理/压缩）
- Dahua NetSDK Python 绑定

### 前端技术栈

- 原生 HTML / CSS / JavaScript
- 单页管理界面
- 深色控制台风格 UI
- 由 Flask 直接托管静态页面

### 设备通信方式

项目通过两种方式与设备交互：

#### NetSDK

用于：

- 设备登录
- 远程开门
- 人员增删查
- 日志查询

#### HTTP CGI + Digest 认证

用于：

- 人脸上传
- 人脸删除

## 🧠 核心能力说明

### `server.py`

主服务入口，负责：

- 用户注册 / 登录 / 登出
- 登录态校验
- 用户私有设备与区域管理
- 公共人员库维护
- Excel 批量导入
- 调用 `DeviceManager` 执行门禁操作
- 健康检查接口
- 托管 `access_control.html`

默认监听：

- `0.0.0.0:15001`

### `device_manager.py`

负责设备连接池：

- 用 `ip:port` 作为池 key
- 懒加载创建 `DeviceClient`
- 超时后自动关闭空闲连接

### `device_client.py`

设备操作核心封装层，主要提供：

- `open_door(channel=0)`
- `add_user(user_id, name)`
- `delete_user(user_id)`
- `get_user_by_id(user_id)`
- `get_users_paginated(offset, limit)`
- `search_users_by_name(keyword)`
- `add_face(user_id, path)`
- `delete_face(user_id)`
- `query_log(start, end)`

### `access2.py`

独立命令行工具，适合脚本化或运维调试：

- 开门
- 添加人员
- 查询人员
- 删除人员
- 下发人脸
- 删除人脸
- 查询日志

## 💻 运行环境

建议环境：

- Python 3.10+
- Linux
- 已正确安装并可导入 Dahua `NetSDK`

基础 Python 依赖包括：

- `flask`
- `requests`
- `pillow`
- `openpyxl`
- `werkzeug`

安装示例：

```bash
pip install flask requests pillow openpyxl werkzeug
```

> 注意：`NetSDK` 不是普通的 PyPI 依赖，必须提前准备好大华 SDK 对应的 Python 模块和运行库。

## ⚡ 快速开始

### 1. 进入项目目录

```bash
cd /vol2/1000/hdd/dahua/door_web
```

### 2. 创建或激活虚拟环境

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install flask requests pillow openpyxl werkzeug
```

### 3. 确认 NetSDK 可导入

请确认以下模块存在：

- `NetSDK.NetSDK`
- `NetSDK.SDK_Callback`
- `NetSDK.SDK_Struct`
- `NetSDK.SDK_Enum`

### 4. 启动服务

```bash
python3 server.py
```

或指定端口：

```bash
python3 server.py --port 15001
```

启动后访问：

```text
http://127.0.0.1:15001/
```

若需要局域网访问：

```text
http://服务器IP:15001/
```

## 🔌 API 概览

统一返回格式：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {}
}
```

错误格式：

```json
{
  "code": -1,
  "msg": "错误信息"
}
```

### 健康检查

- `GET /api/health`

### 认证相关

- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/user`

### 设备管理

- `GET /api/devices`
- `POST /api/devices`
- `PUT /api/devices/<device_id>`
- `DELETE /api/devices/<device_id>`

### 区域管理

- `GET /api/areas`
- `POST /api/areas`
- `DELETE /api/areas/<name>`

### 公共人员库

- `GET /api/persons`
- `POST /api/persons/import`
- `PUT /api/persons/<user_id>`
- `DELETE /api/persons/<user_id>`
- `DELETE /api/persons/<user_id>/devices/<device_id>`

### 批量导入

- `POST /api/batch_import`

### 设备操作

这些接口会从 **JSON Body / Form Data / Query 参数** 中提取设备连接信息：

- `device_ip`
- `device_port`（默认 `37777`）
- `username`
- `password`

对应接口：

- `POST /api/open`
- `POST /api/user`
- `DELETE /api/user/<uid>`
- `GET /api/device/user/id/<uid>`
- `GET /api/device/users/search?keyword=xxx`
- `GET /api/device/users/all?page=1&page_size=20`
- `POST /api/face/<uid>`
- `DELETE /api/face/<uid>`
- `GET /api/log?start=2026-04-01&end=2026-04-30`

## 🧪 请求示例

### 注册

```bash
curl -X POST http://127.0.0.1:15001/api/register \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "admin",
    "password": "123456"
  }'
```

### 登录

```bash
curl -X POST http://127.0.0.1:15001/api/login \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "admin",
    "password": "123456"
  }'
```

### 新增设备

```bash
curl -X POST http://127.0.0.1:15001/api/devices \
  -H 'Content-Type: application/json' \
  -b 'auth=admin' \
  -d '{
    "name": "示例门禁1",
    "ip": "192.0.2.10",
    "port": 37777,
    "username": "user_01",
    "password": "***",
    "area": "示例区域A",
    "note": "测试设备"
  }'
```

### 远程开门

```bash
curl -X POST http://127.0.0.1:15001/api/open \
  -H 'Content-Type: application/json' \
  -d '{
    "device_ip": "192.0.2.10",
    "device_port": 37777,
    "username": "user_01",
    "password": "***",
    "channel": 0
  }'
```

### 添加设备用户

```bash
curl -X POST http://127.0.0.1:15001/api/user \
  -H 'Content-Type: application/json' \
  -d '{
    "device_ip": "192.0.2.10",
    "device_port": 37777,
    "username": "user_01",
    "password": "***",
    "user_id": "U000001",
    "name": "示例用户"
  }'
```

### 查询日志

```bash
curl 'http://127.0.0.1:15001/api/log?device_ip=192.0.2.10&device_port=37777&username=user_01&password=***&start=2026-04-01&end=2026-04-30'
```

## 📥 Excel 批量导入说明

批量导入接口会：

1. 接收多个上传文件
2. 找到其中的 `user.xlsx`
3. 读取第二行作为表头
4. 校验必填列：
   - `用户编号`
   - `姓名`
5. 识别可选列：
   - `有效期结束`
   - `人脸图片名称`
   - `门`
6. 根据门名称匹配当前用户设备
7. 逐台设备执行人员添加
8. 如果图片存在，则继续做人脸下发
9. 返回逐条导入结果明细

模板下载接口：

- `GET /download/template`

## 🛠 命令行工具

`access2.py` 支持直接操作指定设备：

```bash
python3 access2.py \
  --device-ip 192.0.2.10 \
  --device-port 37777 \
  --username user_01 \
  --password '***' \
  open 0
```

更多示例：

```bash
# 添加人员
python3 access2.py --device-ip 192.0.2.10 --device-port 37777 --username user_01 --password '***' adduser U000001 示例用户

# 查询人员
python3 access2.py --device-ip 192.0.2.10 --device-port 37777 --username user_01 --password '***' getuser U000001

# 删除人员
python3 access2.py --device-ip 192.0.2.10 --device-port 37777 --username user_01 --password '***' deluser U000001

# 上传人脸
python3 access2.py --device-ip 192.0.2.10 --device-port 37777 --username user_01 --password '***' face U000001 ./face.jpg

# 删除人脸
python3 access2.py --device-ip 192.0.2.10 --device-port 37777 --username user_01 --password '***' dface U000001

# 查询日志
python3 access2.py --device-ip 192.0.2.10 --device-port 37777 --username user_01 --password '***' log 2026-04-01 2026-04-30
```

## 🔐 安全说明

这个项目会接触比较敏感的信息，比如：

- 门禁设备 IP
- 设备账号密码
- 人员姓名与编号
- 人脸图片
- 登录账号数据

因此建议：

1. **不要把真实设备密码提交到公开仓库**
2. 将设备敏感配置改成本地私有文件或环境变量
3. 公开演示时对 JSON、Excel、截图做脱敏处理
4. 为 `users.json`、`persons.json`、`data/` 做备份与权限控制
5. 生产环境中把 `secret_key` 从源码移出
6. 增加更细粒度的权限控制与审计日志

## 📝 后续优化方向

- [ ] 补充 `requirements.txt`
- [ ] 增加 `.env` / 配置文件模板
- [ ] 将敏感配置彻底移出源码
- [ ] 增加部署文档（systemd / Docker）
- [ ] 增加接口测试与单元测试
- [ ] 增加前端截图与操作流程图
- [ ] 优化 Excel 导入错误提示与回滚策略
- [ ] 增加数据库支持，替代部分本地 JSON 存储

## 📄 License

当前仓库未附带明确 License。

如果你准备公开发布，建议补充：

- MIT
- Apache-2.0
- 或企业内部使用说明
