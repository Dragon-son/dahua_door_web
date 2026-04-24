# server.py

from flask import Flask, request, jsonify, send_from_directory, session
import json
import os
import io
import threading
import time
import argparse
import socket
from datetime import datetime
from datetime import timedelta
from werkzeug.security import generate_password_hash, check_password_hash
from device_manager import DeviceManager
from openpyxl import load_workbook

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_ROOT = os.path.join(BASE, "data")
USERS_FILE = os.path.join(BASE, "users.json")
PERSONS_FILE = os.path.join(BASE, "persons.json")            # 公用人库
DEVICE_MAP_FILE = os.path.join(BASE, "device_map.json")     # IP:Port → 全局ID

app = Flask(__name__)
app.secret_key = 'dahua-door-web-2026-fixed-secret-key'  # 固定不变
app.config['SESSION_PERMANENT'] = True
from datetime import timedelta
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
manager = DeviceManager()

# ================= 工具函数 =================
def ok(data=None):
    return jsonify({"code": 0, "msg": "ok", "data": data})

def err(msg, code=400):
    return jsonify({"code": -1, "msg": str(msg)}), code

def load_users():
    if not os.path.exists(USERS_FILE):
        save_users({})
        return {}
    with open(USERS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_users(users):
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2, ensure_ascii=False)

def get_user_dir(username):
    user_dir = os.path.join(DATA_ROOT, username)
    if not os.path.exists(user_dir):
        os.makedirs(user_dir, exist_ok=True)
    return user_dir

# ---------- 全局设备ID映射 ----------
def load_device_map():
    if not os.path.exists(DEVICE_MAP_FILE):
        save_device_map({})
        return {}
    try:
        with open(DEVICE_MAP_FILE, "r", encoding="utf-8") as f:
            content = f.read()
            if not content.strip():
                save_device_map({})
                return {}
            return json.loads(content)
    except (json.JSONDecodeError, ValueError):
        print("device_map.json 格式错误，已重置为空")
        save_device_map({})
        return {}

def save_device_map(mapping):
    with open(DEVICE_MAP_FILE, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

def get_or_create_global_device_id(ip, port):
    key = f"{ip}:{port}"
    mapping = load_device_map()
    if key in mapping:
        return mapping[key]
    new_id = max(mapping.values(), default=0) + 1
    mapping[key] = new_id
    save_device_map(mapping)
    return new_id

# ---------- 设备（按用户隔离） ----------
def load_devices(username):
    user_dir = get_user_dir(username)
    dev_file = os.path.join(user_dir, "devices.json")
    if not os.path.exists(dev_file):
        save_devices(username, [])
        return []
    with open(dev_file, "r", encoding="utf-8") as f:
        return json.load(f)

def save_devices(username, devs):
    user_dir = get_user_dir(username)
    dev_file = os.path.join(user_dir, "devices.json")
    with open(dev_file, "w", encoding="utf-8") as f:
        json.dump(devs, f, indent=2, ensure_ascii=False)

# ---------- 区域（按用户隔离） ----------
def load_areas(username):
    user_dir = get_user_dir(username)
    area_file = os.path.join(user_dir, "areas.json")
    if not os.path.exists(area_file):
        areas = ["传动轴"]
        save_areas(username, areas)
        return areas
    with open(area_file, "r", encoding="utf-8") as f:
        return json.load(f)

def save_areas(username, areas):
    user_dir = get_user_dir(username)
    area_file = os.path.join(user_dir, "areas.json")
    with open(area_file, "w", encoding="utf-8") as f:
        json.dump(areas, f, indent=2, ensure_ascii=False)

# ---------- 人员（公用） ----------
def load_persons():
    if not os.path.exists(PERSONS_FILE):
        save_persons([])
        return []
    with open(PERSONS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_persons(persons):
    with open(PERSONS_FILE, "w", encoding="utf-8") as f:
        json.dump(persons, f, indent=2, ensure_ascii=False)

def get_current_user():
    username = session.get("username")
    if not username:
        raise Exception("未登录")
    return username

# ================= 登录验证 =================
@app.before_request
def auto_login_from_cookie():
    """如果 auth cookie 有效但 session 中无用户名，自动恢复 session"""
    if "username" not in session and request.cookies.get("auth"):
        username = request.cookies.get("auth")
        # 简单验证用户在 users.json 中是否存在（可选）
        users = load_users()
        if username in users:
            session["username"] = username
            session.permanent = True
            
@app.before_request
def check_login():
    # 原有的登录检查逻辑不变
    if request.path in ["/", "/api/login", "/api/register", "/api/health"]:
        return
    if request.path.startswith("/api/"):
        if "username" not in session:
            return err("未登录", 401)

# ================= 用户管理 =================
@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    if not username or not password:
        return err("用户名和密码不能为空")
    users = load_users()
    if username in users:
        return err("用户名已存在")
    users[username] = generate_password_hash(password)
    save_users(users)

    try:
        user_dir = get_user_dir(username)
        if not os.path.exists(os.path.join(user_dir, "devices.json")):
            save_devices(username, [])
        if not os.path.exists(os.path.join(user_dir, "areas.json")):
            save_areas(username, ["A区", "B区", "C区"])
    except Exception as e:
        print(f"用户 {username} 数据初始化失败: {e}")

    return ok({"message": "注册成功"})

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    users = load_users()
    if username not in users or not check_password_hash(users[username], password):
        return err("用户名或密码错误", 401)

    # 设置服务器 session
    session["username"] = username
    session.permanent = True

    # 额外设置一个独立的长期 Cookie（auth），Max-Age 30天
    resp = ok({"username": username})
    resp.set_cookie(
        "auth",
        username,
        max_age=30 * 24 * 3600,  # 30天
        httponly=False,          # 前端可以读取
        samesite="Lax",
        path="/"
    )
    return resp

@app.route("/api/logout", methods=["POST"])
def logout():
    session.pop("username", None)
    return ok()

@app.route("/api/user", methods=["GET"])
def current_user():
    return ok({"username": session.get("username")})

# ================= 设备 API（全局统一ID，用户隔离） =================
@app.route("/api/devices", methods=["GET"])
def get_devices():
    username = get_current_user()
    devs = load_devices(username)
    for d in devs:
        d["online"] = check_device_online(d.get("ip", ""), d.get("port", 37777))
    return ok(devs)

@app.route("/api/devices", methods=["POST"])
def add_device():
    username = get_current_user()
    data = request.get_json()
    if not data.get("name") or not data.get("ip"):
        return err("name 和 ip 必填")

    ip = data["ip"].strip()
    port = int(data.get("port", 37777))

    # 全局唯一ID
    dev_id = get_or_create_global_device_id(ip, port)

    devs = load_devices(username)

    # 该用户是否已添加此设备
    existing = next((d for d in devs if d["id"] == dev_id), None)
    if existing:
        existing.update({
            "name": data["name"],
            "username": data.get("username", "admin"),
            "password": data.get("password", ""),
            "area": data.get("area", "A区"),
            "note": data.get("note", "")
        })
        save_devices(username, devs)
        return ok(existing)

    new_dev = {
        "id": dev_id,
        "name": data["name"],
        "ip": ip,
        "port": port,
        "username": data.get("username", "admin"),
        "password": data.get("password", ""),
        "area": data.get("area", "A区"),
        "note": data.get("note", "")
    }
    devs.append(new_dev)
    save_devices(username, devs)
    return ok(new_dev)

@app.route("/api/devices/<int:device_id>", methods=["PUT"])
def update_device(device_id):
    username = get_current_user()
    data = request.get_json()
    devs = load_devices(username)
    for d in devs:
        if d["id"] == device_id:
            d.update({
                "name": data.get("name", d["name"]),
                "ip": data.get("ip", d["ip"]),
                "port": int(data.get("port", d["port"])),
                "username": data.get("username", d["username"]),
                "password": data.get("password", d["password"]),
                "area": data.get("area", d.get("area", "A区")),
                "note": data.get("note", d.get("note", ""))
            })
            save_devices(username, devs)
            return ok(d)
    return err("设备不存在", 404)

@app.route("/api/devices/<int:device_id>", methods=["DELETE"])
def delete_device(device_id):
    username = get_current_user()
    devs = load_devices(username)
    new_devs = [d for d in devs if d["id"] != device_id]
    if len(new_devs) == len(devs):
        return err("设备不存在", 404)
    save_devices(username, new_devs)
    return ok({"deleted_id": device_id})

# ================= 区域 API（用户隔离） =================
@app.route("/api/areas", methods=["GET"])
def get_areas():
    username = get_current_user()
    return ok(load_areas(username))

@app.route("/api/areas", methods=["POST"])
def add_area():
    username = get_current_user()
    name = request.json.get("name", "").strip()
    if not name:
        return err("区域名称不能为空")
    areas = load_areas(username)
    if name in areas:
        return err("区域已存在")
    areas.append(name)
    save_areas(username, areas)
    return ok(areas)

@app.route("/api/areas/<name>", methods=["DELETE"])
def delete_area(name):
    username = get_current_user()
    areas = load_areas(username)
    if name not in areas:
        return err("区域不存在", 404)
    devs = load_devices(username)
    if any(d.get("area") == name for d in devs):
        return err("该区域下有设备，无法删除")
    areas.remove(name)
    save_areas(username, areas)
    return ok({"deleted": name})

# ================= 人员 API（公用） =================
@app.route("/api/persons", methods=["GET"])
def get_persons():
    device_id = request.args.get("device_id")
    persons = load_persons()
    if device_id:
        did = int(device_id)
        persons = [p for p in persons if did in p.get("doors", [])]
    return ok(persons)

@app.route("/api/persons/import", methods=["POST"])
def import_persons():
    data = request.get_json()
    device_id = data.get("device_id")          # 全局ID
    new_persons = data.get("persons", [])
    if device_id is None or not isinstance(new_persons, list):
        return err("参数错误")

    persons = load_persons()
    index = {p["user_id"]: p for p in persons}

    for np in new_persons:
        uid = np["user_id"]
        if uid in index:
            existing = index[uid]
            doors = existing.setdefault("doors", [])
            if device_id not in doors:
                doors.append(device_id)
            existing.update({
                "name": np.get("name", existing["name"]),
                "valid_begin": np.get("valid_begin", existing.get("valid_begin")),
                "valid_end": np.get("valid_end", existing.get("valid_end")),
                "status": np.get("status", existing.get("status")),
            })
            if np.get("has_face") is not None:
                existing["has_face"] = np["has_face"]
        else:
            np.setdefault("doors", [device_id])
            np.setdefault("has_face", None)
            persons.append(np)
            index[uid] = np

    save_persons(persons)
    return ok({"count": len(new_persons)})

@app.route("/api/persons/<user_id>", methods=["DELETE"])
def delete_person(user_id):
    persons = load_persons()
    new_persons = [p for p in persons if p["user_id"] != user_id]
    if len(new_persons) == len(persons):
        return err("人员不存在", 404)
    save_persons(new_persons)
    return ok()

@app.route("/api/persons/<user_id>", methods=["PUT"])
def update_person(user_id):
    data = request.get_json()
    persons = load_persons()
    for p in persons:
        if p["user_id"] == user_id:
            if "has_face" in data:
                p["has_face"] = data["has_face"]
            p.update({
                "name": data.get("name", p.get("name")),
                "valid_begin": data.get("valid_begin", p.get("valid_begin")),
                "valid_end": data.get("valid_end", p.get("valid_end")),
                "status": data.get("status", p.get("status")),
                "doors": data.get("doors", p.get("doors")),
            })
            save_persons(persons)
            return ok(p)
    return err("人员不存在", 404)

@app.route("/api/batch_import", methods=["POST"])
def batch_import():
    try:
        username = get_current_user()
    except Exception as e:
        return err(str(e), 401)

    if 'files' not in request.files:
        return err("请选择文件夹上传")

    uploaded_files = request.files.getlist('files')
    current_device_id = request.form.get('current_device_id', None)
    if current_device_id:
        current_device_id = int(current_device_id)

    user_devices = load_devices(username)
    device_map = {}
    for d in user_devices:
        device_map[d['name']] = d
        device_map[f"{d['ip']}:{d['port']}"] = d

    excel_data = None
    images = {}
    for f in uploaded_files:
        basename = os.path.basename(f.filename)
        if basename == 'user.xlsx':
            excel_data = f.read()
        elif f.filename.lower().endswith(('.jpg','.jpeg','.png','.bmp')):
            images[basename] = f.read()

    if excel_data is None:
        return err("文件夹中未找到 user.xlsx 文件")

    try:
        wb = load_workbook(io.BytesIO(excel_data))
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        if len(rows) < 3:
            return err("Excel 数据不足（需要第一行说明、第二行列名、至少一行数据）")
        headers = [str(c).strip() if c else '' for c in rows[1]]
        required = ['用户编号', '姓名']
        for r in required:
            if r not in headers:
                return err(f"Excel 缺少必需列: {r}")
        data_rows = rows[2:]
    except Exception as e:
        return err(f"Excel 解析失败: {e}")

    total = 0
    success = 0
    fail = 0
    face_success = 0
    face_fail = 0
    details = []          # 存储每条记录的结果

    for row in data_rows:
        # 跳过完全为空的行（所有单元格均为 None 或空字符串）
        if all(cell is None or str(cell).strip() == '' for cell in row):
            continue

        # 提取用户编号和姓名，如果无效则跳过该行
        try:
            user_id = str(row[headers.index('用户编号')]).strip()
            name = str(row[headers.index('姓名')]).strip()
        except (ValueError, IndexError):
            continue
        if not user_id or not name:
            continue

        total += 1

        valid_begin = "2000-01-01"
        valid_end = None
        if '有效期结束' in headers:
            ve = row[headers.index('有效期结束')]
            if ve is not None:
                ve_str = str(ve).strip()
                if ve_str and ve_str != 'None':
                    # 尝试多种日期格式，转换为标准 YYYY-MM-DD
                    for fmt in ("%Y-%m-%d", "%Y%m%d", "%Y/%m/%d", "%Y.%m.%d"):
                        try:
                            valid_end = datetime.strptime(ve_str, fmt).strftime("%Y-%m-%d")
                            break
                        except ValueError:
                            continue
        # 如果未能成功解析或未填写，默认 10 年
        if not valid_end:
            valid_end = (datetime.now() + timedelta(days=3650)).strftime("%Y-%m-%d")

        face_filename = ''
        if '人脸图片名称' in headers:
            idx = headers.index('人脸图片名称')
            raw = row[idx]
            face_filename = str(raw).strip() if raw else ''

        door_names = []
        if '门' in headers:
            idx = headers.index('门')
            raw = row[idx]
            if raw:
                door_names = [d.strip() for d in str(raw).split(',') if d.strip()]

        door_ids = []
        resolved_doors = []     # 用于详情显示的门名称列表
        if door_names:
            # 表格中指定了设备名称，只在这些设备上添加
            for dn in door_names:
                dev = device_map.get(dn)
                if not dev:
                    # 尝试模糊匹配
                    for d in user_devices:
                        if dn in d['name'] or dn == f"{d['ip']}:{d['port']}":
                            dev = d
                            break
                if dev:
                    if dev['id'] not in door_ids:  # 避免重复
                        door_ids.append(dev['id'])
                        resolved_doors.append(dev['name'])
                else:
                    # 设备未找到，记录失败信息，但不中断整行
                    resolved_doors.append(f"{dn}(未找到)")
        else:
            # 未指定任何设备，不执行添加，直接计入失败
            fail += 1
            details.append({
                "user_id": user_id,
                "name": name,
                "doors": "未指定设备",
                "status": "失败",
                "face_result": "—",
                "error": "Excel中未填写目标设备"
            })
            continue    # 跳过该行，不再使用当前选中设备

        if not door_ids:
            # 所有指定设备都未找到
            fail += 1
            details.append({
                "user_id": user_id,
                "name": name,
                "doors": ", ".join(resolved_doors) if resolved_doors else "无",
                "status": "失败",
                "face_result": "—",
                "error": "未找到有效设备"
            })
            continue

        # 每行的人员添加可能成功部分门，我们记录整体状态
        row_success = 0
        row_fail = 0
        row_face_ok = 0
        row_face_fail = 0
        error_messages = []

        for did in door_ids:
            dev = next((d for d in user_devices if d['id'] == did), None)
            if not dev:
                row_fail += 1
                error_messages.append(f"设备{did}不存在")
                continue

            try:
                manager.get(dev).add_user(user_id, name)

                persons = load_persons()
                index = {p["user_id"]: p for p in persons}
                new_person = {
                    "user_id": user_id,
                    "name": name,
                    "valid_begin": valid_begin,
                    "valid_end": valid_end,
                    "status": 0,
                    "doors": [did],
                    "has_face": None
                }
                if user_id in index:
                    existing = index[user_id]
                    dlist = existing.setdefault("doors", [])
                    if did not in dlist:
                        dlist.append(did)
                else:
                    persons.append(new_person)
                save_persons(persons)
                row_success += 1

                # 人脸下发
                if face_filename and face_filename in images:
                    img_bytes = images[face_filename]
                    tmp_path = os.path.join(BASE, f"_batch_{user_id}.jpg")
                    with open(tmp_path, 'wb') as f_img:
                        f_img.write(img_bytes)
                    try:
                        manager.get(dev).add_face(user_id, tmp_path)
                        for p in persons:
                            if p["user_id"] == user_id:
                                p["has_face"] = True
                                break
                        save_persons(persons)
                        row_face_ok += 1
                    except:
                        row_face_fail += 1
                    finally:
                        if os.path.exists(tmp_path):
                            os.remove(tmp_path)
            except Exception as e:
                row_fail += 1
                error_messages.append(str(e))

        # 汇总该行结果
        status_text = "成功"
        if row_success == 0:
            status_text = "失败"
        elif row_fail > 0:
            status_text = "部分成功"

        face_text = "—"
        if face_filename:
            if row_face_ok == len(door_ids):
                face_text = "全部成功"
            elif row_face_ok > 0:
                face_text = f"部分成功({row_face_ok}/{len(door_ids)})"
            else:
                face_text = "失败"

        if row_success > 0:
            success += row_success
        if row_fail > 0:
            fail += row_fail
        face_success += row_face_ok
        face_fail += row_face_fail

        details.append({
            "user_id": user_id,
            "name": name,
            "doors": ", ".join(resolved_doors) if resolved_doors else "无",
            "status": status_text,
            "face_result": face_text,
            "error": "; ".join(error_messages) if error_messages else ""
        })

    msg = f"处理 {total} 条，成功添加 {success} 人"
    if face_success + face_fail > 0:
        msg += f"，人脸下发 {face_success} 成功 / {face_fail} 失败"
    return ok({
        "total": total,
        "success": success,
        "fail": fail,
        "face_success": face_success,
        "face_fail": face_fail,
        "msg": msg,
        "details": details
    })
    
# 从指定设备移除人员关联（全局ID）
@app.route("/api/persons/<user_id>/devices/<int:device_id>", methods=["DELETE"])
def remove_person_from_device(user_id, device_id):
    persons = load_persons()
    for p in persons:
        if p["user_id"] == user_id:
            doors = p.get("doors", [])
            if device_id in doors:
                doors.remove(device_id)
                if not doors:
                    persons.remove(p)
                else:
                    p["doors"] = doors
                save_persons(persons)
                return ok({"removed_device": device_id, "remaining_doors": doors})
            else:
                return err("该人员未关联此设备", 404)
    return err("人员不存在", 404)

# ================= 设备操作（门禁/日志/人脸） =================
def extract_device():
    data = {}
    if request.is_json:
        data.update(request.get_json(silent=True) or {})
    if request.form:
        data.update(request.form.to_dict())
    if request.args:
        for k, v in request.args.items():
            if k not in data:
                data[k] = v
    ip = data.get("device_ip")
    username = data.get("username")
    password = data.get("password")
    if not ip or not username or not password:
        raise Exception("缺少 device_ip / username / password")
    return {
        "ip": ip,
        "port": int(data.get("device_port", 37777)),
        "username": username,
        "password": password,
    }

@app.route("/api/open", methods=["POST"])
def open_door():
    try:
        dev = extract_device()
        channel = int((request.get_json() or {}).get("channel", 0))
        manager.get(dev).open_door(channel)
        return ok({"channel": channel})
    except Exception as e:
        return err(e, 500)

@app.route("/api/user", methods=["POST"])
def add_user():
    try:
        dev = extract_device()
        data = request.get_json()
        manager.get(dev).add_user(data["user_id"], data["name"])
        return ok()
    except Exception as e:
        return err(e, 500)

@app.route("/api/user/<uid>", methods=["DELETE"])
def del_user(uid):
    try:
        dev = extract_device()
        manager.get(dev).delete_user(uid)
        return ok()
    except Exception as e:
        return err(e, 500)

@app.route("/api/device/user/id/<uid>", methods=["GET"])
def get_device_user_by_id(uid):
    try:
        dev = extract_device()
        user = manager.get(dev).get_user_by_id(uid)
        if user:
            return ok(user)
        return err("用户不存在", 404)
    except Exception as e:
        return err(str(e), 500)

@app.route("/api/device/users/search", methods=["GET"])
def search_device_users():
    try:
        dev = extract_device()
        keyword = request.args.get("keyword", "").strip()
        if not keyword:
            return err("缺少 keyword")
        users = manager.get(dev).search_users_by_name(keyword)
        return ok({"total": len(users), "items": users})
    except Exception as e:
        return err(str(e), 500)

@app.route("/api/device/users/all", methods=["GET"])
def get_all_device_users():
    try:
        dev = extract_device()
        page = int(request.args.get("page", 1))
        page_size = int(request.args.get("page_size", 20))
        if page < 1: page = 1
        if page_size <= 0: page_size = 10000  # 获取全部
        offset = (page - 1) * page_size
        total, users = manager.get(dev).get_users_paginated(offset, page_size)
        return ok({"total": total, "page": page, "page_size": page_size, "items": users})
    except Exception as e:
        return err(str(e), 500)

@app.route("/api/face/<uid>", methods=["POST"])
def add_face(uid):
    try:
        dev = extract_device()
        f = request.files["file"]
        path = os.path.join(BASE, f"_tmp_{uid}.jpg")
        f.save(path)
        manager.get(dev).add_face(uid, path)
        if os.path.exists(path):
            os.remove(path)
        return ok()
    except Exception as e:
        return err(e, 500)

@app.route("/api/face/<uid>", methods=["DELETE"])
def del_face(uid):
    try:
        dev = extract_device()
        manager.get(dev).delete_face(uid)
        return ok()
    except Exception as e:
        return err(e, 500)

@app.route("/api/log", methods=["GET"])
def log():
    try:
        dev = extract_device()
        start_str = request.args.get("start")
        end_str = request.args.get("end")
        if not start_str or not end_str:
            return err("缺少 start 或 end 参数")
        try:
            start = datetime.strptime(start_str, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            start = datetime.strptime(start_str, "%Y-%m-%d")
        try:
            end = datetime.strptime(end_str, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            end = datetime.strptime(end_str, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
        records = manager.get(dev).query_log(start, end)
        return ok({"total": len(records), "records": records})
    except Exception as e:
        return err(e, 500)

@app.route("/api/health", methods=["GET"])
def health():
    return ok({"status": "running", "time": datetime.now().isoformat()})

def check_device_online(ip, port, timeout=2):
    try:
        sock = socket.create_connection((ip, port), timeout=timeout)
        sock.close()
        return True
    except Exception:
        return False

@app.route("/download/template")
def download_template():
    template_path = os.path.join(BASE, "user.xlsx")
    if not os.path.exists(template_path):
        return err("模板文件不存在", 404)
    return send_from_directory(
        BASE, "user.xlsx",
        as_attachment=True,
        download_name="user.xlsx"
    )
    
# ================= 静态文件 =================
@app.route("/")
@app.route("/<path:filename>")
def static_files(filename="access_control.html"):
    return send_from_directory(BASE, filename)

# ================= 清理线程 =================
def cleaner():
    while True:
        time.sleep(60)
        manager.cleanup()

threading.Thread(target=cleaner, daemon=True).start()

# ================= 启动 =================
if __name__ == "__main__":
    if not os.path.exists(DATA_ROOT):
        os.makedirs(DATA_ROOT, exist_ok=True)
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=15001)
    args = parser.parse_args()
    app.run("0.0.0.0", args.port)