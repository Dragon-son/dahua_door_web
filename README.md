# door_web_pro

一个基于 **Flask + Dahua NetSDK** 的大华门禁 Web 管理系统。

它提供了一个本地网页后台，用来统一管理门禁设备、远程开门、人员管理、人脸下发与开门日志查询。前端是单页静态页面，后端通过 Flask 提供 API，并调用大华门禁设备 SDK 完成实际操作。

## 功能特性

- 🚪 **远程开门**
  - 按区域展示设备
  - 进入设备详情页后一键远程开门
- 📡 **设备管理**
  - 新增、编辑、删除门禁设备
  - 按区域维护设备信息
- 👥 **人员管理**
  - 添加人员
  - 删除人员
  - 按用户 ID 精确查询
  - 按姓名关键字模糊搜索
  - 分页获取设备内全部人员
- 🙂 **人脸管理**
  - 上传人脸图片并下发到设备
  - 删除指定用户人脸
- 📜 **日志查询**
  - 按日期区间查询开门记录
  - 展示时间、门、用户 ID、姓名、开门方式、状态
- ♻️ **连接复用**
  - 通过 `DeviceManager` 复用设备连接
  - 空闲连接自动清理

## 项目结构

```text
door_web_pro/
├── server.py            # Flask 服务入口，静态页面与 API
├── access_control.html  # 前端单页界面
├── device_manager.py    # 设备连接池管理
├── device_client.py     # 设备 SDK / CGI 操作封装
├── access2.py           # 命令行版门禁操作脚本
├── devices.json         # 设备清单
├── areas.json           # 区域清单
└── area.json            # 其他区域数据文件
```

## 运行环境

建议使用 Python 3.10+。

项目依赖主要包括：

- `Flask`
- `requests`
- `Pillow`
- Dahua `NetSDK` Python 绑定/封装

> 注意：`NetSDK` 不是普通 PyPI 依赖，通常需要你本地已经准备好大华 SDK 相关文件与 Python 模块，确保 `from NetSDK...` 可以正常导入。

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/Dragon-son/door_web_pro.git
cd door_web_pro
```

### 2. 创建虚拟环境

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. 安装基础依赖

```bash
pip install flask requests pillow
```

### 4. 准备 NetSDK

请确认项目运行环境中已经具备以下内容：

- `NetSDK.NetSDK`
- `NetSDK.SDK_Callback`
- `NetSDK.SDK_Struct`
- `NetSDK.SDK_Enum`

如果这些模块不在当前项目目录中，请把对应 SDK Python 包放到 Python 可导入路径中，或者在运行前配置好 `PYTHONPATH`。

### 5. 配置设备与区域

编辑：

- `devices.json`
- `areas.json`

示例设备配置：

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

示例区域配置：

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

如果需要局域网访问，可访问：

```text
http://你的服务器IP:15001/
```

## API 概览

后端主要接口如下：

### 健康检查

- `GET /api/health`

### 设备管理

- `GET /api/devices` 获取设备列表
- `POST /api/devices` 新增设备
- `PUT /api/devices/<device_id>` 更新设备
- `DELETE /api/devices/<device_id>` 删除设备

### 区域管理

- `GET /api/areas` 获取区域列表
- `POST /api/areas` 新增区域
- `DELETE /api/areas/<name>` 删除区域

### 门禁控制

- `POST /api/open` 远程开门

### 人员管理

- `POST /api/user` 添加人员
- `DELETE /api/user/<uid>` 删除人员
- `GET /api/device/user/id/<uid>` 按 ID 查询人员
- `GET /api/device/users/search?keyword=xxx` 按姓名模糊搜索
- `GET /api/device/users/all?page=1&page_size=20` 分页查询全部人员

### 人脸管理

- `POST /api/face/<uid>` 上传并下发人脸
- `DELETE /api/face/<uid>` 删除人脸

### 日志查询

- `GET /api/log?start=2026-04-01&end=2026-04-30`

## 接口请求说明

部分接口会从以下来源提取设备连接信息：

- JSON Body
- Form Data
- Query 参数

设备字段为：

- `device_ip`
- `device_port`（默认 `37777`）
- `username`
- `password`

例如远程开门请求：

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

## 前端界面

前端页面文件为 `access_control.html`，由 Flask 直接静态托管。

主要页面模块：

- 门禁控制
- 设备管理
- 人员管理

界面风格为深色控制台风格，适合在内网管理场景中直接使用。

## 命令行脚本

项目同时包含一个命令行工具 `access2.py`，可直接对单个设备执行操作，例如：

- 开门
- 添加人员
- 查询人员
- 删除人员
- 下发人脸
- 删除人脸
- 查询日志

示例：

```bash
python3 access2.py \
  --device-ip 192.0.2.10 \
  --device-port 37777 \
  --username user_01 \
  --password your-password \
  open 0
```

## 安全说明

**请不要把真实设备密码直接提交到公开仓库。**

当前项目中的 `devices.json` 结构包含：

- IP 地址
- 用户名
- 密码

如果你要在生产环境或公开仓库长期维护，建议：

1. 将真实设备信息移出版本库
2. 使用环境变量、配置文件模板或本地私有配置覆盖
3. 提交前检查是否包含敏感信息
4. 对已暴露的密码及时更换

## 已知说明

- 本项目依赖 Dahua NetSDK，本地环境需先准备好 SDK 运行条件。
- 当前数据存储使用本地 JSON 文件，不是数据库。
- 更适合内网、值班机、门卫室或本地服务器部署。
- 若设备数量增加较多，建议后续加入数据库、权限控制、审计日志与部署脚本。

## 后续可改进方向

- [ ] 增加 `requirements.txt`
- [ ] 增加环境变量配置支持
- [ ] 敏感配置与设备清单分离
- [ ] 增加登录鉴权
- [ ] 增加 Docker 部署方式
- [ ] 增加 README 截图与接口示例

## License

暂未添加 License。如需开源发布，建议补充 MIT / Apache-2.0 等许可证。
