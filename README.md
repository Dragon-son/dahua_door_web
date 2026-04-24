# dahua_door_web

一个基于 **Flask + Dahua NetSDK / CGI** 的大华门禁 Web 管理系统。

它提供一个本地网页后台，用来统一管理门禁设备、远程开门、人员与人脸信息、批量导入和开门日志查询。前端为单页应用 `access_control.html`，后端由 `server.py` 提供 API，并通过 `device_client.py` / `DeviceManager` 调用大华设备能力。

> 当前仓库为**脱敏后的可发布示例版本**：示例数据与配置已做匿名化处理，运行时生成的数据文件默认被 `.gitignore` 忽略。

## 功能特性

- 🚪 **门禁控制**
  - 按区域展示设备
  - 进入设备详情后可一键远程开门
  - 支持按日期区间查询设备开门日志
  - 展示时间、门、用户 ID、姓名、开门方式、状态等信息

- 📡 **设备管理**
  - 支持新增、编辑、删除门禁设备
  - 设备按用户隔离存储，每个账号维护自己的设备清单
  - 自动检测设备 TCP 连通状态
  - 通过全局 `device_map.json` 为同一 `IP:Port` 分配统一设备 ID

- 👥 **人员管理**
  - 添加人员
  - 删除人员
  - 按用户 ID 精确查询设备内人员
  - 按姓名关键字模糊搜索
  - 分页获取设备内全部人员
  - 公共 `persons.json` 保存人员主数据，并记录关联设备 ID

- 🙂 **人脸管理**
  - 上传人脸图片并下发到设备
  - 删除指定用户人脸
  - 人脸上传通过 CGI 接口完成

- 📥 **批量导入**
  - 支持上传包含 `user.xlsx` 和人脸图片的文件夹
  - 解析 Excel 后批量向多个设备添加人员
  - 可同时批量下发人脸
  - 返回逐条导入结果统计

- 🔐 **登录与注册**
  - 支持账号注册、登录、退出
  - 使用 Flask Session + Cookie 维持登录状态
  - 用户数据目录按账号隔离到 `data/<username>/`

- ♻️ **连接复用**
  - `DeviceManager` 维护设备连接池
  - `DeviceClient` 复用 Dahua SDK 登录连接
  - 空闲连接自动清理，减少重复登录开销

## 项目结构

```text
dahua_door_web/
├── server.py              # Flask 服务入口，静态页面与 API
├── access_control.html    # 前端单页界面
├── device_manager.py      # 设备连接池管理
├── device_client.py       # 设备 SDK / CGI 操作封装
├── access2.py             # 命令行版门禁操作脚本
├── README.md
├── .gitignore
│
├── areas.json             # 示例区域数据（脱敏）
├── devices.json           # 示例设备数据（脱敏）
├── device_map.json        # 示例全局设备ID映射（脱敏）
├── persons.json           # 示例人员数据（脱敏）
├── users.json             # 示例账号数据（脱敏）
├── user.xlsx              # 示例导入模板（脱敏）
│
└── data/
    └── <username>/
        ├── areas.json     # 某个账号自己的区域列表
        └── devices.json   # 某个账号自己的设备列表
```

## 运行环境

建议使用 **Python 3.10+**。

主要依赖：

- `Flask`
- `Werkzeug`
- `requests`
- `Pillow`
- `openpyxl`
- Dahua `NetSDK` Python 绑定 / 封装

> 注意：`NetSDK` 通常不是直接通过 PyPI 安装的普通依赖。运行前需要确保以下模块在 Python 环境中可导入：
>
> - `NetSDK.NetSDK`
> - `NetSDK.SDK_Callback`
> - `NetSDK.SDK_Struct`
> - `NetSDK.SDK_Enum`

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/Dragon-son/dahua_door_web.git
cd dahua_door_web
```

### 2. 创建虚拟环境

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. 安装基础依赖

```bash
pip install flask requests pillow openpyxl
```

### 4. 准备 NetSDK

请确认当前运行环境已正确放置 Dahua SDK 的 Python 绑定文件，能够正常导入：

```python
from NetSDK.NetSDK import NetClient
from NetSDK.SDK_Callback import fDisConnect, fHaveReConnect
from NetSDK.SDK_Struct import *
from NetSDK.SDK_Enum import *
```

如果这些模块不在当前项目目录中，请提前配置 `PYTHONPATH` 或将 SDK Python 包放入可导入路径。

### 5. 配置设备与区域

实际运行时，推荐先注册账号，再通过 Web 页面维护设备与区域。

如果你希望预置数据，可参考以下示例结构。

#### 示例设备配置

```json
[
  {
    "id": 1,
    "name": "示例门禁1",
    "ip": "192.0.2.10",
    "port": 37777,
    "username": "user_01",
    "password": "***",
    "area": "示例区域A",
    "note": "示例备注"
  }
]
```

#### 示例区域配置

```json
[
  "示例区域A",
  "示例区域B",
  "示例区域C"
]
```

### 6. 启动服务

默认端口为 `15001`：

```bash
python3 server.py
```

指定端口启动：

```bash
python3 server.py --port 15001
```

启动后访问：

```text
http://127.0.0.1:15001/
```

如需局域网访问，可使用：

```text
http://你的服务器IP:15001/
```

## 数据存储说明

当前版本同时包含两类数据：

### 1. 公共数据文件

位于项目根目录：

- `persons.json`：公共人员主数据
- `users.json`：登录账号数据
- `device_map.json`：`IP:Port -> 全局设备ID` 映射

### 2. 按用户隔离的数据

位于 `data/<username>/` 目录：

- `devices.json`：该账号自己的设备清单
- `areas.json`：该账号自己的区域列表

也就是说：

- **账号、人员主表、全局设备映射** 是公共的
- **设备清单、区域列表** 是按登录用户隔离的

## 前端界面

前端页面文件为 `access_control.html`，由 Flask 直接静态托管。

主要页面模块：

- 门禁控制
- 设备管理
- 人员管理
- 登录 / 注册界面
- 区域管理弹窗
- 批量导入结果弹窗

界面风格为深色控制台风格，适合在内网管理场景中直接使用。

## API 概览

后端统一返回结构：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {}
}
```

失败时：

```json
{
  "code": -1,
  "msg": "错误信息"
}
```

### 公开接口

- `POST /api/register` 注册账号
- `POST /api/login` 登录
- `POST /api/logout` 退出登录
- `GET /api/user` 获取当前登录用户
- `GET /api/health` 健康检查
- `GET /` 前端页面
- `GET /download/template` 下载批量导入模板

### 设备管理

- `GET /api/devices` 获取设备列表
- `POST /api/devices` 新增设备
- `PUT /api/devices/<device_id>` 更新设备
- `DELETE /api/devices/<device_id>` 删除设备

### 区域管理

- `GET /api/areas` 获取区域列表
- `POST /api/areas` 新增区域
- `DELETE /api/areas/<name>` 删除区域

### 公共人员库

- `GET /api/persons` 获取人员列表
- `POST /api/persons/import` 导入人员到公共库并关联设备
- `PUT /api/persons/<user_id>` 更新人员信息
- `DELETE /api/persons/<user_id>` 删除人员
- `DELETE /api/persons/<user_id>/devices/<device_id>` 取消某人员与某设备的关联

### 设备级操作

以下接口会读取设备连接信息：

- `device_ip`
- `device_port`（默认 `37777`）
- `username`
- `password`

这些信息可以来自：

- JSON Body
- Form Data
- Query 参数

具体接口包括：

- `POST /api/open` 远程开门
- `POST /api/user` 添加人员到设备
- `DELETE /api/user/<uid>` 从设备删除人员
- `GET /api/device/user/id/<uid>` 查询设备内指定人员
- `GET /api/device/users/search?keyword=xxx` 按姓名搜索设备人员
- `GET /api/device/users/all?page=1&page_size=20` 分页查询设备全部人员
- `POST /api/face/<uid>` 上传并下发人脸
- `DELETE /api/face/<uid>` 删除人脸
- `GET /api/log?start=2026-04-01&end=2026-04-30` 查询日志

## 接口调用示例

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

### 添加设备

```bash
curl -X POST http://127.0.0.1:15001/api/devices \
  -H 'Content-Type: application/json' \
  -b cookie.txt -c cookie.txt \
  -d '{
    "name": "示例门禁1",
    "ip": "192.0.2.10",
    "port": 37777,
    "username": "user_01",
    "password": "***",
    "area": "示例区域A",
    "note": "示例备注"
  }'
```

### 查询设备内人员

```bash
curl "http://127.0.0.1:15001/api/device/user/id/U000001?device_ip=192.0.2.10&device_port=37777&username=user_01&password=***"
```

## 批量导入说明

`POST /api/batch_import` 支持上传文件夹内容，后端会：

1. 查找 `user.xlsx`
2. 解析第二行为表头的数据区
3. 读取 `用户编号`、`姓名`、`有效期结束`、`人脸图片名称`、`门` 等字段
4. 根据门名称匹配当前登录用户名下的设备
5. 批量调用设备接口添加人员
6. 若图片存在，则继续下发人脸
7. 返回总数、成功数、失败数、人脸成功数、人脸失败数及逐条结果

相关辅助接口：

- `GET /download/template` 下载导入模板

## 命令行脚本

项目同时包含命令行工具 `access2.py`，可直接对单个设备执行操作。

支持命令：

- `open [门号]`
- `adduser <ID> <姓名>`
- `getuser <ID>`
- `deluser <ID>`
- `face <ID> <图片路径> [max_kb] [宽] [高] [质量]`
- `dface <ID>`
- `log <开始日期> [结束日期]`

示例：

```bash
python3 access2.py \
  --device-ip 192.0.2.10 \
  --device-port 37777 \
  --username user_01 \
  --password '***' \
  open 0
```

## 安全说明

**请不要把真实设备密码、真实人员信息、真实内网 IP 直接提交到公开仓库。**

建议：

1. 将真实设备信息移出版本库
2. 使用环境变量、私有配置文件或部署时挂载配置
3. 为公开仓库保留匿名化示例数据
4. 提交前检查 `devices.json`、`persons.json`、`users.json`、`user.xlsx`、`data/` 等文件
5. 如果敏感数据已经推送到公开仓库，单纯再提交一版脱敏文件**并不能清除历史泄露**，应考虑重写 Git 历史并及时更换密码

当前仓库的 `.gitignore` 已默认忽略：

- `persons.json`
- `users.json`
- `user.xlsx`
- `data/`
- `__pycache__/`
- `*.pyc`
- `*.log`
- `.env`

## 已知限制

- 依赖本地 Dahua NetSDK 环境，无法仅靠纯 PyPI 依赖直接运行
- 当前数据存储为本地 JSON 文件，不是数据库
- 登录功能为轻量级本地账号体系，适合内网部署
- Flask `secret_key` 当前写在示例代码中，生产环境建议改为环境变量
- 设备级接口目前仍允许调用方直接传入设备 IP/账号密码，生产部署时建议进一步收敛为仅从已保存设备中选择

## 后续可改进方向

- [ ] 增加 `requirements.txt`
- [ ] 增加环境变量配置支持
- [ ] 将 `secret_key`、设备凭据等敏感配置移出代码
- [ ] 引入数据库替代部分 JSON 文件
- [ ] 增加更细粒度的权限控制与审计日志
- [ ] 增加自动化测试与部署说明
- [ ] 增加 README 页面截图与更完整的接口示例

## License

暂未添加 License。如需开源发布，建议补充 MIT / Apache-2.0 等许可证。